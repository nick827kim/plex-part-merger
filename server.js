const http = require("http");
const https = require("https");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 4127);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".m4v",
  ".mkv",
  ".avi",
  ".mov",
  ".wmv",
  ".ts",
  ".m2ts",
  ".webm"
]);

const jobs = new Map();
const vendorCache = new Map();

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type });
  res.end(text);
}

function contentTypeForVendor(filePath) {
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

function fetchVendorAsset(url) {
  if (vendorCache.has(url)) return vendorCache.get(url);

  const request = new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Could not load ${url} (${response.statusCode})`));
          return;
        }

        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });

  vendorCache.set(url, request);
  return request;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        req.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function getFfmpegPath() {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

function isVideoFile(filePath) {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function normalizeUserPath(input) {
  return String(input || "")
    .trim()
    .replace(/^"+|"+$/g, "");
}

function concatFileLine(filePath) {
  return `file '${filePath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}

function createSuggestedOutput(files) {
  if (!files.length) return "";
  const first = files[0];
  const dir = path.dirname(first.path);
  const ext = path.extname(first.name) || ".mkv";
  return path.join(dir, `Merged Video File${ext}`);
}

async function checkFfmpeg() {
  return new Promise((resolve) => {
    const proc = spawn(getFfmpegPath(), ["-version"], { windowsHide: true });
    let output = "";
    proc.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    proc.on("error", (error) => {
      resolve({ available: false, path: getFfmpegPath(), message: error.message });
    });
    proc.on("close", (code) => {
      const firstLine = output.split(/\r?\n/)[0] || "";
      resolve({ available: code === 0, path: getFfmpegPath(), message: firstLine });
    });
  });
}

async function listVideos(dirInput) {
  const dir = normalizeUserPath(dirInput);
  if (!dir) throw new Error("Enter a folder path.");

  const stat = await fsp.stat(dir);
  if (!stat.isDirectory()) throw new Error("That path is not a folder.");

  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const filePath = path.join(dir, entry.name);
        if (!isVideoFile(filePath)) return null;
        const info = await fsp.stat(filePath);
        return {
          name: entry.name,
          path: filePath,
          size: info.size,
          modified: info.mtimeMs
        };
      })
  );

  const videos = files
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

  return {
    dir,
    files: videos,
    suggestedOutput: createSuggestedOutput(videos)
  };
}

async function startMerge(payload) {
  const files = Array.isArray(payload.files) ? payload.files.map(normalizeUserPath).filter(Boolean) : [];
  const output = normalizeUserPath(payload.output);
  const mode = payload.mode === "reencode" ? "reencode" : "copy";

  if (files.length < 2) throw new Error("Choose at least two video files to merge.");
  if (!output) throw new Error("Enter an output file path.");

  for (const file of files) {
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat || !stat.isFile()) throw new Error(`Missing input file: ${file}`);
  }

  await fsp.mkdir(path.dirname(output), { recursive: true });
  const listPath = path.join(os.tmpdir(), `plex-merge-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  await fsp.writeFile(listPath, files.map(concatFileLine).join(os.EOL), "utf8");

  const ext = path.extname(output).toLowerCase();
  const args = ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", listPath];

  if (mode === "copy") {
    args.push("-c", "copy");
    if ([".mp4", ".m4v", ".mov"].includes(ext)) args.push("-movflags", "+faststart");
  } else {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "192k");
    if ([".mp4", ".m4v", ".mov"].includes(ext)) args.push("-movflags", "+faststart");
  }

  args.push(output);

  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const job = {
    id,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    files,
    output,
    mode,
    log: [],
    error: null,
    exitCode: null
  };
  jobs.set(id, job);

  const proc = spawn(getFfmpegPath(), args, { windowsHide: true });
  job.process = proc;

  const appendLog = (chunk) => {
    const text = chunk.toString();
    job.log.push(...text.split(/\r?\n/).filter(Boolean));
    if (job.log.length > 240) job.log.splice(0, job.log.length - 240);
  };

  proc.stdout.on("data", appendLog);
  proc.stderr.on("data", appendLog);
  proc.on("error", async (error) => {
    job.status = "failed";
    job.error = error.message;
    job.finishedAt = Date.now();
    await fsp.unlink(listPath).catch(() => {});
  });
  proc.on("close", async (code) => {
    if (job.status !== "failed") {
      job.status = code === 0 ? "done" : "failed";
      job.exitCode = code;
      if (code !== 0) job.error = `ffmpeg exited with code ${code}.`;
      job.finishedAt = Date.now();
    }
    await fsp.unlink(listPath).catch(() => {});
    delete job.process;
  });

  return job;
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/status") {
      return sendJson(res, 200, { ffmpeg: await checkFfmpeg() });
    }

    if (req.method === "GET" && url.pathname === "/api/list") {
      return sendJson(res, 200, await listVideos(url.searchParams.get("dir")));
    }

    if (req.method === "POST" && url.pathname === "/api/merge") {
      const payload = JSON.parse(await readBody(req) || "{}");
      const job = await startMerge(payload);
      return sendJson(res, 202, { id: job.id });
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (req.method === "GET" && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return sendJson(res, 404, { error: "Job not found." });
      const { process: _process, ...safeJob } = job;
      return sendJson(res, 200, safeJob);
    }

    if (req.method === "POST" && jobMatch && url.pathname.endsWith("/cancel")) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return sendJson(res, 404, { error: "Job not found." });
      if (job.process) job.process.kill("SIGTERM");
      job.status = "cancelled";
      job.finishedAt = Date.now();
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: "Unknown API route." });
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
}

async function serveVendor(req, res, url) {
  const match = url.pathname.match(/^\/vendor\/(ffmpeg|core)\/([A-Za-z0-9._-]+)$/);
  if (!match) return sendText(res, 404, "Not found");

  const packageName = match[1] === "ffmpeg" ? "@ffmpeg/ffmpeg" : "@ffmpeg/core";
  const fileName = match[2];
  const remoteUrl = `https://cdn.jsdelivr.net/npm/${packageName}@0.12.10/dist/umd/${fileName}`;

  try {
    const body = await fetchVendorAsset(remoteUrl);
    res.writeHead(200, {
      "content-type": contentTypeForVendor(fileName),
      "cache-control": "public, max-age=31536000, immutable",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp"
    });
    res.end(body);
  } catch (error) {
    sendText(res, 502, error.message);
  }
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC, requested));
  if (!filePath.startsWith(PUBLIC)) return sendText(res, 403, "Forbidden");

  try {
    const body = await fsp.readFile(filePath);
    res.writeHead(200, { "content-type": mimeFor(filePath) });
    res.end(body);
  } catch {
    sendText(res, 404, "Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
  if (url.pathname.startsWith("/vendor/")) return serveVendor(req, res, url);
  return serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log(`Plex Part Merger is running at http://localhost:${PORT}`);
});
