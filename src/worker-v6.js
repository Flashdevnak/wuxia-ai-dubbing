import workerV5 from "./worker-v5.js";

const SAFE_PART_SIZE = 1 * 1024 * 1024;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function decodeBase64(value = "") {
  try {
    const bin = atob(value);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function forwardedHeaders(request, contentType = "application/octet-stream") {
  const headers = new Headers();
  const accessKey = request.headers.get("x-access-key");
  if (accessKey) headers.set("x-access-key", accessKey);
  const origin = request.headers.get("origin");
  if (origin) headers.set("origin", origin);
  headers.set("content-type", contentType);
  return headers;
}

async function startSafe(request, env) {
  const target = new URL(request.url);
  target.pathname = "/api/uploads/start";
  target.search = "";
  const headers = new Headers(request.headers);
  headers.set("sec-fetch-site", "same-origin");
  headers.set("sec-fetch-mode", "cors");
  headers.set("sec-ch-ua-mobile", "?1");

  const forwarded = new Request(target.toString(), {
    method: "POST",
    headers,
    body: await request.text(),
  });
  const response = await workerV5.fetch(forwarded, env);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return json(data, response.status);

  // worker-v4 encodes a 1 MiB part size inside uploadId for browser sessions.
  // Hide the direct Google session from safe mode so the browser never makes a
  // cross-origin binary request; bytes will return through /base64-part instead.
  delete data.directSession;
  data.directUpload = false;
  data.safeUpload = true;
  data.partSize = SAFE_PART_SIZE;
  return json(data);
}

async function uploadBase64Part(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.key || !body?.uploadId || !Number.isInteger(Number(body?.partNumber)) || !body?.data) {
    return json({ error: "invalid safe upload payload" }, 400);
  }

  const bytes = decodeBase64(body.data);
  if (!bytes?.byteLength || bytes.byteLength > SAFE_PART_SIZE) {
    return json({ error: "invalid safe upload chunk size" }, 413);
  }

  const target = new URL(request.url);
  target.pathname = "/api/uploads/part";
  target.search = new URLSearchParams({
    key: String(body.key),
    uploadId: String(body.uploadId),
    partNumber: String(Number(body.partNumber)),
  }).toString();

  const forwarded = new Request(target.toString(), {
    method: "POST",
    headers: forwardedHeaders(request, body.mimeType || "application/octet-stream"),
    body: bytes,
  });
  return workerV5.fetch(forwarded, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/uploads/start-safe" && request.method === "POST") {
        return startSafe(request, env);
      }
      if (url.pathname === "/api/uploads/base64-part" && request.method === "POST") {
        return uploadBase64Part(request, env);
      }
      return workerV5.fetch(request, env);
    } catch (err) {
      console.error("safe upload route failed", err);
      return json({ error: err?.message || String(err) }, 500);
    }
  },
};
