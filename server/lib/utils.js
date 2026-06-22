import path from "node:path";

export const DEFAULT_LMSTUDIO_BASE_URL = "http://127.0.0.1:1234/v1";

export const IMAGE_MIME_TYPES = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
  ["image/bmp", ".bmp"],
  ["image/tiff", ".tif"]
]);

const MIME_BY_EXTENSION = new Map(
  [...IMAGE_MIME_TYPES.entries()].map(([mime, extension]) => [extension, mime])
);
MIME_BY_EXTENSION.set(".jpeg", "image/jpeg");
MIME_BY_EXTENSION.set(".tiff", "image/tiff");

export function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    MIME_BY_EXTENSION.get(ext) ||
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".txt": "text/plain; charset=utf-8",
      ".svg": "image/svg+xml"
    }[ext] ||
    "application/octet-stream"
  );
}

export function imageMimeFromName(fileName) {
  return MIME_BY_EXTENSION.get(path.extname(fileName || "").toLowerCase()) || "";
}

export function isSupportedImageMime(mime) {
  return IMAGE_MIME_TYPES.has((mime || "").toLowerCase());
}

export function extensionForMime(mime) {
  return IMAGE_MIME_TYPES.get((mime || "").toLowerCase()) || "";
}

export function sanitizeFileStem(value, fallback = "image") {
  const normalized = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

  const stem = normalized
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80);

  return stem || fallback;
}

export function sanitizeFileName(fileName, fallback = "image") {
  const baseName = path.basename(fileName || fallback);
  const ext = path.extname(baseName).toLowerCase().replace(/[^a-z0-9.]/g, "");
  const stem = sanitizeFileStem(path.basename(baseName, ext), fallback);
  return `${stem}${ext}`;
}

export function sanitizeFolderName(value, fallback = "lora-dataset") {
  return sanitizeFileStem(value, fallback).replace(/\.+/g, "-") || fallback;
}

export function makeUniqueTrainingName(index, originalName, mime, usedNames) {
  const safeName = sanitizeFileName(originalName, `image-${index + 1}`);
  const currentExt = path.extname(safeName);
  const ext = currentExt || extensionForMime(mime) || ".jpg";
  const stem = sanitizeFileStem(path.basename(safeName, currentExt), `image-${index + 1}`);
  const prefix = String(index + 1).padStart(4, "0");
  let candidate = `${prefix}_${stem}${ext}`.slice(0, 120);
  let counter = 2;

  while (usedNames.has(candidate)) {
    candidate = `${prefix}_${stem}-${counter}${ext}`;
    counter += 1;
  }

  usedNames.add(candidate);
  return candidate;
}

export function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

export function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store"
  });
  res.end(text);
}

export function httpError(statusCode, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

export function publicJobSettings(settings) {
  const { apiKey, ...safeSettings } = settings;
  return {
    ...safeSettings,
    hasApiKey: Boolean(apiKey)
  };
}

export function toHumanError(error) {
  if (!error) return "Unknown error";
  if (error.name === "AbortError") return "Request timed out";
  return error.message || String(error);
}

export function safeRelativePath(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    return resolvedTarget;
  }
  throw httpError(403, "Path is outside of the allowed directory");
}
