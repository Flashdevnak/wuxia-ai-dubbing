const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_PUBLIC_PART = 48 * 1024 * 1024;

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
    "access-control-allow-headers": "content-type,x-access-key,x-worker-token",
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
    await bucket.delete(objects.slice(i, i + 1000).map(o => o.key));
  }
  return objects.reduce((n, o) => n + (o.size || 0), 0);
}

async function storageInfo(env) {
  const objects = await listAll(env.MEDIA);
  let bytes = 0;
  const groups = { uploads: 0, temp: 0, outputs: 0, jobs: 0, other: 0 };
  for (const o of objects) {
    bytes += o.size || 0;
    if (o.key.startsWith("uploads/")) groups.uploads += o.size || 0;
    else if (o.key.startsWith("temp/")) groups.temp += o.size || 0;
    else if (o.key.startsWith("outputs/")) groups.outputs += o.size || 0;
    else if (o.key.startsWith("_jobs/") || o.key.startsWith("_state/")) groups.jobs += o.size || 0;
    else groups.other += o.size || 0;
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
  const sorted = objects.sort((a, b) => String(b.uploaded).localeCompare(String(a.uploaded))).slice(0, 100);
  const jobs = [];
  for (const o of sorted) {
    const id = o.key.replace(/^_jobs\//, "").replace(/\.json$/, "");
    const j = await readJob(env, id);
    if (j) jobs.push(j);
  }
  return jobs;
}

async function triggerGitHub(env, eventType, payload) {
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
    body: JSON.stringify({ event_type: eventType, client_payload: payload }),
  });
  return { triggered: res.ok, status: res.status, detail: res.ok ? undefined : await res.text() };
}

function objectResponse(obj, filename) {
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("etag", obj.httpEtag);
  h.set("content-length", String(obj.size));
  h.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename || obj.key.split("/").pop())}`);
  return new Response(obj.body, { headers: h });
}

async function startMultipart(env, key, metadata = {}) {
  const upload = await env.MEDIA.createMultipartUpload(key, {
    httpMetadata: { contentType: metadata.type || "application/octet-stream" },
    customMetadata: metadata.customMetadata || {},
  });
  return { key, uploadId: upload.uploadId, partSize: MAX_PUBLIC_PART };
}

async function uploadPart(request, env, url) {
  const key = url.searchParams.get("key");
  const uploadId = url.searchParams.get("uploadId");
  const partNumber = Number(url.searchParams.get("partNumber"));
  if (!key || !uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return json({ error: "invalid upload params" }, 400);
  }
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_PUBLIC_PART) return json({ error: "part too large" }, 413);
  const upload = env.MEDIA.resumeMultipartUpload(key, uploadId);
  const part = await upload.uploadPart(partNumber, request.body);
  return json({ partNumber: part.partNumber, etag: part.etag });
}

async function completeMultipart(request, env) {
  const body = await request.json();
  if (!body.key || !body.uploadId || !Array.isArray(body.parts)) return json({ error: "invalid multipart body" }, 400);
  const upload = env.MEDIA.resumeMultipartUpload(body.key, body.uploadId);
  const result = await upload.complete(body.parts);
  return json({ ok: true, key: result.key, size: result.size, etag: result.etag });
}

async function handleInternal(request, env, url) {
  if (!workerAuthorized(request, env)) return json({ error: "worker unauthorized" }, 401);
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

  if (p === "/api/internal/file" && request.method === "GET") {
    const key = url.searchParams.get("key");
    if (!key) return json({ error: "missing key" }, 400);
    const obj = await env.MEDIA.get(key);
    return obj ? objectResponse(obj, key.split("/").pop()) : json({ error: "not found" }, 404);
  }

  if (p === "/api/internal/uploads/start" && request.method === "POST") {
    const body = await request.json();
    const key = String(body.key || "");
    if (!key || key.startsWith("_jobs/") || key.includes("..")) return json({ error: "invalid key" }, 400);
    return json(await startMultipart(env, key, { type: body.type || "application/octet-stream" }));
  }

  if (p === "/api/internal/uploads/part" && request.method === "PUT") return await uploadPart(request, env, url);
  if (p === "/api/internal/uploads/complete" && request.method === "POST") return await completeMultipart(request, env);

  if (p === "/api/internal/chunk-complete" && request.method === "POST") {
    const body = await request.json();
    const jobId = String(body.jobId || "");
    const index = Number(body.index);
    const total = Number(body.total);
    if (!jobId || !Number.isInteger(index) || !Number.isInteger(total) || total < 1) return json({ error: "invalid chunk state" }, 400);
    await env.MEDIA.put(`_state/${jobId}/chunks/${String(index).padStart(5, "0")}.json`, JSON.stringify({ index, at: new Date().toISOString() }));
    const done = await listAll(env.MEDIA, `_state/${jobId}/chunks/`);
    const completed = done.length;
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
      freedBytes += await deletePrefix(env.MEDIA, `temp/${job.id}/`);
      freedBytes += await deletePrefix(env.MEDIA, `_state/${job.id}/`);
      if (job.sourceType === "upload" && body.deleteSource === true && job.sourceKey) {
        const src = await env.MEDIA.head(job.sourceKey);
        if (src) freedBytes += src.size || 0;
        await env.MEDIA.delete(job.sourceKey);
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
  if (p === "/api/health") return json({ ok: true, app: env.APP_NAME || "Wuxia AI Dubbing", backend: "cloudflare-r2" });
  if (p.startsWith("/api/internal/")) return await handleInternal(request, env, url);
  if (!publicAuthorized(request, env, url)) return json({ error: "กรุณาใส่รหัสสำนัก" }, 401);

  if (p === "/api/storage" && request.method === "GET") {
    const info = await storageInfo(env);
    const limitGb = Number(env.FREE_STORAGE_GB || 10);
    return json({ ...info, limitBytes: limitGb * 1024 ** 3 });
  }

  if (p === "/api/files" && request.method === "GET") {
    const objects = await listAll(env.MEDIA);
    return json({ files: objects.filter(o => !o.key.startsWith("_jobs/") && !o.key.startsWith("_state/")).map(o => ({ key: o.key, size: o.size, uploaded: o.uploaded, etag: o.etag })) });
  }

  if (p === "/api/files/download" && request.method === "GET") {
    const key = url.searchParams.get("key");
    if (!key || key.startsWith("_jobs/") || key.startsWith("_state/")) return json({ error: "invalid key" }, 400);
    const obj = await env.MEDIA.get(key);
    return obj ? objectResponse(obj, key.split("/").pop()) : json({ error: "not found" }, 404);
  }

  if (p === "/api/files" && request.method === "DELETE") {
    const key = url.searchParams.get("key");
    if (!key || key.startsWith("_jobs/") || key.startsWith("_state/")) return json({ error: "invalid key" }, 400);
    await env.MEDIA.delete(key);
    return json({ ok: true, key });
  }

  if (p === "/api/uploads/start" && request.method === "POST") {
    const body = await request.json();
    const key = fileKey(body.name || "video.bin");
    return json(await startMultipart(env, key, {
      type: body.type || "application/octet-stream",
      customMetadata: { originalName: String(body.name || "video.bin"), declaredSize: String(body.size || 0) },
    }));
  }

  if (p === "/api/uploads/part" && request.method === "PUT") return await uploadPart(request, env, url);
  if (p === "/api/uploads/complete" && request.method === "POST") return await completeMultipart(request, env);

  if (p === "/api/uploads/abort" && request.method === "POST") {
    const body = await request.json();
    const upload = env.MEDIA.resumeMultipartUpload(body.key, body.uploadId);
    await upload.abort();
    return json({ ok: true });
  }

  if (p === "/api/jobs" && request.method === "GET") return json({ jobs: await listJobs(env) });

  if (p === "/api/jobs" && request.method === "POST") {
    const body = await request.json();
    if (body.sourceType === "upload" && !body.sourceKey) return json({ error: "missing uploaded file" }, 400);
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
    const dispatch = await triggerGitHub(env, "dubbing_job", { job_id: job.id, worker_base: workerBase });
    if (!dispatch.triggered) {
      job.stage = "รอตั้งค่า GitHub Actions";
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
      if (job) {
        const keys = [job.sourceKey, job.outputKey, job.subtitleKey].filter(Boolean);
        if (keys.length) await env.MEDIA.delete(keys);
        await deletePrefix(env.MEDIA, `temp/${id}/`);
        await deletePrefix(env.MEDIA, `_state/${id}/`);
      }
      await env.MEDIA.delete(`_jobs/${id}.json`);
      return json({ ok: true });
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
      const response = url.pathname.startsWith("/api/") ? await handleApi(request, env, url) : await env.ASSETS.fetch(request);
      return withCors(response, request, env);
    } catch (err) {
      return withCors(json({ error: err?.message || String(err) }, 500), request, env);
    }
  },
};
