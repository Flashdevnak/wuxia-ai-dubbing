import baseWorker from "./worker-v2.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MOBILE_PART_SIZE = 4 * 1024 * 1024;
const ROOT_MARKER = "wuxia-ai-dubbing-root-v1";
const FOLDER_MIME = "application/vnd.google-apps.folder";

let cachedGoogleToken = null;
let cachedRootId = null;

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function safeName(name = "video.bin") {
  return name.replace(/[^a-zA-Z0-9._\-ก-๙一-龥ぁ-んァ-ヶ가-힣]+/g, "_").slice(0, 180);
}

function fileKey(name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `uploads/${stamp}-${crypto.randomUUID()}-${safeName(name)}`;
}

function logicalType(key = "") {
  if (key.startsWith("uploads/")) return "upload";
  if (key.startsWith("temp/")) return "temp";
  if (key.startsWith("outputs/")) return "output";
  if (key.startsWith("_jobs/")) return "job";
  if (key.startsWith("_state/")) return "state";
  return "other";
}

function displayNameForKey(key = "file.bin") {
  const last = key.split("/").filter(Boolean).pop() || "file.bin";
  if (key.startsWith("outputs/")) return safeName(last);
  if (key.startsWith("uploads/")) return safeName(last.replace(/^[0-9T\-]+-[0-9a-f-]+-/i, ""));
  return safeName(key.replaceAll("/", "__"));
}

function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function publicAuthorized(request, env, url) {
  const supplied = request.headers.get("x-access-key") || url.searchParams.get("access_key") || "";
  return Boolean(env.ACCESS_KEY && sameSecret(supplied, env.ACCESS_KEY));
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const ownOrigin = new URL(request.url).origin;
  const allowed = new Set([
    ownOrigin,
    "https://flashdevnak.github.io",
    env.ALLOWED_ORIGIN || "",
  ].filter(Boolean));
  const h = {
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,content-length,range,x-access-key,x-worker-token",
    "access-control-expose-headers": "content-length,content-range,accept-ranges,etag",
    "access-control-max-age": "86400",
  };
  if (origin && (allowed.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
    h["access-control-allow-origin"] = origin;
  }
  return h;
}

function withCors(response, request, env) {
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(request, env))) h.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}

function b64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(text) {
  const pad = text.length % 4 ? "=".repeat(4 - (text.length % 4)) : "";
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function encodeUploadState(state) {
  return b64urlEncode(JSON.stringify(state));
}

function decodeUploadState(value) {
  try {
    return JSON.parse(b64urlDecode(value));
  } catch {
    return null;
  }
}

function escapeDriveQueryValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function googleAccessToken(env) {
  const now = Date.now();
  if (cachedGoogleToken && cachedGoogleToken.expiresAt > now + 60_000) return cachedGoogleToken.token;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    throw new Error("Google Drive OAuth ยังไม่ได้ตั้งค่า");
  }
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    throw new Error(`Google OAuth refresh failed (${r.status}): ${data.error_description || data.error || "unknown"}`);
  }
  cachedGoogleToken = {
    token: data.access_token,
    expiresAt: now + Math.max(300, Number(data.expires_in || 3600)) * 1000,
  };
  return cachedGoogleToken.token;
}

async function driveFetch(env, url, options = {}, retry = true) {
  const token = await googleAccessToken(env);
  const headers = new Headers(options.headers || {});
  headers.set("authorization", `Bearer ${token}`);
  const r = await fetch(url, { ...options, headers });
  if (r.status === 401 && retry) {
    cachedGoogleToken = null;
    return driveFetch(env, url, options, false);
  }
  return r;
}

async function driveJson(env, url, options = {}) {
  const r = await driveFetch(env, url, options);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || data?.error_description || data?.error || `HTTP ${r.status}`;
    throw new Error(`Google Drive API: ${msg}`);
  }
  return data;
}

async function driveList(env, q, fields = "nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,appProperties,trashed)") {
  const u = new URL("https://www.googleapis.com/drive/v3/files");
  u.searchParams.set("q", q);
  u.searchParams.set("spaces", "drive");
  u.searchParams.set("pageSize", "100");
  u.searchParams.set("fields", fields);
  const data = await driveJson(env, u.toString());
  return data.files || [];
}

async function ensureRoot(env) {
  if (cachedRootId) return cachedRootId;
  const q = `trashed=false and mimeType='${FOLDER_MIME}' and appProperties has { key='wuxiaRoot' and value='${ROOT_MARKER}' }`;
  const found = await driveList(env, q, "files(id,name,appProperties)");
  if (found[0]?.id) {
    cachedRootId = found[0].id;
    return cachedRootId;
  }
  const metadata = {
    name: env.GOOGLE_DRIVE_FOLDER || "Wuxia AI Dubbing",
    mimeType: FOLDER_MIME,
    appProperties: { wuxiaRoot: ROOT_MARKER },
  };
  const created = await driveJson(env, "https://www.googleapis.com/drive/v3/files?fields=id,name", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(metadata),
  });
  cachedRootId = created.id;
  return cachedRootId;
}

async function resolveLogical(env, key) {
  const root = await ensureRoot(env);
  const escaped = escapeDriveQueryValue(key);
  const q = `'${root}' in parents and trashed=false and appProperties has { key='logicalKey' and value='${escaped}' }`;
  const files = await driveList(env, q);
  if (!files.length) return null;
  files.sort((a, b) => String(b.modifiedTime || "").localeCompare(String(a.modifiedTime || "")));
  return files[0];
}

async function createLogicalFile(env, key, mimeType, declaredSize = null) {
  const root = await ensureRoot(env);
  const existing = await resolveLogical(env, key);
  if (existing?.id) {
    await driveFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(existing.id)}`, { method: "DELETE" });
  }
  const metadata = {
    name: displayNameForKey(key),
    parents: [root],
    mimeType: mimeType || "application/octet-stream",
    appProperties: {
      logicalKey: key,
      wuxiaType: logicalType(key),
      declaredSize: String(Math.max(0, Number(declaredSize || 0))),
    },
  };
  return driveJson(env, "https://www.googleapis.com/drive/v3/files?fields=id,name,size,mimeType,createdTime,modifiedTime,appProperties", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(metadata),
  });
}

async function startResumable(env, key, mimeType, declaredSize) {
  const size = Number(declaredSize || 0);
  if (!Number.isFinite(size) || size <= 0) throw new Error("invalid upload size");
  const file = await createLogicalFile(env, key, mimeType, size);
  const r = await driveFetch(
    env,
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(file.id)}?uploadType=resumable&fields=id,name,size,mimeType,createdTime,modifiedTime,appProperties`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": mimeType || "application/octet-stream",
        "x-upload-content-length": String(size),
      },
      body: JSON.stringify({}),
    },
  );
  if (!r.ok) throw new Error(`Google Drive resumable start failed (${r.status}): ${(await r.text()).slice(0, 600)}`);
  const session = r.headers.get("location");
  if (!session) throw new Error("Google Drive did not return resumable upload session");
  return {
    key,
    uploadId: encodeUploadState({ session, key, fileId: file.id, size, partSize: MOBILE_PART_SIZE }),
    partSize: MOBILE_PART_SIZE,
  };
}

async function uploadPart(request, env, url) {
  const key = url.searchParams.get("key") || "";
  const uploadId = url.searchParams.get("uploadId") || "";
  const partNumber = Number(url.searchParams.get("partNumber"));
  const state = decodeUploadState(uploadId);
  if (!state?.session || !state?.fileId || !state?.key || state.key !== key || !Number.isInteger(partNumber) || partNumber < 1) {
    return json({ error: "invalid upload params" }, 400);
  }

  const bytes = await request.arrayBuffer();
  const length = bytes.byteLength;
  const partSize = Number(state.partSize || MOBILE_PART_SIZE);
  if (!length || length > partSize) return json({ error: "invalid chunk size" }, 413);

  const start = (partNumber - 1) * partSize;
  const end = start + length - 1;
  const total = Number(state.size);
  if (!Number.isFinite(total) || total <= end) return json({ error: "invalid upload range" }, 400);

  const r = await driveFetch(env, state.session, {
    method: "PUT",
    headers: {
      "content-type": request.headers.get("content-type") || "application/octet-stream",
      "content-range": `bytes ${start}-${end}/${total}`,
    },
    body: bytes,
  });

  if (r.status === 308) {
    return json({
      partNumber,
      etag: r.headers.get("etag") || `drive-part-${partNumber}`,
      received: r.headers.get("range") || null,
    });
  }
  if (r.ok) {
    const data = await r.json().catch(() => ({}));
    return json({ partNumber, etag: data.md5Checksum || r.headers.get("etag") || `drive-final-${partNumber}`, complete: true, file: data });
  }
  return json({ error: `Google Drive upload failed (${r.status})`, detail: (await r.text()).slice(0, 800) }, r.status);
}

async function completeUpload(env, body) {
  const state = decodeUploadState(body?.uploadId || "");
  if (!state?.fileId || !body?.key || state.key !== body.key) throw new Error("invalid upload state");
  const meta = await driveJson(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(state.fileId)}?fields=id,name,size,mimeType,createdTime,modifiedTime,appProperties`);
  const expected = Number(state.size || 0);
  const actual = Number(meta.size || 0);
  if (expected && actual !== expected) throw new Error(`upload incomplete: ${actual}/${expected} bytes`);
  return { ok: true, key: body.key, fileId: meta.id, size: actual, etag: meta.md5Checksum || meta.id };
}

async function abortUpload(env, body) {
  const state = decodeUploadState(body?.uploadId || "");
  if (state?.fileId) {
    await driveFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(state.fileId)}`, { method: "DELETE" });
  } else if (body?.key) {
    const file = await resolveLogical(env, body.key);
    if (file?.id) await driveFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`, { method: "DELETE" });
  }
  return { ok: true };
}

async function handleUploadRoute(request, env, url) {
  if (!publicAuthorized(request, env, url)) return json({ error: "กรุณาใส่รหัสสำนัก" }, 401);
  const p = url.pathname;
  if (p === "/api/uploads/start" && request.method === "POST") {
    const body = await request.json();
    const key = fileKey(body.name || "video.bin");
    return json(await startResumable(env, key, body.type || "application/octet-stream", body.size));
  }
  if (p === "/api/uploads/part" && (request.method === "POST" || request.method === "PUT")) return uploadPart(request, env, url);
  if (p === "/api/uploads/complete" && request.method === "POST") return json(await completeUpload(env, await request.json()));
  if (p === "/api/uploads/abort" && request.method === "POST") return json(await abortUpload(env, await request.json()));
  return json({ error: "upload route not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return baseWorker.fetch(request, env);
    if (!url.pathname.startsWith("/api/uploads/")) return baseWorker.fetch(request, env);
    try {
      return withCors(await handleUploadRoute(request, env, url), request, env);
    } catch (err) {
      console.error("mobile upload route failed", err);
      return withCors(json({ error: err?.message || String(err) }, 500), request, env);
    }
  },
};
