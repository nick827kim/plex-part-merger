const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const os = require("os");
const { spawn } = require("child_process");

let mainWindow;

function getFfmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;

  try {
    return require("ffmpeg-static") || "ffmpeg";
  } catch {
    return "ffmpeg";
  }
}

function concatFileLine(filePath) {
  return `file '${filePath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}

function uniqueDefaultPath(filePath) {
  return filePath;
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
  ffmpegPath: getFfmpegPath()
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
