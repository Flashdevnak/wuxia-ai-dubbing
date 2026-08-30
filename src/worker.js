const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function safeName(name = "video.bin") {
  return name.replace(/[^a-zA-Z0-9._\-ก-๙一-龥ぁ-んァ-ヶ가-힣]+/g, "_").slice(0, 180);
}

function fileKey(name) {
  const d = new Date();
  const stamp = d.toISOString().replace(/[:.]/g, "-");
  return `uploads/${stamp}-${crypto.randomUUID()}-${safeName(name)}`;
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

async function storageInfo(env) {
  const objects = await listAll(env.MEDIA);
  let bytes = 0;
  const groups = { uploads: 0, temp: 0, outputs: 0, jobs: 0, other: 0 };
  for (const o of objects) {
    bytes += o.size || 0;
    if (o.key.startsWith("uploads/")) groups.uploads += o.size || 0;
    else if (o.key.startsWith("temp/")) groups.temp += o.size || 0;
    else if (o.key.startsWith("outputs/")) groups.outputs += o.size || 0;
    else if (o.key.startsWith("_jobs/")) groups.jobs += o.size || 0;
    else groups.other += o.size || 0;
  }
  return { bytes, groups, objectCount: objects.length };
}

async function readJob(env, id) {
  const obj = await env.MEDIA.get(`_jobs/${id}.json`);
  if (!obj) return null;
  return await obj.json();
}

async function writeJob(env, job) {
  job.updatedAt = new Date().toISOString();
  await env.MEDIA.put(`_jobs/${job.id}.json`, JSON.stringify(job), {
    httpMetadata: { contentType: "application/json" }
  });
  return job;
}

async function listJobs(env) {
  const objects = await listAll(env.MEDIA, "_jobs/");
  const jobs = [];
  for (const o of objects.sort((a,b)=>String(b.uploaded).localeCompare(String(a.uploaded))).slice(0, 100)) {
    const j = await readJob(env, o.key.replace(/^_jobs\//, "").replace(/\.json$/, ""));
    if (j) jobs.push(j);
  }
  return jobs;
}

async function triggerGitHub(env, job) {
  if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) return { triggered: false, reason: "GitHub dispatch not configured" };
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "wuxia-ai-dubbing-worker"
    },
    body: JSON.stringify({ event_type: "dubbing_job", client_payload: { job } })
  });
  return { triggered: res.ok, status: res.status };
}

async function handleApi(request, env, url) {
  const p = url.pathname;
  if (p === "/api/health") return json({ ok: true, app: env.APP_NAME || "Wuxia AI Dubbing" });

  if (p === "/api/storage" && request.method === "GET") {
    const info = await storageInfo(env);
    const limitGb = Number(env.FREE_STORAGE_GB || 10);
    return json({ ...info, limitBytes: limitGb * 1024 ** 3 });
  }

  if (p === "/api/files" && request.method === "GET") {
    const objects = await listAll(env.MEDIA);
    return json({ files: objects.filter(o => !o.key.startsWith("_jobs/")).map(o => ({ key:o.key, size:o.size, uploaded:o.uploaded, etag:o.etag })) });
  }

  if (p === "/api/files" && request.method === "DELETE") {
    const key = url.searchParams.get("key");
    if (!key || key.startsWith("_jobs/")) return json({ error: "invalid key" }, 400);
    await env.MEDIA.delete(key);
    return json({ ok: true, key });
  }

  if (p === "/api/uploads/start" && request.method === "POST") {
    const body = await request.json();
    const key = fileKey(body.name || "video.bin");
    const upload = await env.MEDIA.createMultipartUpload(key, {
      httpMetadata: { contentType: body.type || "application/octet-stream" },
      customMetadata: { originalName: String(body.name || "video.bin"), declaredSize: String(body.size || 0) }
    });
    return json({ key, uploadId: upload.uploadId, partSize: 8 * 1024 * 1024 });
  }

  if (p === "/api/uploads/part" && request.method === "PUT") {
    const key = url.searchParams.get("key");
    const uploadId = url.searchParams.get("uploadId");
    const partNumber = Number(url.searchParams.get("partNumber"));
    if (!key || !uploadId || !Number.isInteger(partNumber) || partNumber < 1) return json({ error: "invalid upload params" }, 400);
    const upload = env.MEDIA.resumeMultipartUpload(key, uploadId);
    const part = await upload.uploadPart(partNumber, request.body);
    return json({ partNumber: part.partNumber, etag: part.etag });
  }

  if (p === "/api/uploads/complete" && request.method === "POST") {
    const body = await request.json();
    const upload = env.MEDIA.resumeMultipartUpload(body.key, body.uploadId);
    const result = await upload.complete(body.parts || []);
    return json({ ok: true, key: result.key, size: result.size, etag: result.etag });
  }

  if (p === "/api/uploads/abort" && request.method === "POST") {
    const body = await request.json();
    const upload = env.MEDIA.resumeMultipartUpload(body.key, body.uploadId);
    await upload.abort();
    return json({ ok: true });
  }

  if (p === "/api/jobs" && request.method === "GET") return json({ jobs: await listJobs(env) });

  if (p === "/api/jobs" && request.method === "POST") {
    const body = await request.json();
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
      progress: 0,
      stage: "เข้าคิวประมวลผล",
      createdAt: new Date().toISOString()
    };
    await writeJob(env, job);
    const dispatch = await triggerGitHub(env, job);
    return json({ job, dispatch }, 201);
  }

  if (/^\/api\/jobs\/[^/]+$/.test(p)) {
    const id = p.split("/").pop();
    if (request.method === "GET") {
      const job = await readJob(env, id);
      return job ? json({ job }) : json({ error: "not found" }, 404);
    }
    if (request.method === "PATCH") {
      const current = await readJob(env, id);
      if (!current) return json({ error: "not found" }, 404);
      const patch = await request.json();
      const allowed = ["status","progress","stage","outputKey","subtitleKey","log","duration","sizeBytes"];
      for (const k of allowed) if (k in patch) current[k] = patch[k];
      await writeJob(env, current);
      return json({ job: current });
    }
    if (request.method === "DELETE") {
      const job = await readJob(env, id);
      if (job) {
        const keys = [job.sourceKey, job.outputKey, job.subtitleKey].filter(Boolean);
        if (keys.length) await env.MEDIA.delete(keys);
      }
      await env.MEDIA.delete(`_jobs/${id}.json`);
      return json({ ok: true });
    }
  }

  if (p === "/api/cleanup/temp" && request.method === "POST") {
    const temp = await listAll(env.MEDIA, "temp/");
    for (let i = 0; i < temp.length; i += 1000) await env.MEDIA.delete(temp.slice(i, i + 1000).map(o => o.key));
    return json({ ok: true, deleted: temp.length });
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: err?.message || String(err) }, 500);
    }
  }
};
