const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_PART = 48 * 1024 * 1024;
const DEFAULT_TRANSLATE_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function safeName(name = "video.bin") {
  return String(name).replace(/[^a-zA-Z0-9._\-ก-๙一-龥ぁ-んァ-ヶ가-힣]+/g, "_").slice(0, 180);
}

function newUploadKey(name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `uploads/${stamp}-${crypto.randomUUID()}-${safeName(name)}`;
}

function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function originAllowed(request, env) {
  const origin = request.headers.get("origin") || "";
  if (!origin) return true;
  const allowed = new Set(["https://flashdevnak.github.io", env.ALLOWED_ORIGIN || ""].filter(Boolean));
  return allowed.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function cors(request, env) {
  const origin = request.headers.get("origin") || "";
  const headers = {
    "access-control-allow-methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,range,x-access-key,x-worker-token",
    "access-control-expose-headers": "content-length,content-range,etag,accept-ranges",
    "access-control-max-age": "86400",
  };
  if (origin && originAllowed(request, env)) headers["access-control-allow-origin"] = origin;
  return headers;
}

function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors(request, env))) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function publicAuthorized(request, env, url) {
  const supplied = request.headers.get("x-access-key") || url.searchParams.get("access_key") || "";
  return Boolean(env.ACCESS_KEY && sameSecret(supplied, env.ACCESS_KEY));
}

function internalAuthorized(request, env) {
  const supplied = request.headers.get("x-worker-token") || "";
  return Boolean(env.WORKER_SHARED_TOKEN && sameSecret(supplied, env.WORKER_SHARED_TOKEN));
}

async function listAll(bucket, prefix = "") {
  let cursor;
  const objects = [];
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

async function deletePrefix(bucket, prefix) {
  const objects = await listAll(bucket, prefix);
  for (let i = 0; i < objects.length; i += 1000) {
    await bucket.delete(objects.slice(i, i + 1000).map((o) => o.key));
  }
  return objects.reduce((sum, o) => sum + (o.size || 0), 0);
}

async function storageInfo(env) {
  const objects = await listAll(env.MEDIA);
  const groups = { uploads: 0, temp: 0, outputs: 0, jobs: 0, other: 0 };
  let bytes = 0;
  for (const o of objects) {
    const size = o.size || 0;
    bytes += size;
    if (o.key.startsWith("uploads/")) groups.uploads += size;
    else if (o.key.startsWith("temp/")) groups.temp += size;
    else if (o.key.startsWith("outputs/")) groups.outputs += size;
    else if (o.key.startsWith("_jobs/") || o.key.startsWith("_state/")) groups.jobs += size;
    else groups.other += size;
  }
  return { bytes, groups, objectCount: objects.length };
}

async function readJob(env, id) {
  const obj = await env.MEDIA.get(`_jobs/${id}.json`);
  return obj ? await obj.json() : null;
}

async function writeJob(env, job) {
  job.updatedAt = new Date().toISOString();
  await env.MEDIA.put(`_jobs/${job.id}.json`, JSON.stringify(job), {
    httpMetadata: { contentType: "application/json" },
  });
  return job;
}

async function listJobs(env) {
  const objects = await listAll(env.MEDIA, "_jobs/");
  const jobs = [];
  for (const o of objects.sort((a, b) => String(b.uploaded).localeCompare(String(a.uploaded))).slice(0, 100)) {
    const id = o.key.replace(/^_jobs\//, "").replace(/\.json$/, "");
    const job = await readJob(env, id);
    if (job) jobs.push(job);
  }
  return jobs;
}

async function triggerGitHub(env, payload) {
  if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) {
    return { triggered: false, reason: "GitHub dispatch not configured" };
  }
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "wuxia-ai-dubbing-worker",
      "content-type": "application/json",
    },
    body: JSON.stringify({ event_type: "dubbing_job", client_payload: payload }),
  });
  return { triggered: res.ok, status: res.status, detail: res.ok ? undefined : (await res.text()).slice(0, 1500) };
}

async function objectResponse(request, env, key, filename) {
  const rangeHeader = request.headers.get("range");
  const options = rangeHeader ? { range: request.headers } : undefined;
  const obj = await env.MEDIA.get(key, options);
  if (!obj) return json({ error: "not found" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename || key.split("/").pop())}`);
  let status = 200;
  if (obj.range) {
    status = 206;
    const start = obj.range.offset;
    const length = obj.range.length;
    headers.set("content-length", String(length));
    headers.set("content-range", `bytes ${start}-${start + length - 1}/${obj.size}`);
  } else {
    headers.set("content-length", String(obj.size));
  }
  return new Response(request.method === "HEAD" ? null : obj.body, { status, headers });
}

async function startMultipart(env, key, type = "application/octet-stream", customMetadata = {}) {
  const upload = await env.MEDIA.createMultipartUpload(key, {
    httpMetadata: { contentType: type },
    customMetadata,
  });
  return { key, uploadId: upload.uploadId, partSize: MAX_PART };
}

async function uploadPart(request, env, url) {
  const key = url.searchParams.get("key");
  const uploadId = url.searchParams.get("uploadId");
  const partNumber = Number(url.searchParams.get("partNumber"));
  if (!key || !uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return json({ error: "invalid upload params" }, 400);
  }
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_PART) return json({ error: "part too large" }, 413);
  const upload = env.MEDIA.resumeMultipartUpload(key, uploadId);
  const part = await upload.uploadPart(partNumber, request.body);
  return json({ partNumber: part.partNumber, etag: part.etag });
}

async function completeMultipart(request, env) {
  const body = await request.json();
  if (!body.key || !body.uploadId || !Array.isArray(body.parts) || body.parts.length < 1) {
    return json({ error: "invalid multipart body" }, 400);
  }
  const upload = env.MEDIA.resumeMultipartUpload(body.key, body.uploadId);
  const result = await upload.complete(body.parts);
  return json({ ok: true, key: result.key, size: result.size, etag: result.etag });
}

async function translateBatch(request, env) {
  if (!env.AI) return json({ error: "Workers AI binding is not configured" }, 503);
  const body = await request.json();
  const texts = Array.isArray(body.texts) ? body.texts.slice(0, 12).map((x) => String(x).slice(0, 2500)) : [];
  if (!texts.length) return json({ translations: [] });
  const sourceLang = String(body.sourceLang || "auto");
  const targetLang = String(body.targetLang || "th");
  if (sourceLang === targetLang) return json({ translations: texts });
  const schema = {
    type: "object",
    properties: {
      translations: {
        type: "array",
        items: { type: "string" },
        minItems: texts.length,
        maxItems: texts.length,
      },
    },
    required: ["translations"],
  };
  const result = await env.AI.run(env.TRANSLATE_MODEL || DEFAULT_TRANSLATE_MODEL, {
    messages: [
      {
        role: "system",
        content: "You are a professional audiovisual translator. Translate naturally for dubbing. Preserve names, numbers and meaning. Return only the requested JSON. Never add commentary.",
      },
      {
        role: "user",
        content: JSON.stringify({ sourceLanguage: sourceLang, targetLanguage: targetLang, texts }),
      },
    ],
    temperature: 0.1,
    max_tokens: 4096,
    response_format: { type: "json_schema", json_schema: schema },
  });
  const response = result?.response;
  const parsed = typeof response === "string" ? JSON.parse(response) : response;
  const translations = Array.isArray(parsed?.translations) ? parsed.translations.map(String) : [];
  if (translations.length !== texts.length) return json({ error: "translation count mismatch" }, 502);
  return json({ translations });
}

async function handleInternal(request, env, url) {
  if (!internalAuthorized(request, env)) return json({ error: "worker unauthorized" }, 401);
  const p = url.pathname;

  if (/^\/api\/internal\/jobs\/[^/]+$/.test(p)) {
    const id = p.split("/").pop();
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

  if (p === "/api/internal/file" && (request.method === "GET" || request.method === "HEAD")) {
    const key = url.searchParams.get("key");
    if (!key) return json({ error: "missing key" }, 400);
    return objectResponse(request, env, key, key.split("/").pop());
  }

  if (p === "/api/internal/translate" && request.method === "POST") return translateBatch(request, env);

  if (p === "/api/internal/uploads/start" && request.method === "POST") {
    const body = await request.json();
    const key = String(body.key || "");
    if (!key || key.startsWith("_jobs/") || key.includes("..")) return json({ error: "invalid key" }, 400);
    return json(await startMultipart(env, key, body.type || "application/octet-stream"));
  }
  if (p === "/api/internal/uploads/part" && request.method === "PUT") return uploadPart(request, env, url);
  if (p === "/api/internal/uploads/complete" && request.method === "POST") return completeMultipart(request, env);

  if (p === "/api/internal/chunk-complete" && request.method === "POST") {
    const body = await request.json();
    const jobId = String(body.jobId || "");
    const index = Number(body.index);
    const total = Number(body.total);
    if (!jobId || !Number.isInteger(index) || !Number.isInteger(total) || total < 1) return json({ error: "invalid chunk state" }, 400);
    await env.MEDIA.put(`_state/${jobId}/chunks/${String(index).padStart(5, "0")}.json`, JSON.stringify({ index, at: new Date().toISOString() }));
    const completed = (await listAll(env.MEDIA, `_state/${jobId}/chunks/`)).length;
    const job = await readJob(env, jobId);
    if (job) {
      job.status = "processing";
      job.progress = Math.min(92, Math.round(12 + (completed / total) * 78));
      job.stage = completed >= total ? "กำลังรวมวิดีโอ" : `พากย์เสร็จ ${completed}/${total} ช่วง`;
      await writeJob(env, job);
    }
    return json({ ok: true, completed, total, allDone: completed >= total });
  }

  if (p === "/api/internal/complete" && request.method === "POST") {
    const body = await request.json();
    const job = await readJob(env, String(body.jobId || ""));
    if (!job) return json({ error: "not found" }, 404);
    job.status = "completed";
    job.progress = 100;
    job.stage = "เสร็จสมบูรณ์";
    job.outputKey = body.outputKey || job.outputKey;
    job.subtitleKey = body.subtitleKey || job.subtitleKey;
    job.duration = Number(body.duration || job.duration || 0);
    job.sizeBytes = Number(body.sizeBytes || job.sizeBytes || 0);
    job.error = null;
    await writeJob(env, job);
    let freedBytes = 0;
    if (job.autoCleanup) {
      freedBytes += await deletePrefix(env.MEDIA, `temp/${job.id}/`);
      freedBytes += await deletePrefix(env.MEDIA, `_state/${job.id}/`);
    }
    return json({ ok: true, job, freedBytes });
  }

  if (p === "/api/internal/fail" && request.method === "POST") {
    const body = await request.json();
    const job = await readJob(env, String(body.jobId || ""));
    if (!job) return json({ error: "not found" }, 404);
    job.status = "failed";
    job.stage = "ประมวลผลไม่สำเร็จ";
    job.error = String(body.error || "unknown error").slice(0, 4000);
    await writeJob(env, job);
    return json({ ok: true });
  }

  return json({ error: "internal route not found" }, 404);
}

async function handlePublic(request, env, url) {
  const p = url.pathname;
  if (!publicAuthorized(request, env, url)) return json({ error: "กรุณาใส่รหัสสำนัก" }, 401);

  if (p === "/api/storage" && request.method === "GET") {
    const info = await storageInfo(env);
    const limitGb = Number(env.FREE_STORAGE_GB || 10);
    return json({ ...info, limitBytes: limitGb * 1024 ** 3 });
  }

  if (p === "/api/files" && request.method === "GET") {
    const objects = await listAll(env.MEDIA);
    return json({
      files: objects
        .filter((o) => !o.key.startsWith("_jobs/") && !o.key.startsWith("_state/") && !o.key.startsWith("temp/"))
        .map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded, etag: o.etag })),
    });
  }

  if (p === "/api/files/download" && (request.method === "GET" || request.method === "HEAD")) {
    const key = url.searchParams.get("key");
    if (!key || key.startsWith("_jobs/") || key.startsWith("_state/") || key.startsWith("temp/")) return json({ error: "invalid key" }, 400);
    return objectResponse(request, env, key, key.split("/").pop());
  }

  if (p === "/api/files" && request.method === "DELETE") {
    const key = url.searchParams.get("key");
    if (!key || key.startsWith("_jobs/") || key.startsWith("_state/")) return json({ error: "invalid key" }, 400);
    const head = await env.MEDIA.head(key);
    await env.MEDIA.delete(key);
    return json({ ok: true, key, freedBytes: head?.size || 0 });
  }

  if (p === "/api/uploads/start" && request.method === "POST") {
    const body = await request.json();
    const key = newUploadKey(body.name || "video.bin");
    return json(await startMultipart(env, key, body.type || "application/octet-stream", {
      originalName: String(body.name || "video.bin"),
      declaredSize: String(body.size || 0),
    }));
  }
  if (p === "/api/uploads/part" && request.method === "PUT") return uploadPart(request, env, url);
  if (p === "/api/uploads/complete" && request.method === "POST") return completeMultipart(request, env);
  if (p === "/api/uploads/abort" && request.method === "POST") {
    const body = await request.json();
    const upload = env.MEDIA.resumeMultipartUpload(body.key, body.uploadId);
    await upload.abort();
    return json({ ok: true });
  }

  if (p === "/api/jobs" && request.method === "GET") return json({ jobs: await listJobs(env) });

  if (p === "/api/jobs" && request.method === "POST") {
    const body = await request.json();
    const sourceType = body.sourceType === "link" ? "link" : "upload";
    if (sourceType === "upload") {
      if (!body.sourceKey || !(await env.MEDIA.head(body.sourceKey))) return json({ error: "missing uploaded file" }, 400);
    } else if (!/^https?:\/\//i.test(String(body.sourceUrl || ""))) {
      return json({ error: "invalid source url" }, 400);
    }
    const job = {
      id: crypto.randomUUID(),
      title: String(body.title || "งานพากย์ใหม่").slice(0, 240),
      sourceType,
      sourceKey: sourceType === "upload" ? body.sourceKey : null,
      sourceUrl: sourceType === "link" ? body.sourceUrl : null,
      sourceLang: body.sourceLang || "auto",
      targetLang: body.targetLang || "th",
      voiceMode: body.voiceMode || "auto",
      subtitles: body.subtitles !== false,
      keepMusic: body.keepMusic !== false,
      speakerSeparation: body.speakerSeparation === true,
      autoCleanup: body.autoCleanup !== false,
      status: "queued",
      progress: 1,
      stage: "เข้าคิวประมวลผล",
      createdAt: new Date().toISOString(),
    };
    await writeJob(env, job);
    const workerBase = `${url.protocol}//${url.host}`;
    const dispatch = await triggerGitHub(env, { job, workerBase });
    if (!dispatch.triggered) {
      job.stage = "รอตั้งค่า GitHub Actions";
      job.error = dispatch.detail || dispatch.reason || null;
      await writeJob(env, job);
    }
    return json({ job, dispatch }, 201);
  }

  if (/^\/api\/jobs\/[^/]+$/.test(p)) {
    const id = p.split("/").pop();
    if (request.method === "GET") {
      const job = await readJob(env, id);
      return job ? json({ job }) : json({ error: "not found" }, 404);
    }
    if (request.method === "DELETE") {
      const job = await readJob(env, id);
      let freedBytes = 0;
      if (job) {
        for (const key of [job.sourceKey, job.outputKey, job.subtitleKey].filter(Boolean)) {
          const head = await env.MEDIA.head(key);
          freedBytes += head?.size || 0;
          await env.MEDIA.delete(key);
        }
        freedBytes += await deletePrefix(env.MEDIA, `temp/${id}/`);
        freedBytes += await deletePrefix(env.MEDIA, `_state/${id}/`);
      }
      await env.MEDIA.delete(`_jobs/${id}.json`);
      return json({ ok: true, freedBytes });
    }
  }

  if (p === "/api/cleanup/temp" && request.method === "POST") {
    const freedBytes = await deletePrefix(env.MEDIA, "temp/");
    return json({ ok: true, freedBytes });
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
      let response;
      if (url.pathname === "/api/health") {
        response = json({ ok: true, app: env.APP_NAME || "Wuxia AI Dubbing", backend: "cloudflare-r2", ai: Boolean(env.AI) });
      } else if (url.pathname.startsWith("/api/internal/")) {
        response = await handleInternal(request, env, url);
      } else if (url.pathname.startsWith("/api/")) {
        response = await handlePublic(request, env, url);
      } else {
        response = await env.ASSETS.fetch(request);
      }
      return withCors(response, request, env);
    } catch (err) {
      return withCors(json({ error: err?.message || String(err) }, 500), request, env);
    }
  },
};
