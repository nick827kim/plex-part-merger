const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const os = require("os");
const { spawn } = require("child_process");

let mainWindow;

function getFfmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;

  try {
    const ffmpegPath = require("ffmpeg-static");
    if (!ffmpegPath) return "ffmpeg";
    return ffmpegPath.replace("app.asar", "app.asar.unpacked");
  } catch {
    return "ffmpeg";
  }
}

function getFfprobePath() {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;

  try {
    const ffprobe = require("ffprobe-static");
    const ffprobePath = ffprobe.path || ffprobe;
    if (!ffprobePath) return "ffprobe";
    return ffprobePath.replace("app.asar", "app.asar.unpacked");
  } catch {
    return "ffprobe";
  }
}

function concatFileLine(filePath) {
  return `file '${filePath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}

function uniqueDefaultPath(filePath) {
  return filePath;
}

function runFfprobe(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-show_entries",
      "format=format_name,duration:stream=index,codec_type,codec_name,width,height,r_frame_rate,time_base,sample_rate,channels,channel_layout",
      "-of",
      "json",
      filePath
    ];
    const proc = spawn(getFfprobePath(), args, { windowsHide: true });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `ffprobe exited with code ${code}.`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function firstStream(probe, type) {
  return (probe.streams || []).find((stream) => stream.codec_type === type) || {};
}

function formatFamily(formatName) {
  const names = String(formatName || "").split(",");
  if (names.includes("matroska") || names.includes("webm")) return "matroska";
  if (names.includes("mov") || names.includes("mp4") || names.includes("m4a") || names.includes("3gp") || names.includes("3g2") || names.includes("mj2")) return "mp4";
  return names[0] || "unknown";
}

function compatibilitySignature(probe) {
  const video = firstStream(probe, "video");
  const audio = firstStream(probe, "audio");
  return {
    container: formatFamily(probe.format?.format_name),
    videoCodec: video.codec_name || "",
    width: video.width || 0,
    height: video.height || 0,
    frameRate: video.r_frame_rate || "",
    timeBase: video.time_base || "",
    audioCodec: audio.codec_name || "",
    sampleRate: audio.sample_rate || "",
    channels: audio.channels || 0,
    channelLayout: audio.channel_layout || ""
  };
}

function describeMismatch(key) {
  return {
    container: "container type",
    videoCodec: "video codec",
    width: "video width",
    height: "video height",
    frameRate: "frame rate",
    timeBase: "video time base",
    audioCodec: "audio codec",
    sampleRate: "audio sample rate",
    channels: "audio channel count",
    channelLayout: "audio channel layout"
  }[key] || key;
}

async function assertFastMergeCompatible(files) {
  const probes = [];
  for (const file of files) {
    const probe = await runFfprobe(file.path);
    probes.push({ file, signature: compatibilitySignature(probe) });
  }

  const reference = probes[0].signature;
  const mismatches = [];
  for (const item of probes.slice(1)) {
    for (const [key, value] of Object.entries(reference)) {
      if (String(item.signature[key]) !== String(value)) {
        mismatches.push(`${path.basename(item.file.path)} has a different ${describeMismatch(key)}.`);
      }
    }
  }

  if (mismatches.length) {
    throw new Error(
      [
        "These files are not safe for Fast Merge.",
        "Fast Merge works best when every part comes from the same source and has matching format settings.",
        ...mismatches.slice(0, 6),
        "For now, use files with matching type/settings, such as all MKV parts from the same release or all MP4 parts from the same source."
      ].join("\n")
    );
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 920,
    minHeight: 650,
    title: "Plex Part Merger",
    backgroundColor: "#f6f7f9",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "..", "public", "index.html"));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle("app:get-mode", async () => ({
  mode: "desktop",
  ffmpegPath: getFfmpegPath(),
  ffprobePath: getFfprobePath()
}));

ipcMain.handle("merge:choose-output", async (_event, payload) => {
  const defaultPath = uniqueDefaultPath(payload.defaultPath);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Save merged video",
    defaultPath,
    filters: [
      { name: "Video", extensions: ["mp4", "mkv", "m4v", "mov", "ts", "webm", "avi"] },
      { name: "All files", extensions: ["*"] }
    ]
  });

  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

ipcMain.handle("merge:start", async (event, payload) => {
  const files = Array.isArray(payload.files) ? payload.files : [];
  const output = String(payload.output || "").trim();

  if (files.length < 2) throw new Error("Choose at least two video files to merge.");
  if (!output) throw new Error("Choose where to save the merged video.");

  for (const file of files) {
    const stat = await fs.stat(file.path).catch(() => null);
    if (!stat || !stat.isFile()) throw new Error(`Missing input file: ${file.path}`);
  }

  event.sender.send("merge:progress", { message: "Checking file compatibility" });
  await assertFastMergeCompatible(files);

  await fs.mkdir(path.dirname(output), { recursive: true });

  const listPath = path.join(os.tmpdir(), `plex-part-merger-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  await fs.writeFile(listPath, files.map((file) => concatFileLine(file.path)).join(os.EOL), "utf8");

  const ext = path.extname(output).toLowerCase();
  const args = ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy"];
  if ([".mp4", ".m4v", ".mov"].includes(ext)) args.push("-movflags", "+faststart");
  args.push(output);

  return new Promise((resolve, reject) => {
    const proc = spawn(getFfmpegPath(), args, { windowsHide: true });
    let settled = false;

    const send = (data) => {
      const text = data.toString();
      event.sender.send("merge:log", text);

      const timeMatch = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (timeMatch) {
        event.sender.send("merge:progress", { message: `Combining videos at ${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3]}` });
      }
    };

    proc.stdout.on("data", send);
    proc.stderr.on("data", send);

    proc.on("error", async (error) => {
      if (settled) return;
      settled = true;
      await fs.unlink(listPath).catch(() => {});
      reject(error);
    });

    proc.on("close", async (code) => {
      if (settled) return;
      settled = true;
      await fs.unlink(listPath).catch(() => {});
      if (code === 0) resolve({ output });
      else reject(new Error(`ffmpeg exited with code ${code}.`));
    });
  });
});
