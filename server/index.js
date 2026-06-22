import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCaptionCsv,
  buildCaptionJsonl,
  buildDatasetReadme,
  buildKohyaDatasetGuide,
  buildKohyaDatasetToml,
  buildMetadata,
  buildTrainingNotes,
  captionedItems,
  getDatasetLayout
} from "./lib/dataset.js";
import {
  captionImage,
  cleanCaptionContent,
  ensureCaptionPrefix,
  hasCaptionDetails,
  listModels,
  normalizeCaptionSettings
} from "./lib/lmstudio.js";
import { parseMultipart, readJson } from "./lib/multipart.js";
import {
  clampNumber,
  contentTypeFor,
  httpError,
  imageMimeFromName,
  isSupportedImageMime,
  makeUniqueTrainingName,
  publicJobSettings,
  safeRelativePath,
  sanitizeFolderName,
  sendJson,
  sendText,
  toHumanError
} from "./lib/utils.js";
import { ZipBuilder } from "./lib/zip.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = path.join(ROOT_DIR, ".captioner");
const JOBS_DIR = path.join(DATA_DIR, "jobs");
const PORT = Number(process.env.PORT || 5177);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_UPLOAD_MB = clampNumber(process.env.MAX_UPLOAD_MB, 1, 5000, 800);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const MAX_FILES = Math.round(clampNumber(process.env.MAX_FILES, 1, 10000, 500));
const FINAL_JOB_STATUSES = new Set(["completed", "completed_with_errors", "failed", "cancelled"]);
const jobs = new Map();
const pendingJobIds = [];
let activeJobId = "";
let queueRunning = false;

await fs.mkdir(JOBS_DIR, { recursive: true });
await loadPersistedJobs();

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => handleError(error, res));
});

server.headersTimeout = 15_000;

server.listen(PORT, HOST, () => {
  console.log(`Captioner is running at http://${HOST}:${PORT}`);
  console.log(`Upload limit: ${MAX_UPLOAD_MB} MB`);
  console.log(`File limit: ${MAX_FILES}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Start with PORT=another_number npm start.`);
    process.exitCode = 1;
    return;
  }

  throw error;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    shutdown(signal).catch((error) => {
      console.error(error);
      process.exit(1);
    });
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await serveStatic(req, res, url);
    return;
  }

  throw httpError(405, "Method not allowed");
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      port: PORT,
      maxUploadMb: MAX_UPLOAD_MB,
      maxFiles: MAX_FILES,
      defaultBaseUrl: process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:1234/v1"
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/models") {
    const payload = await readJson(req);
    const settings = normalizeCaptionSettings({
      baseUrl: payload.baseUrl || process.env.LMSTUDIO_BASE_URL,
      apiKey: payload.apiKey || process.env.LMSTUDIO_API_KEY
    });
    const models = await listModels(settings);
    sendJson(res, 200, {
      ok: true,
      baseUrl: settings.baseUrl,
      models
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/jobs") {
    await createJob(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/jobs") {
    sendJson(res, 200, {
      ok: true,
      jobs: listRecentJobs()
    });
    return;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "jobs" || !parts[2]) {
    throw httpError(404, "API route not found");
  }

  const jobId = parts[2];
  const job = getJob(jobId);

  if (req.method === "GET" && parts.length === 3) {
    sendJson(res, 200, snapshotJob(job));
    return;
  }

  if (req.method === "GET" && parts[3] === "images" && parts[4]) {
    await serveJobImage(req, res, job, parts[4]);
    return;
  }

  if (req.method === "GET" && parts[3] === "download") {
    await serveArchive(req, res, job);
    return;
  }

  if (req.method === "POST" && parts[3] === "cancel") {
    await cancelJob(job);
    sendJson(res, 200, snapshotJob(job));
    return;
  }

  if (req.method === "PATCH" && parts[3] === "captions") {
    await updateCaptions(req, res, job);
    return;
  }

  if (req.method === "DELETE" && parts.length === 3) {
    if (!FINAL_JOB_STATUSES.has(job.status)) {
      throw httpError(409, "Cancel or finish the job before deleting it");
    }

    jobs.delete(jobId);
    await fs.rm(job.paths.jobDir, { recursive: true, force: true });
    sendJson(res, 200, { ok: true });
    return;
  }

  throw httpError(404, "API route not found");
}

async function createJob(req, res) {
  const parts = await parseMultipart(req, MAX_UPLOAD_BYTES);
  const settingsPart = parts.find((part) => part.name === "settings");
  const rawSettings = parseSettingsPart(settingsPart);
  const settings = normalizeCaptionSettings({
    ...rawSettings,
    baseUrl: rawSettings.baseUrl || process.env.LMSTUDIO_BASE_URL,
    apiKey: rawSettings.apiKey || process.env.LMSTUDIO_API_KEY
  });

  if (!settings.model) {
    throw httpError(400, "Select an LM Studio model before starting the job");
  }

  const fileParts = parts.filter(
    (part) => (part.name === "images" || part.name === "files") && part.filename && part.data.length
  );

  if (fileParts.length === 0) {
    throw httpError(400, "Upload at least one image");
  }

  if (fileParts.length > MAX_FILES) {
    throw httpError(413, `Too many files. Limit is ${MAX_FILES} images per job`);
  }

  const jobId = crypto.randomUUID();
  const jobDir = path.join(JOBS_DIR, jobId);
  const sourceDir = path.join(jobDir, "source");
  const captionsDir = path.join(jobDir, "captions");
  const archivePath = path.join(jobDir, "lora-dataset.zip");
  const now = new Date().toISOString();
  const usedNames = new Set();
  const items = [];

  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(captionsDir, { recursive: true });

  for (const [index, part] of fileParts.entries()) {
    const mime = (part.contentType || imageMimeFromName(part.filename)).split(";")[0].toLowerCase();

    if (!isSupportedImageMime(mime)) {
      throw httpError(415, `Unsupported image type for ${part.filename || "uploaded file"}`);
    }

    const storedName = makeUniqueTrainingName(index, part.filename, mime, usedNames);
    const filePath = path.join(sourceDir, storedName);
    await fs.writeFile(filePath, part.data);

    items.push({
      id: crypto.randomUUID(),
      originalName: part.filename,
      storedName,
      mime,
      size: part.data.length,
      status: "queued",
      caption: "",
      error: "",
      filePath,
      captionPath: path.join(captionsDir, `${path.basename(storedName, path.extname(storedName))}.txt`),
      createdAt: now,
      updatedAt: now
    });
  }

  const job = {
    id: jobId,
    status: "queued",
    error: "",
    createdAt: now,
    updatedAt: now,
    startedAt: "",
    finishedAt: "",
    total: items.length,
    processed: 0,
    failed: 0,
    archiveReady: false,
    cancelRequested: false,
    settings,
    items,
    paths: {
      jobDir,
      sourceDir,
      captionsDir,
      archivePath
    }
  };

  jobs.set(jobId, job);
  await persistJob(job);
  enqueueJob(job);

  sendJson(res, 202, snapshotJob(job));
}

async function processJob(job) {
  job.abortController = new AbortController();
  job.status = "running";
  job.startedAt = new Date().toISOString();
  job.updatedAt = job.startedAt;
  job.error = "";
  await persistJob(job);

  for (const item of job.items) {
    if (job.cancelRequested) {
      markQueuedItemCancelled(item);
      job.processed += 1;
      continue;
    }

    item.status = "processing";
    item.startedAt = new Date().toISOString();
    item.updatedAt = item.startedAt;
    job.updatedAt = item.updatedAt;
    await persistJob(job);

    try {
      const caption = await captionImageWithRetry(job, item);

      item.caption = caption;
      item.status = "done";
      item.finishedAt = new Date().toISOString();
      item.updatedAt = item.finishedAt;
      await fs.writeFile(item.captionPath, `${caption}\n`, "utf8");
    } catch (error) {
      item.status = job.cancelRequested ? "cancelled" : "error";
      item.error = job.cancelRequested ? "Cancelled by user" : toHumanError(error);
      item.finishedAt = new Date().toISOString();
      item.updatedAt = item.finishedAt;
      if (!job.cancelRequested) job.failed += 1;
    } finally {
      job.processed += 1;
      job.updatedAt = new Date().toISOString();
      await persistJob(job);
    }

    if (job.cancelRequested) {
      for (const pendingItem of job.items.filter((candidate) => candidate.status === "queued")) {
        markQueuedItemCancelled(pendingItem);
        job.processed += 1;
      }
      break;
    }
  }

  const completed = job.items.filter((item) => item.status === "done").length;
  if (completed > 0 && !job.cancelRequested) {
    await buildArchive(job);
    job.archiveReady = true;
  }

  job.finishedAt = new Date().toISOString();
  job.updatedAt = job.finishedAt;
  job.status = job.cancelRequested
    ? "cancelled"
    : completed === 0
      ? "failed"
      : job.failed > 0
        ? "completed_with_errors"
        : "completed";
  if (job.status === "failed" && !job.error) {
    job.error = firstItemError(job) || "LM Studio did not return captions for this job";
  }
  job.abortController = null;
  await persistJob(job);
}

async function buildArchive(job) {
  const zip = new ZipBuilder();
  const layout = getDatasetLayout(job.settings);
  const now = new Date();

  zip.addFile(`${layout.rootName}/README.txt`, buildDatasetReadme(job, layout), now);
  zip.addFile(`${layout.rootName}/training-notes.txt`, buildTrainingNotes(job, layout), now);
  zip.addFile(`${layout.rootName}/kohya_ss_dataset_guide.md`, buildKohyaDatasetGuide(job, layout), now);
  zip.addFile(`${layout.rootName}/dataset.toml`, buildKohyaDatasetToml(job, layout), now);
  zip.addFile(`${layout.rootName}/captions.csv`, buildCaptionCsv(job, layout), now);
  zip.addFile(`${layout.rootName}/captions.jsonl`, buildCaptionJsonl(job, layout), now);

  for (const item of job.items) {
    if (item.status !== "done") continue;

    const imageBuffer = await fs.readFile(item.filePath);
    const ext = path.extname(item.storedName);
    const baseName = path.basename(item.storedName, ext);
    zip.addFile(`${layout.trainingPath}/${item.storedName}`, imageBuffer, new Date(item.updatedAt));
    zip.addFile(`${layout.trainingPath}/${baseName}.txt`, `${item.caption}\n`, now);
  }

  zip.addFile(`${layout.rootName}/metadata.json`, buildMetadata(job, layout), now);

  await fs.writeFile(job.paths.archivePath, zip.finalize());
}

async function updateCaptions(req, res, job) {
  if (!job.archiveReady && !["completed", "completed_with_errors"].includes(job.status)) {
    throw httpError(409, "Captions can be edited after the first archive is ready");
  }

  const payload = await readJson(req, 5 * 1024 * 1024);
  const captionEdits = normalizeCaptionEdits(payload.captions);
  const editableIds = new Set(captionedItems(job).map((item) => item.id));
  const now = new Date().toISOString();
  let changed = 0;

  for (const edit of captionEdits) {
    if (!editableIds.has(edit.id)) continue;

    const item = job.items.find((candidate) => candidate.id === edit.id);
    const caption = ensureCaptionPrefix(cleanCaptionContent(edit.caption), job.settings);

    if (!caption) {
      throw httpError(400, `Caption for ${item.originalName} is empty`);
    }

    if (!hasCaptionDetails(caption, job.settings)) {
      throw httpError(400, `Caption for ${item.originalName} must include descriptive tags after the trigger phrase`);
    }

    if (caption === item.caption) continue;

    item.caption = caption;
    item.editedAt = now;
    item.updatedAt = now;
    await fs.writeFile(item.captionPath, `${caption}\n`, "utf8");
    changed += 1;
  }

  if (changed === 0) {
    sendJson(res, 200, { ...snapshotJob(job), changed });
    return;
  }

  job.archiveReady = false;
  job.updatedAt = now;
  await buildArchive(job);
  job.archiveReady = true;
  await persistJob(job);

  sendJson(res, 200, { ...snapshotJob(job), changed });
}

function snapshotJob(job) {
  return {
    id: job.id,
    status: job.status,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    total: job.total,
    processed: job.processed,
    failed: job.failed,
    archiveReady: job.archiveReady,
    cancelRequested: Boolean(job.cancelRequested),
    downloadUrl: job.archiveReady ? `/api/jobs/${job.id}/download` : "",
    settings: publicJobSettings(job.settings),
    dataset: getDatasetLayout(job.settings),
    items: job.items.map((item) => ({
      id: item.id,
      originalName: item.originalName,
      storedName: item.storedName,
      mime: item.mime,
      size: item.size,
      status: item.status,
      caption: item.caption,
      error: item.error,
      attempts: item.attempts || 0,
      createdAt: item.createdAt,
      startedAt: item.startedAt || "",
      finishedAt: item.finishedAt || "",
      editedAt: item.editedAt || "",
      updatedAt: item.updatedAt,
      previewUrl: `/api/jobs/${job.id}/images/${item.id}`
    }))
  };
}

function listRecentJobs() {
  return [...jobs.values()]
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, 12)
    .map((job) => ({
      id: job.id,
      status: job.status,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
      total: job.total,
      processed: job.processed,
      failed: job.failed,
      archiveReady: job.archiveReady,
      downloadUrl: job.archiveReady ? `/api/jobs/${job.id}/download` : "",
      dataset: getDatasetLayout(job.settings),
      settings: publicJobSettings(job.settings)
    }));
}

async function serveJobImage(req, res, job, itemId) {
  const item = job.items.find((candidate) => candidate.id === itemId);
  if (!item) throw httpError(404, "Image not found");

  await fs.stat(safeRelativePath(job.paths.sourceDir, item.filePath));
  res.writeHead(200, {
    "content-type": item.mime,
    "cache-control": "private, max-age=3600"
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  createReadStream(item.filePath).pipe(res);
}

async function serveArchive(req, res, job) {
  if (!job.archiveReady) {
    throw httpError(409, "Archive is not ready yet");
  }

  const stat = await fs.stat(job.paths.archivePath);
  res.writeHead(200, {
    "content-type": "application/zip",
    "content-length": stat.size,
    "content-disposition": `attachment; filename="${sanitizeFolderName(job.settings.folderName)}-${job.id.slice(0, 8)}.zip"`,
    "cache-control": "no-store"
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  createReadStream(job.paths.archivePath).pipe(res);
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const filePath = safeRelativePath(PUBLIC_DIR, path.join(PUBLIC_DIR, pathname));
  const stat = await fs.stat(filePath).catch(() => null);

  if (!stat?.isFile()) {
    sendText(res, 404, "Not found");
    return;
  }

  res.writeHead(200, {
    "content-type": contentTypeFor(filePath),
    "content-length": stat.size,
    "cache-control": "no-store"
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  createReadStream(filePath).pipe(res);
}

function parseSettingsPart(part) {
  if (!part) return {};

  try {
    return JSON.parse(part.data.toString("utf8"));
  } catch {
    throw httpError(400, "Settings form field must be valid JSON");
  }
}

function getJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) throw httpError(404, "Job not found");
  return job;
}

function enqueueJob(job) {
  if (FINAL_JOB_STATUSES.has(job.status)) return;
  if (pendingJobIds.includes(job.id) || activeJobId === job.id) return;

  pendingJobIds.push(job.id);
  processQueue().catch((error) => {
    console.error(error);
  });
}

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;

  try {
    while (pendingJobIds.length > 0) {
      const jobId = pendingJobIds.shift();
      const job = jobs.get(jobId);
      if (!job || FINAL_JOB_STATUSES.has(job.status) || job.cancelRequested) continue;

      activeJobId = jobId;
      try {
        await processJob(job);
      } catch (error) {
        job.status = job.cancelRequested ? "cancelled" : "failed";
        job.error = job.cancelRequested ? "Cancelled by user" : toHumanError(error);
        job.finishedAt = new Date().toISOString();
        job.updatedAt = job.finishedAt;
        job.abortController = null;
        await persistJob(job);
      } finally {
        activeJobId = "";
      }
    }
  } finally {
    queueRunning = false;
  }
}

async function captionImageWithRetry(job, item) {
  const retryCount = job.settings.retryCount || 0;
  let lastError;

  for (let attempt = 1; attempt <= retryCount + 1; attempt += 1) {
    if (job.cancelRequested) {
      throw httpError(499, "Cancelled by user");
    }

    item.attempts = attempt;
    item.error = attempt > 1 ? `Retry ${attempt - 1} of ${retryCount}` : "";
    item.updatedAt = new Date().toISOString();
    await persistJob(job);

    try {
      return await captionImage({
        imagePath: item.filePath,
        mime: item.mime,
        settings: job.settings,
        signal: job.abortController?.signal
      });
    } catch (error) {
      lastError = error;
      if (job.cancelRequested || attempt > retryCount) break;
      await sleep(Math.min(1000 * attempt, 3000));
    }
  }

  throw lastError;
}

async function cancelJob(job) {
  if (FINAL_JOB_STATUSES.has(job.status)) return;

  job.cancelRequested = true;
  job.archiveReady = false;
  job.updatedAt = new Date().toISOString();
  job.error = "Cancelled by user";

  const pendingIndex = pendingJobIds.indexOf(job.id);
  if (pendingIndex !== -1) {
    pendingJobIds.splice(pendingIndex, 1);
    for (const item of job.items.filter((candidate) => candidate.status === "queued")) {
      markQueuedItemCancelled(item);
      job.processed += 1;
    }
    job.status = "cancelled";
    job.finishedAt = new Date().toISOString();
  }

  if (activeJobId === job.id) {
    job.abortController?.abort();
  }

  await persistJob(job);
}

function markQueuedItemCancelled(item) {
  item.status = "cancelled";
  item.error = "Cancelled by user";
  item.finishedAt = new Date().toISOString();
  item.updatedAt = item.finishedAt;
}

function firstItemError(job) {
  return job.items.find((item) => item.error)?.error || "";
}

async function loadPersistedJobs() {
  const entries = await fs.readdir(JOBS_DIR, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const jobDir = path.join(JOBS_DIR, entry.name);
    const metadataPath = path.join(jobDir, "job.json");
    const raw = await fs.readFile(metadataPath, "utf8").catch(() => "");
    if (!raw) continue;

    try {
      const job = hydrateJob(JSON.parse(raw), jobDir);
      await recoverInterruptedJob(job);
      jobs.set(job.id, job);
    } catch (error) {
      console.warn(`Could not recover job ${entry.name}: ${toHumanError(error)}`);
    }
  }
}

function hydrateJob(data, jobDir) {
  const sourceDir = path.join(jobDir, "source");
  const captionsDir = path.join(jobDir, "captions");

  const job = {
    id: String(data.id || path.basename(jobDir)),
    status: String(data.status || "failed"),
    error: String(data.error || ""),
    createdAt: String(data.createdAt || new Date().toISOString()),
    updatedAt: String(data.updatedAt || new Date().toISOString()),
    startedAt: String(data.startedAt || ""),
    finishedAt: String(data.finishedAt || ""),
    total: Number(data.total || data.items?.length || 0),
    processed: Number(data.processed || 0),
    failed: Number(data.failed || 0),
    archiveReady: Boolean(data.archiveReady),
    cancelRequested: Boolean(data.cancelRequested),
    settings: normalizeCaptionSettings(data.settings || {}),
    items: Array.isArray(data.items) ? data.items : [],
    paths: {
      jobDir,
      sourceDir,
      captionsDir,
      archivePath: path.join(jobDir, "lora-dataset.zip"),
      metadataPath: path.join(jobDir, "job.json")
    },
    abortController: null
  };

  job.items = job.items.map((item) => {
    const storedName = String(item.storedName || "");
    return {
      id: String(item.id || crypto.randomUUID()),
      originalName: String(item.originalName || storedName || "image"),
      storedName,
      mime: String(item.mime || imageMimeFromName(storedName) || "image/jpeg"),
      size: Number(item.size || 0),
      status: String(item.status || "error"),
      caption: String(item.caption || ""),
      error: String(item.error || ""),
      attempts: Number(item.attempts || 0),
      createdAt: String(item.createdAt || job.createdAt),
      startedAt: String(item.startedAt || ""),
      finishedAt: String(item.finishedAt || ""),
      editedAt: String(item.editedAt || ""),
      updatedAt: String(item.updatedAt || job.updatedAt),
      filePath: path.join(sourceDir, storedName),
      captionPath: path.join(captionsDir, `${path.basename(storedName, path.extname(storedName))}.txt`)
    };
  });

  return job;
}

async function recoverInterruptedJob(job) {
  if (FINAL_JOB_STATUSES.has(job.status)) {
    if (job.archiveReady) {
      job.archiveReady = Boolean(await fs.stat(job.paths.archivePath).catch(() => null));
    }
    return;
  }

  const now = new Date().toISOString();
  let interrupted = 0;
  for (const item of job.items) {
    if (["queued", "processing"].includes(item.status)) {
      item.status = "error";
      item.error = "Server restarted before this image finished. Start a new job for this image.";
      item.finishedAt = now;
      item.updatedAt = now;
      interrupted += 1;
    }
  }

  job.failed = job.items.filter((item) => item.status === "error").length;
  job.processed = job.items.filter((item) => ["done", "error", "cancelled"].includes(item.status)).length;
  job.error = interrupted ? "Server restarted before this job finished" : job.error;
  job.finishedAt = now;
  job.updatedAt = now;
  job.cancelRequested = false;

  const completed = job.items.filter((item) => item.status === "done").length;
  if (completed > 0) {
    await buildArchive(job);
    job.archiveReady = true;
    job.status = "completed_with_errors";
  } else {
    job.archiveReady = false;
    job.status = "failed";
  }

  await persistJob(job);
}

async function persistJob(job) {
  const metadataPath = path.join(job.paths.jobDir, "job.json");
  const tempPath = `${metadataPath}.tmp`;
  await fs.mkdir(job.paths.jobDir, { recursive: true });
  await fs.writeFile(tempPath, `${JSON.stringify(serializeJob(job), null, 2)}\n`, "utf8");
  await fs.rename(tempPath, metadataPath);
}

function serializeJob(job) {
  return {
    id: job.id,
    status: job.status,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    total: job.total,
    processed: job.processed,
    failed: job.failed,
    archiveReady: job.archiveReady,
    cancelRequested: Boolean(job.cancelRequested),
    settings: publicJobSettings(job.settings),
    items: job.items.map((item) => ({
      id: item.id,
      originalName: item.originalName,
      storedName: item.storedName,
      mime: item.mime,
      size: item.size,
      status: item.status,
      caption: item.caption,
      error: item.error,
      attempts: item.attempts || 0,
      createdAt: item.createdAt,
      startedAt: item.startedAt || "",
      finishedAt: item.finishedAt || "",
      editedAt: item.editedAt || "",
      updatedAt: item.updatedAt
    }))
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  for (const job of jobs.values()) {
    if (!FINAL_JOB_STATUSES.has(job.status)) {
      job.cancelRequested = true;
      job.abortController?.abort();
      job.updatedAt = new Date().toISOString();
      await persistJob(job);
    }
  }

  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

function normalizeCaptionEdits(captions) {
  if (Array.isArray(captions)) {
    return captions
      .map((edit) => ({
        id: String(edit?.id || ""),
        caption: String(edit?.caption || "")
      }))
      .filter((edit) => edit.id);
  }

  if (captions && typeof captions === "object") {
    return Object.entries(captions).map(([id, caption]) => ({
      id,
      caption: String(caption || "")
    }));
  }

  throw httpError(400, "Request must include captions");
}

function handleError(error, res) {
  if (res.headersSent) {
    res.destroy(error);
    return;
  }

  const statusCode = error.statusCode || 500;
  const knownError = Boolean(error.statusCode);
  sendJson(res, statusCode, {
    ok: false,
    error: knownError ? error.message : "Internal server error",
    details: knownError ? error.details : undefined
  });

  if (!knownError) {
    console.error(error);
  } else if (statusCode >= 500) {
    console.warn(`${statusCode} ${error.message}`);
  }
}
