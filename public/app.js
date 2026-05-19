const FFMPEG_VERSION = "0.12.10";
const FFMPEG_BASE = "/vendor/ffmpeg";
const CORE_BASE = "/vendor/core";
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mkv", ".avi", ".mov", ".wmv", ".ts", ".m2ts", ".webm"]);

const state = {
  files: [],
  ffmpeg: null,
  ffmpegLoading: false,
  startedAt: null,
  draggedId: null,
  downloadUrl: null,
  isDesktop: Boolean(window.desktopAPI),
  mergeInProgress: false,
  progressHint: 0
};

const els = {
  engineStatus: document.querySelector("#engineStatus"),
  dropZone: document.querySelector("#dropZone"),
  fileInput: document.querySelector("#fileInput"),
  fileList: document.querySelector("#fileList"),
  outputName: document.querySelector("#outputName"),
  clearButton: document.querySelector("#clearButton"),
  mergeButton: document.querySelector("#mergeButton"),
  jobPanel: document.querySelector("#jobPanel"),
  resultPanel: document.querySelector("#resultPanel"),
  resultName: document.querySelector("#resultName"),
  downloadAgain: document.querySelector("#downloadAgain"),
  mergeOverlay: document.querySelector("#mergeOverlay"),
  overlayIcon: document.querySelector("#overlayIcon"),
  overlayClose: document.querySelector("#overlayClose"),
  overlayTitle: document.querySelector("#overlayTitle"),
  overlayMessage: document.querySelector("#overlayMessage"),
  overlayProgress: document.querySelector("#overlayProgress"),
  overlayDetail: document.querySelector("#overlayDetail"),
  jobState: document.querySelector("#jobState"),
  jobRuntime: document.querySelector("#jobRuntime"),
  jobLog: document.querySelector("#jobLog")
};

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function setStatus(message, kind) {
  els.engineStatus.textContent = message;
  els.engineStatus.className = `status-pill ${kind || ""}`.trim();
}

function appendLog(line) {
  els.jobLog.textContent += `${line}\n`;
  els.jobLog.scrollTop = els.jobLog.scrollHeight;
}

function setOverlay(status, percent, message, detail) {
  els.mergeOverlay.classList.remove("hidden");
  els.overlayClose.classList.add("hidden");
  els.overlayProgress.style.width = `${Math.max(8, Math.min(100, percent))}%`;
  els.overlayMessage.textContent = message;
  els.overlayDetail.textContent = detail || "";
  els.overlayIcon.className = "overlay-icon";
  els.overlayIcon.textContent = "";

  if (status === "done") {
    els.overlayTitle.textContent = "Completed";
    els.overlayIcon.classList.add("done-mark");
    els.overlayIcon.textContent = "OK";
    els.overlayProgress.style.width = "100%";
  } else if (status === "failed") {
    els.overlayTitle.textContent = "Failed";
    els.overlayIcon.classList.add("failed-mark");
    els.overlayIcon.textContent = "!";
    els.overlayProgress.style.width = "100%";
    els.overlayClose.classList.remove("hidden");
  } else {
    els.overlayTitle.textContent = "Merging videos";
    els.overlayIcon.classList.add("loading-mark");
  }
}

function hideOverlaySoon() {
  window.setTimeout(() => {
    els.mergeOverlay.classList.add("hidden");
  }, 1800);
}

function clearDownloadResult() {
  if (state.downloadUrl) {
    URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = null;
  }

  els.resultPanel.classList.add("hidden");
  els.resultName.textContent = "";
  els.downloadAgain.removeAttribute("href");
  els.downloadAgain.removeAttribute("download");
}

function basename(filePath) {
  const slash = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  return slash >= 0 ? filePath.slice(slash + 1) : filePath;
}

function dirname(filePath) {
  const slash = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  return slash >= 0 ? filePath.slice(0, slash) : "";
}

function fileExtension(fileName) {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot) : "";
}

function sanitizeFileName(name) {
  return name
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "");
}

function outputFileName() {
  const rawName = sanitizeFileName(els.outputName.value) || "Merged Video File";
  const ext = fileExtension(rawName) || fileExtension(state.files[0]?.file.name || "") || ".mp4";
  const base = fileExtension(rawName) ? rawName.slice(0, -fileExtension(rawName).length) : rawName;
  return `${base}${ext}`;
}

function desktopDefaultOutputPath() {
  const firstPath = state.files[0]?.path || "";
  const directory = dirname(firstPath);
  const name = outputFileName();
  return directory ? `${directory}\\${name}` : name;
}

function updateMergeButton() {
  els.mergeButton.disabled = state.files.length < 2 || !els.outputName.value.trim() || state.ffmpegLoading || state.mergeInProgress;
}

async function addFiles(fileList) {
  const videos = Array.from(fileList).filter((file) => file.type.startsWith("video/") || VIDEO_EXTENSIONS.has(fileExtension(file.name).toLowerCase()));
  const existingKeys = new Set(state.files.map((item) => item.path || `${item.file.name}-${item.file.size}-${item.file.lastModified}`));

  for (const file of videos) {
    const path = state.isDesktop ? window.desktopAPI.getPathForFile(file) : "";
    const key = path || `${file.name}-${file.size}-${file.lastModified}`;
    if (existingKeys.has(key)) return;
    existingKeys.add(key);
    state.files.push({
      id: crypto.randomUUID(),
      file,
      path
    });
  }

  state.files.sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true, sensitivity: "base" }));
  renderFiles();
}

function removeFile(id) {
  state.files = state.files.filter((item) => item.id !== id);
  renderFiles();
}

function moveFile(fromIndex, toIndex) {
  if (toIndex < 0 || toIndex >= state.files.length || fromIndex === toIndex) return;
  const [item] = state.files.splice(fromIndex, 1);
  state.files.splice(toIndex, 0, item);
  renderFiles();
}

function indexForId(id) {
  return state.files.findIndex((item) => item.id === id);
}

function renderFiles() {
  if (!state.files.length) {
    els.fileList.className = "file-grid empty-state";
    els.fileList.textContent = "Add at least two video files to begin.";
    updateMergeButton();
    return;
  }

  els.fileList.className = "file-grid";
  els.fileList.innerHTML = "";

  state.files.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "file-row";
    row.draggable = true;
    row.dataset.id = item.id;

    row.addEventListener("dragstart", () => {
      state.draggedId = item.id;
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      state.draggedId = null;
      row.classList.remove("dragging");
    });
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      const from = indexForId(state.draggedId);
      const to = indexForId(item.id);
      if (from >= 0 && to >= 0 && from !== to) moveFile(from, to);
    });

    const order = document.createElement("div");
    order.className = "order-cell drag-handle";
    order.title = "Drag to reorder";
    order.innerHTML = `<span>${index + 1}</span><b class="grip-dots" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></b>`;

    const name = document.createElement("div");
    name.className = "filename-cell";
    name.textContent = item.file.name;
    name.title = item.file.name;

    const size = document.createElement("div");
    size.className = "muted-cell";
    size.textContent = formatBytes(item.file.size);

    const type = document.createElement("div");
    type.className = "type-cell";
    type.textContent = item.file.type || fileExtension(item.file.name).slice(1).toUpperCase() || "video";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => removeFile(item.id));

    row.append(order, name, size, type, remove);
    els.fileList.append(row);
  });

  updateMergeButton();
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener("load", resolve, { once: true });
      resolve();
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(script);
  });
}

async function toBlobURL(url, mimeType) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load ${url}`);
  }

  const data = await response.arrayBuffer();
  return URL.createObjectURL(new Blob([data], { type: mimeType }));
}

async function getFfmpeg() {
  if (state.ffmpeg) return state.ffmpeg;
  if (state.ffmpegLoading) throw new Error("The merge engine is already loading.");

  state.ffmpegLoading = true;
  updateMergeButton();
  setStatus("Loading engine", "");
  appendLog("Loading the browser merge engine. The first load can take a bit.");

  await loadScript(`${FFMPEG_BASE}/ffmpeg.js?v=${FFMPEG_VERSION}`);

  const { FFmpeg } = window.FFmpegWASM;
  const ffmpeg = new FFmpeg();

  ffmpeg.on("log", ({ message }) => {
    if (message) appendLog(message);
  });
  ffmpeg.on("progress", ({ progress }) => {
    const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));
    els.jobState.textContent = `Merging ${percent}%`;
    setOverlay("loading", percent, "Combining the videos.", `${state.files.length} files in order`);
  });

  await ffmpeg.load({
    coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
  });

  state.ffmpeg = ffmpeg;
  state.ffmpegLoading = false;
  setStatus("Ready", "good");
  updateMergeButton();
  return ffmpeg;
}

async function mergeAndDownload() {
  els.jobPanel.classList.remove("hidden");
  els.jobLog.textContent = "";
  clearDownloadResult();
  els.jobState.textContent = "Preparing";
  els.jobRuntime.textContent = "";
  state.startedAt = Date.now();
  setOverlay("loading", 8, "Preparing your files.", `${state.files.length} files selected`);
  updateRuntime();

  if (state.isDesktop) {
    await mergeWithDesktopFfmpeg();
    return;
  }

  try {
    const ffmpeg = await getFfmpeg();
    const output = outputFileName();
    const inputNames = state.files.map((item, index) => `input-${String(index + 1).padStart(3, "0")}${fileExtension(item.file.name) || ".mp4"}`);

    appendLog(`Writing ${state.files.length} files into browser memory.`);
    setOverlay("loading", 18, "Loading files into memory.", "This stays local in your browser.");
    for (let index = 0; index < state.files.length; index += 1) {
      const buffer = new Uint8Array(await state.files[index].file.arrayBuffer());
      await ffmpeg.writeFile(inputNames[index], buffer);
      const percent = 18 + Math.round(((index + 1) / state.files.length) * 22);
      setOverlay("loading", percent, "Loading files into memory.", `${index + 1} of ${state.files.length}`);
    }

    const concatList = inputNames.map((name) => `file '${name.replace(/'/g, "'\\''")}'`).join("\n");
    await ffmpeg.writeFile("inputs.txt", concatList);

    appendLog("Merging without re-encoding.");
    setOverlay("loading", 44, "Combining the videos.", "Keeping original quality.");
    await ffmpeg.exec(["-f", "concat", "-safe", "0", "-i", "inputs.txt", "-c", "copy", output]);

    setOverlay("loading", 92, "Preparing download.", output);
    const data = await ffmpeg.readFile(output);
    const blob = new Blob([data], { type: state.files[0]?.file.type || "video/mp4" });
    const url = URL.createObjectURL(blob);
    state.downloadUrl = url;

    els.resultName.textContent = output;
    els.downloadAgain.href = url;
    els.downloadAgain.download = output;
    els.resultPanel.classList.remove("hidden");

    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = output;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();

    appendLog(`Downloaded ${output}.`);
    els.jobState.textContent = "Done";
    setOverlay("done", 100, `${output} is ready.`, "Your download should start automatically.");
    hideOverlaySoon();

    await Promise.all([...inputNames, "inputs.txt", output].map((name) => ffmpeg.deleteFile(name).catch(() => {})));
  } catch (error) {
    els.jobState.textContent = "Failed";
    appendLog(error.message);
    appendLog("If these files do not fast-merge, they may need the server-side/re-encode path later.");
    setOverlay("failed", 100, "The merge did not finish.", error.message);
  } finally {
    state.ffmpegLoading = false;
    updateMergeButton();
    updateRuntime();
  }
}

async function mergeWithDesktopFfmpeg() {
  state.mergeInProgress = true;
  state.progressHint = 12;
  updateMergeButton();

  const outputName = outputFileName();
  const defaultPath = desktopDefaultOutputPath();

  try {
    const output = await window.desktopAPI.chooseOutput({ defaultPath, outputName });
    if (!output) {
      state.mergeInProgress = false;
      els.mergeOverlay.classList.add("hidden");
      updateMergeButton();
      return;
    }

    setOverlay("loading", 14, "Starting native merge.", "Using local ffmpeg for speed.");
    appendLog(`Saving to ${output}`);

    const removeLog = window.desktopAPI.onMergeLog((message) => {
      appendLog(message.trimEnd());
    });
    const removeProgress = window.desktopAPI.onMergeProgress((progress) => {
      state.progressHint = Math.min(92, state.progressHint + 3);
      setOverlay("loading", state.progressHint, progress.message || "Combining videos.", `${state.files.length} files in order`);
    });

    const result = await window.desktopAPI.merge({
      files: state.files.map((item) => ({ name: item.file.name, path: item.path })),
      output
    });

    removeLog();
    removeProgress();

    els.resultName.textContent = `Saved: ${result.output}`;
    els.downloadAgain.textContent = "Saved locally";
    els.downloadAgain.removeAttribute("href");
    els.downloadAgain.removeAttribute("download");
    els.resultPanel.classList.remove("hidden");

    appendLog(`Saved ${result.output}.`);
    els.jobState.textContent = "Done";
    setOverlay("done", 100, `${basename(result.output)} is ready.`, "Saved to your selected location.");
    hideOverlaySoon();
  } catch (error) {
    els.jobState.textContent = "Failed";
    appendLog(error.message);
    setOverlay("failed", 100, "The merge did not finish.", error.message);
  } finally {
    state.mergeInProgress = false;
    updateMergeButton();
    updateRuntime();
  }
}

function updateRuntime() {
  if (!state.startedAt) return;
  const seconds = Math.max(0, Math.round((Date.now() - state.startedAt) / 1000));
  els.jobRuntime.textContent = `${seconds}s`;
}

els.dropZone.addEventListener("click", () => els.fileInput.click());
els.dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  els.dropZone.classList.add("drag-over");
});
els.dropZone.addEventListener("dragleave", () => {
  els.dropZone.classList.remove("drag-over");
});
els.dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  els.dropZone.classList.remove("drag-over");
  addFiles(event.dataTransfer.files);
});
els.fileInput.addEventListener("change", () => {
  addFiles(els.fileInput.files);
  els.fileInput.value = "";
});
els.outputName.addEventListener("input", updateMergeButton);
els.clearButton.addEventListener("click", () => {
  clearDownloadResult();
  state.files = [];
  renderFiles();
});
els.mergeButton.addEventListener("click", mergeAndDownload);
els.overlayClose.addEventListener("click", () => {
  els.mergeOverlay.classList.add("hidden");
});
window.setInterval(updateRuntime, 1000);

if (state.isDesktop) {
  setStatus("Desktop merge", "good");
  els.mergeButton.textContent = "Merge and Save";
  window.desktopAPI.getMode().catch(() => {});
} else {
  setStatus("Browser merge", "good");
}
renderFiles();
