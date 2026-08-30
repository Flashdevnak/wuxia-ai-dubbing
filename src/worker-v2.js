const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const PART_SIZE = 32 * 1024 * 1024;
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

function originAllowed(request, env) {
  const origin = request.headers.get("origin") || "";
  if (!origin) return true;
  const allowed = new Set([
    "https://flashdevnak.github.io",
    env.ALLOWED_ORIGIN || "",
  ].filter(Boolean));
  return allowed.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function cors(request, env) {
  const origin = request.headers.get("origin") || "";
  const h = {
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,content-length,range,x-access-key,x-worker-token",
    "access-control-expose-headers": "content-length,content-range,accept-ranges,etag",
    "access-control-max-age": "86400",
  };
  if (originAllowed(request, env) && origin) h["access-control-allow-origin"] = origin;
  return h;
}

function withCors(response, request, env) {
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors(request, env))) h.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
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

function workerAuthorized(request, env) {
  const supplied = request.headers.get("x-worker-token") || "";
  return Boolean(env.WORKER_SHARED_TOKEN && sameSecret(supplied, env.WORKER_SHARED_TOKEN));
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
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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
  let pageToken = "";
  const files = [];
  do {
    const u = new URL("https://www.googleapis.com/drive/v3/files");
    u.searchParams.set("q", q);
    u.searchParams.set("spaces", "drive");
    u.searchParams.set("pageSize", "1000");
    u.searchParams.set("fields", fields);
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const data = await driveJson(env, u.toString());
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return files;
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

async function listAppFiles(env) {
  const root = await ensureRoot(env);
  return driveList(env, `'${root}' in parents and trashed=false`);
}

async function createLogicalFile(env, key, mimeType, declaredSize = null) {
  const root = await ensureRoot(env);
  const existing = await resolveLogical(env, key);
  if (existing?.id) {
    await driveFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(existing.id)}`, { method: "DELETE" });
  }
  const appProperties = {
    logicalKey: key,
    wuxiaType: logicalType(key),
  };
  if (declaredSize !== null && declaredSize !== undefined && Number.isFinite(Number(declaredSize))) {
    appProperties.declaredSize = String(Math.max(0, Number(declaredSize)));
  }
  const metadata = {
    name: displayNameForKey(key),
    parents: [root],
    mimeType: mimeType || "application/octet-stream",
    appProperties,
  };
  return driveJson(env, "https://www.googleapis.com/drive/v3/files?fields=id,name,size,mimeType,createdTime,modifiedTime,appProperties", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(metadata),
  });
}

async function startResumable(env, key, mimeType, declaredSize = null) {
  const file = await createLogicalFile(env, key, mimeType, declaredSize);
  const headers = {
    "content-type": "application/json; charset=UTF-8",
    "x-upload-content-type": mimeType || "application/octet-stream",
  };
  if (declaredSize !== null && declaredSize !== undefined && Number(declaredSize) >= 0) {
    headers["x-upload-content-length"] = String(Number(declaredSize));
  }
  const r = await driveFetch(
    env,
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(file.id)}?uploadType=resumable&fields=id,name,size,mimeType,createdTime,modifiedTime,appProperties`,
    { method: "PATCH", headers, body: JSON.stringify({}) },
  );
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Google Drive resumable start failed (${r.status}): ${text.slice(0, 800)}`);
  }
  const session = r.headers.get("location");
  if (!session) throw new Error("Google Drive did not return resumable upload session");
  return {
    key,
    uploadId: encodeUploadState({ session, key, fileId: file.id, size: declaredSize === null ? null : Number(declaredSize), partSize: PART_SIZE }),
    partSize: PART_SIZE,
  };
}

async function driveUploadPart(request, env, url) {
  const key = url.searchParams.get("key") || "";
  const uploadId = url.searchParams.get("uploadId") || "";
  const partNumber = Number(url.searchParams.get("partNumber"));
  const state = decodeUploadState(uploadId);
  if (!state?.session || !state?.fileId || !state?.key || state.key !== key || !Number.isInteger(partNumber) || partNumber < 1) {
    return json({ error: "invalid upload params" }, 400);
  }
  const length = Number(request.headers.get("content-length") || 0);
  if (!Number.isFinite(length) || length <= 0 || length > PART_SIZE) return json({ error: "invalid chunk size" }, 413);
  const start = (partNumber - 1) * PART_SIZE;
  const end = start + length - 1;
  const finalTotalParam = url.searchParams.get("finalTotal");
  const total = state.size !== null && state.size !== undefined
    ? Number(state.size)
    : (finalTotalParam ? Number(finalTotalParam) : null);
  const totalSpec = Number.isFinite(total) && total >= end + 1 ? String(total) : "*";
  const r = await driveFetch(env, state.session, {
    method: "PUT",
    headers: {
      "content-type": request.headers.get("content-type") || "application/octet-stream",
      "content-length": String(length),
      "content-range": `bytes ${start}-${end}/${totalSpec}`,
    },
    body: request.body,
  });
  if (r.status === 308) {
    return json({ partNumber, etag: r.headers.get("etag") || `drive-part-${partNumber}`, received: r.headers.get("range") || null });
  }
  if (r.ok) {
    const data = await r.json().catch(() => ({}));
    return json({ partNumber, etag: data.md5Checksum || r.headers.get("etag") || `drive-final-${partNumber}`, complete: true, file: data });
  }
  const text = await r.text();
  return json({ error: `Google Drive upload failed (${r.status})`, detail: text.slice(0, 1000) }, r.status);
}

async function completeUpload(env, body) {
  if (!body?.key || !body?.uploadId) throw new Error("invalid upload body");
  const state = decodeUploadState(body.uploadId);
  if (!state?.fileId || state.key !== body.key) throw new Error("invalid upload state");
  const meta = await driveJson(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(state.fileId)}?fields=id,name,size,mimeType,createdTime,modifiedTime,appProperties`);
  return {
    ok: true,
    key: body.key,
    fileId: meta.id,
    size: Number(meta.size || 0),
    etag: meta.md5Checksum || meta.id,
  };
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

async function uploadSmallText(env, key, text, mimeType = "application/json") {
  let file = await resolveLogical(env, key);
  if (!file) file = await createLogicalFile(env, key, mimeType, new TextEncoder().encode(text).byteLength);
  const r = await driveFetch(env, `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(file.id)}?uploadType=media`, {
    method: "PATCH",
    headers: { "content-type": mimeType },
    body: text,
  });
  if (!r.ok) throw new Error(`Google Drive small upload failed (${r.status}): ${(await r.text()).slice(0, 800)}`);
  return file;
}

async function downloadLogicalResponse(request, env, key, attachment = false) {
  const file = await resolveLogical(env, key);
  if (!file?.id) return json({ error: "not found" }, 404);
  const headers = {};
  const range = request.headers.get("range");
  if (range) headers.range = range;
  const r = await driveFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`, { headers });
  if (!r.ok && r.status !== 206) {
    return json({ error: `Google Drive download failed (${r.status})`, detail: (await r.text()).slice(0, 600) }, r.status);
  }
  const out = new Headers();
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const v = r.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set("accept-ranges", "bytes");
  if (attachment) out.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name || key.split("/").pop())}`);
  return new Response(r.body, { status: r.status, headers: out });
}

async function deleteLogical(env, key) {
  const file = await resolveLogical(env, key);
  if (!file?.id) return 0;
  const size = Number(file.size || 0);
  const r = await driveFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`, { method: "DELETE" });
  if (!r.ok && r.status !== 404) throw new Error(`Google Drive delete failed (${r.status})`);
  return size;
}

async function deletePrefix(env, prefix) {
  const files = await listAppFiles(env);
  const matches = files.filter(f => String(f.appProperties?.logicalKey || "").startsWith(prefix));
  let bytes = 0;
  for (const f of matches) {
    bytes += Number(f.size || 0);
    await driveFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}`, { method: "DELETE" });
  }
  return { bytes, count: matches.length };
}

async function storageInfo(env) {
  const files = await listAppFiles(env);
  let bytes = 0;
  const groups = { uploads: 0, temp: 0, outputs: 0, jobs: 0, other: 0 };
  for (const f of files) {
    const key = String(f.appProperties?.logicalKey || "");
    const size = Number(f.size || 0);
    bytes += size;
    if (key.startsWith("uploads/")) groups.uploads += size;
    else if (key.startsWith("temp/")) groups.temp += size;
    else if (key.startsWith("outputs/")) groups.outputs += size;
    else if (key.startsWith("_jobs/") || key.startsWith("_state/")) groups.jobs += size;
    else groups.other += size;
  }
  let accountLimitBytes = Number(env.GOOGLE_STORAGE_GB || 15) * 1024 ** 3;
  let accountUsageBytes = 0;
  try {
    const about = await driveJson(env, "https://www.googleapis.com/drive/v3/about?fields=storageQuota,user(displayName,emailAddress)");
    accountLimitBytes = Number(about?.storageQuota?.limit || accountLimitBytes);
    accountUsageBytes = Number(about?.storageQuota?.usage || 0);
  } catch (err) {
    console.warn("Drive quota lookup failed", err?.message || err);
  }
  const nonAppUsage = Math.max(0, accountUsageBytes - bytes);
  const appCapacity = Math.max(bytes, accountLimitBytes - nonAppUsage);
  return {
    bytes,
    groups,
    objectCount: files.length,
    limitBytes: appCapacity,
    accountLimitBytes,
    accountUsageBytes,
    accountRemainingBytes: Math.max(0, accountLimitBytes - accountUsageBytes),
    provider: "google-drive",
  };
}

async function readJsonLogical(env, key) {
  const file = await resolveLogical(env, key);
  if (!file?.id) return null;
  const r = await driveFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`);
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

async function readJob(env, id) {
  return readJsonLogical(env, `_jobs/${id}.json`);
}

async function writeJob(env, job) {
  job.updatedAt = new Date().toISOString();
  await uploadSmallText(env, `_jobs/${job.id}.json`, JSON.stringify(job), "application/json");
  return job;
}

async function listJobs(env) {
  const files = await listAppFiles(env);
  const jobFiles = files
    .filter(f => String(f.appProperties?.logicalKey || "").startsWith("_jobs/"))
    .sort((a, b) => String(b.modifiedTime || "").localeCompare(String(a.modifiedTime || "")))
    .slice(0, 100);
  const jobs = [];
  for (const f of jobFiles) {
    const key = String(f.appProperties.logicalKey);
    const job = await readJsonLogical(env, key);
    if (job) jobs.push(job);
  }
  return jobs;
}

async function triggerGitHub(env, job, workerBase) {
  if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) return { triggered: false, reason: "GitHub dispatch not configured" };
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "wuxia-ai-dubbing-worker",
      "content-type": "application/json",
    },
    body: JSON.stringify({ event_type: "dubbing_job", client_payload: { job, workerBase } }),
  });
  return { triggered: res.ok, status: res.status, detail: res.ok ? undefined : await res.text() };
}

async function translateWithAI(env, texts, sourceLang, targetLang) {
  if (!env.AI) throw new Error("Workers AI binding unavailable");
  const payload = {
    messages: [
      {
        role: "system",
        content: "You are a professional subtitle translator. Translate each item faithfully and naturally. Preserve names, tone and sequence. Return ONLY a JSON array of translated strings with exactly the same number of items. No markdown.",
      },
      {
        role: "user",
        content: JSON.stringify({ sourceLanguage: sourceLang || "auto", targetLanguage: targetLang, texts }),
      },
    ],
    temperature: 0.1,
    max_tokens: 4096,
  };
  const out = await env.AI.run(env.TRANSLATE_MODEL || "@cf/meta/llama-3.1-8b-instruct-fast", payload);
  const text = String(out?.response || out?.result?.response || "").trim();
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("Workers AI translation returned invalid JSON");
  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed) || parsed.length !== texts.length) throw new Error("Workers AI translation count mismatch");
  return parsed.map(x => String(x));
}

async function handleInternal(request, env, url) {
  if (!workerAuthorized(request, env)) return json({ error: "worker unauthorized" }, 401);
  const p = url.pathname;

  if (/^\/api\/internal\/jobs\/[^/]+$/.test(p)) {
    const id = decodeURIComponent(p.split("/").pop());
    if (request.method === "GET") {
      const job = await readJob(env, id);
      return job ? json({ job }) : json({ error: "not found" }, 404);
    }
    if (request.method === "PATCH") {
      const current = await readJob(env, id);
      if (!current) return json({ error: "not found" }, 404);
      const patch = await request.json();
      const allowed = ["status", "progress", "stage", "outputKey", "subtitleKey", "log", "duration", "sizeBytes", "chunkTotal", "error"];
      for (const k of allowed) if (k in patch) current[k] = patch[k];
      await writeJob(env, current);
      return json({ job: current });
    }
  }

  if (p === "/api/internal/file" && request.method === "GET") {
    const key = url.searchParams.get("key");
    if (!key) return json({ error: "missing key" }, 400);
    return downloadLogicalResponse(request, env, key, false);
  }

  if (p === "/api/internal/uploads/start" && request.method === "POST") {
    const body = await request.json();
    const key = String(body.key || "");
    if (!key || key.startsWith("_jobs/") || key.includes("..")) return json({ error: "invalid key" }, 400);
    return json(await startResumable(env, key, body.type || "application/octet-stream", body.size ?? null));
  }

  if (p === "/api/internal/uploads/part" && request.method === "PUT") return driveUploadPart(request, env, url);
  if (p === "/api/internal/uploads/complete" && request.method === "POST") return json(await completeUpload(env, await request.json()));

  if (p === "/api/internal/chunk-complete" && request.method === "POST") {
    const body = await request.json();
    const jobId = String(body.jobId || "");
    const index = Number(body.index);
    const total = Number(body.total);
    if (!jobId || !Number.isInteger(index) || !Number.isInteger(total) || total < 1) return json({ error: "invalid chunk state" }, 400);
    await uploadSmallText(env, `_state/${jobId}/chunks/${String(index).padStart(5, "0")}.json`, JSON.stringify({ index, at: new Date().toISOString() }), "application/json");
    const files = await listAppFiles(env);
    const completed = files.filter(f => String(f.appProperties?.logicalKey || "").startsWith(`_state/${jobId}/chunks/`)).length;
    const job = await readJob(env, jobId);
    if (job) {
      job.status = "processing";
      job.progress = Math.min(92, Math.round(12 + (completed / total) * 78));
      job.stage = completed >= total ? "กำลังรวมวิดีโอ" : `พากย์เสร็จ ${completed}/${total} ช่วง`;
      await writeJob(env, job);
    }
    return json({ ok: true, completed, total, allDone: completed >= total });
  }

  if (p === "/api/internal/translate" && request.method === "POST") {
    const body = await request.json();
    const texts = Array.isArray(body.texts) ? body.texts.map(x => String(x)) : [];
    if (!texts.length || texts.length > 20) return json({ error: "invalid translation batch" }, 400);
    const translations = await translateWithAI(env, texts, String(body.sourceLang || "auto"), String(body.targetLang || "th"));
    return json({ translations });
  }

  if (p === "/api/internal/complete" && request.method === "POST") {
    const body = await request.json();
    const job = await readJob(env, body.jobId);
    if (!job) return json({ error: "not found" }, 404);
    job.status = "completed";
    job.progress = 100;
    job.stage = "เสร็จสมบูรณ์";
    job.outputKey = body.outputKey || job.outputKey;
    job.subtitleKey = body.subtitleKey || job.subtitleKey;
    job.duration = body.duration || job.duration;
    job.sizeBytes = body.sizeBytes || job.sizeBytes;
    job.error = null;
    await writeJob(env, job);
    let freedBytes = 0;
    if (job.autoCleanup) {
      freedBytes += (await deletePrefix(env, `temp/${job.id}/`)).bytes;
      freedBytes += (await deletePrefix(env, `_state/${job.id}/`)).bytes;
      if (job.sourceType === "upload" && body.deleteSource === true && job.sourceKey) {
        freedBytes += await deleteLogical(env, job.sourceKey);
        job.sourceKey = null;
        await writeJob(env, job);
      }
    }
    return json({ ok: true, job, freedBytes });
  }

  if (p === "/api/internal/fail" && request.method === "POST") {
    const body = await request.json();
    const job = await readJob(env, body.jobId);
    if (!job) return json({ error: "not found" }, 404);
    job.status = "failed";
    job.stage = "ประมวลผลไม่สำเร็จ";
    job.error = String(body.error || "unknown error").slice(0, 4000);
    await writeJob(env, job);
    return json({ ok: true });
  }

  return json({ error: "internal route not found" }, 404);
}

async function handleApi(request, env, url) {
  const p = url.pathname;
  if (p === "/api/health") {
    let driveReady = false;
    let detail = null;
    try {
      await ensureRoot(env);
      driveReady = true;
    } catch (err) {
      detail = err?.message || String(err);
    }
    return json({ ok: true, app: env.APP_NAME || "Wuxia AI Dubbing", backend: "google-drive", driveReady, detail });
  }
  if (p.startsWith("/api/internal/")) return handleInternal(request, env, url);
  if (!publicAuthorized(request, env, url)) return json({ error: "กรุณาใส่รหัสสำนัก" }, 401);

  if (p === "/api/storage" && request.method === "GET") return json(await storageInfo(env));

  if (p === "/api/files" && request.method === "GET") {
    const files = await listAppFiles(env);
    const visible = files
      .map(f => ({
        key: String(f.appProperties?.logicalKey || ""),
        size: Number(f.size || 0),
        uploaded: f.createdTime,
        modified: f.modifiedTime,
        fileId: f.id,
      }))
      .filter(f => f.key && !f.key.startsWith("_jobs/") && !f.key.startsWith("_state/"));
    return json({ files: visible });
  }

  if (p === "/api/files/download" && request.method === "GET") {
    const key = url.searchParams.get("key");
    if (!key || key.startsWith("_jobs/") || key.startsWith("_state/")) return json({ error: "invalid key" }, 400);
    return downloadLogicalResponse(request, env, key, true);
  }

  if (p === "/api/files" && request.method === "DELETE") {
    const key = url.searchParams.get("key");
    if (!key || key.startsWith("_jobs/") || key.startsWith("_state/")) return json({ error: "invalid key" }, 400);
    const freedBytes = await deleteLogical(env, key);
    return json({ ok: true, key, freedBytes });
  }

  if (p === "/api/uploads/start" && request.method === "POST") {
    const body = await request.json();
    const key = fileKey(body.name || "video.bin");
    return json(await startResumable(env, key, body.type || "application/octet-stream", Number(body.size || 0)));
  }

  if (p === "/api/uploads/part" && request.method === "PUT") return driveUploadPart(request, env, url);
  if (p === "/api/uploads/complete" && request.method === "POST") return json(await completeUpload(env, await request.json()));
  if (p === "/api/uploads/abort" && request.method === "POST") return json(await abortUpload(env, await request.json()));

  if (p === "/api/jobs" && request.method === "GET") return json({ jobs: await listJobs(env) });

  if (p === "/api/jobs" && request.method === "POST") {
    const body = await request.json();
    if (body.sourceType === "upload") {
      if (!body.sourceKey) return json({ error: "missing uploaded file" }, 400);
      const src = await resolveLogical(env, body.sourceKey);
      if (!src) return json({ error: "uploaded file not found" }, 404);
    }
    if (body.sourceType === "link" && !/^https?:\/\//i.test(body.sourceUrl || "")) return json({ error: "invalid source url" }, 400);
    const job = {
      id: crypto.randomUUID(),
      title: body.title || "งานพากย์ใหม่",
      sourceType: body.sourceType || "upload",
      sourceKey: body.sourceKey || null,
      sourceUrl: body.sourceUrl || null,
      sourceLang: body.sourceLang || "auto",
      targetLang: body.targetLang || "th",
      voiceMode: body.voiceMode || "auto",
      subtitles: body.subtitles !== false,
      keepMusic: body.keepMusic !== false,
      speakerSeparation: body.speakerSeparation !== false,
      autoCleanup: body.autoCleanup !== false,
      status: "queued",
      progress: 1,
      stage: "เข้าคิวประมวลผล",
      createdAt: new Date().toISOString(),
    };
    await writeJob(env, job);
    const workerBase = `${url.protocol}//${url.host}`;
    const dispatch = await triggerGitHub(env, job, workerBase);
    if (!dispatch.triggered) {
      job.stage = "รอตั้งค่า GitHub Actions";
      job.error = dispatch.detail || dispatch.reason || null;
      await writeJob(env, job);
    }
    return json({ job, dispatch }, 201);
  }

  if (/^\/api\/jobs\/[^/]+$/.test(p)) {
    const id = decodeURIComponent(p.split("/").pop());
    if (request.method === "GET") {
      const job = await readJob(env, id);
      return job ? json({ job }) : json({ error: "not found" }, 404);
    }
    if (request.method === "DELETE") {
      const job = await readJob(env, id);
      let freedBytes = 0;
      if (job) {
        for (const key of [job.sourceKey, job.outputKey, job.subtitleKey].filter(Boolean)) freedBytes += await deleteLogical(env, key);
        freedBytes += (await deletePrefix(env, `temp/${id}/`)).bytes;
        freedBytes += (await deletePrefix(env, `_state/${id}/`)).bytes;
      }
      freedBytes += await deleteLogical(env, `_jobs/${id}.json`);
      return json({ ok: true, freedBytes });
    }
  }

  if (p === "/api/cleanup/temp" && request.method === "POST") {
    const result = await deletePrefix(env, "temp/");
    return json({ ok: true, freedBytes: result.bytes, deleted: result.count });
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      if (!originAllowed(request, env)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors(request, env) });
    }
    try {
      const response = url.pathname.startsWith("/api/")
        ? await handleApi(request, env, url)
        : await env.ASSETS.fetch(request);
      return withCors(response, request, env);
    } catch (err) {
      console.error(err);
      return withCors(json({ error: err?.message || String(err) }, 500), request, env);
    }
  },
};
