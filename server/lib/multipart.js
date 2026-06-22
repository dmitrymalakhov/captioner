import { httpError } from "./utils.js";

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n");

export async function readRequestBody(req, maxBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw httpError(413, `Request is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

export async function readJson(req, maxBytes = 1024 * 1024) {
  const body = await readRequestBody(req, maxBytes);
  if (body.length === 0) return {};

  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw httpError(400, "Request body must be valid JSON");
  }
}

export async function parseMultipart(req, maxBytes) {
  const contentType = req.headers["content-type"] || "";
  const boundary = parseBoundary(contentType);
  const body = await readRequestBody(req, maxBytes);
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = body.indexOf(delimiter);

  if (cursor === -1) {
    throw httpError(400, "Multipart boundary was not found in the request body");
  }

  while (cursor !== -1) {
    cursor += delimiter.length;

    if (body[cursor] === 45 && body[cursor + 1] === 45) break;
    if (body[cursor] === 13 && body[cursor + 1] === 10) cursor += 2;

    const nextBoundary = body.indexOf(delimiter, cursor);
    if (nextBoundary === -1) break;

    let part = body.subarray(cursor, nextBoundary);
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) {
      part = part.subarray(0, part.length - 2);
    }

    const headerEnd = part.indexOf(HEADER_SEPARATOR);
    if (headerEnd === -1) {
      cursor = nextBoundary;
      continue;
    }

    const rawHeaders = part.subarray(0, headerEnd).toString("utf8");
    const data = part.subarray(headerEnd + HEADER_SEPARATOR.length);
    const headers = parseHeaders(rawHeaders);
    const disposition = parseContentDisposition(headers["content-disposition"] || "");

    if (disposition.name) {
      parts.push({
        headers,
        name: disposition.name,
        filename: disposition.filename || "",
        contentType: headers["content-type"] || "",
        data
      });
    }

    cursor = nextBoundary;
  }

  return parts;
}

function parseBoundary(contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = match?.[1] || match?.[2];
  if (!boundary) {
    throw httpError(400, "Content-Type must include a multipart boundary");
  }
  return boundary;
}

function parseHeaders(rawHeaders) {
  const headers = {};
  for (const line of rawHeaders.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[key] = value;
  }
  return headers;
}

function parseContentDisposition(value) {
  const result = {};
  for (const part of value.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    const key = rawKey.trim().toLowerCase();
    if (!key) continue;
    let parsedValue = rawValue.join("=").trim();
    if (parsedValue.startsWith('"') && parsedValue.endsWith('"')) {
      parsedValue = parsedValue.slice(1, -1);
    }
    if (key === "name" || key === "filename") {
      result[key] = parsedValue;
    }
  }
  return result;
}
