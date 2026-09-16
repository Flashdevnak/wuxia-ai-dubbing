import fullWorker from './worker-full.js';
import { deleteLogical, readJob, resolveLogical, writeJob } from './storage.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function publicAuthorized(request, env, url) {
  const supplied = request.headers.get('x-access-key') || url.searchParams.get('access_key') || '';
  return Boolean(env.ACCESS_KEY && sameSecret(supplied, env.ACCESS_KEY));
}

function workerAuthorized(request, env) {
  return Boolean(env.WORKER_SHARED_TOKEN && sameSecret(request.headers.get('x-worker-token') || '', env.WORKER_SHARED_TOKEN));
}

function cleanText(value, max = 120) {
  return String(value || '').trim().slice(0, max);
}

function cleanInt(value, fallback = 1, min = 1, max = 9999) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
}

function cleanGlossary(value) {
  const out = {};
  const source = Array.isArray(value)
    ? Object.fromEntries(value.filter(x => x && typeof x === 'object').map(x => [x.source, x.target]))
    : (value && typeof value === 'object' ? value : {});
  for (const [from, to] of Object.entries(source)) {
    const a = cleanText(from, 80);
    const b = cleanText(to, 120);
    if (a && b) out[a] = b;
    if (Object.keys(out).length >= 120) break;
  }
  return out;
}

function r3Fields(body = {}) {
  return {
    r3Enabled: body.r3Enabled !== false,
    r3Version: 3,
    series: cleanText(body.series, 120),
    season: cleanInt(body.season, 1),
    episode: cleanInt(body.episode, 1),
    glossary: cleanGlossary(body.glossary),
    r3ContextTranslation: body.r3ContextTranslation !== false,
    r3TimingRescue: body.r3TimingRescue !== false,
    r3QualityGate: body.r3QualityGate !== false,
    r3Cache: body.r3Cache !== false,
    batchGroup: cleanText(body.batchGroup, 80) || null,
    batchPosition: Number.isFinite(Number(body.batchPosition)) ? Math.max(0, Math.trunc(Number(body.batchPosition))) : null,
  };
}

async function enrichJob(env, id, body = {}) {
  const job = await readJob(env, id);
  if (!job) return null;
  Object.assign(job, r3Fields(body));
  job.r3UpdatedAt = new Date().toISOString();
  await writeJob(env, job);
  return job;
}

function githubHeaders(env) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'wuxia-ai-dubbing-r3',
    'content-type': 'application/json',
  };
}

async function dispatchDubbing(env, job, workerBase) {
  if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) return { triggered: false, reason: 'GitHub dispatch not configured' };
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: 'POST',
    headers: githubHeaders(env),
    body: JSON.stringify({ event_type: 'dubbing_job', client_payload: { job, workerBase } }),
  });
  return { triggered: res.ok, status: res.status, detail: res.ok ? undefined : (await res.text()).slice(0, 1000) };
}

async function createOneJob(request, env, ctx, url, body) {
  const headers = new Headers(request.headers);
  headers.set('content-type', 'application/json');
  const forwarded = new Request(new URL('/api/jobs', url.origin), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const response = await fullWorker.fetch(forwarded, env, ctx);
  if (!response.ok) return { response, data: null };
  const data = await response.clone().json();
  if (data?.job?.id) data.job = await enrichJob(env, data.job.id, body) || data.job;
  return {
    response: new Response(JSON.stringify(data), { status: response.status, headers: response.headers }),
    data,
  };
}

async function handleBatch(request, env, ctx, url) {
  if (!publicAuthorized(request, env, url)) return json({ error: 'unauthorized' }, 401);
  const body = await request.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length || items.length > 10) return json({ error: 'batch ต้องมี 1–10 งาน' }, 400);
  const batchGroup = crypto.randomUUID();
  const results = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] && typeof items[i] === 'object' ? items[i] : {};
    const payload = {
      ...item,
      title: item.title || `งานพากย์ชุด ${i + 1}/${items.length}`,
      sourceType: item.sourceType || (item.sourceKey ? 'upload' : 'link'),
      batchGroup,
      batchPosition: i,
      r3Enabled: true,
    };
    const created = await createOneJob(request, env, ctx, url, payload);
    const data = created.data || await created.response.clone().json().catch(() => ({}));
    results.push({ index: i, ok: created.response.ok, status: created.response.status, job: data.job || null, dispatch: data.dispatch || null, error: data.error || null });
  }
  return json({ ok: results.every(x => x.ok), batchGroup, count: results.length, results }, results.every(x => x.ok) ? 201 : 207);
}

async function handleRepair(request, env, url, id) {
  if (!publicAuthorized(request, env, url)) return json({ error: 'unauthorized' }, 401);
  const job = await readJob(env, id);
  if (!job) return json({ error: 'ไม่พบงาน' }, 404);
  if (job.jobType !== 'dubbing') return json({ error: 'ซ่อมได้เฉพาะงานพากย์' }, 400);
  const body = await request.json().catch(() => ({}));
  const allowed = new Set(['retranslate', 'change_voice', 'slower', 'faster', 'edit_text']);
  const action = String(body.action || 'retranslate');
  if (!allowed.has(action)) return json({ error: 'repair action ไม่รองรับ' }, 400);
  const total = Math.max(1, Number(job.chunkTotal || 1));
  const requested = Array.isArray(body.chunks) ? body.chunks : [body.chunk ?? 0];
  const chunks = [...new Set(requested.map(Number).filter(Number.isFinite).map(x => Math.trunc(x)).filter(x => x >= 0 && x < total))].sort((a, b) => a - b);
  if (!chunks.length) return json({ error: 'ไม่พบช่วงที่ต้องซ่อม' }, 400);

  for (const index of chunks) {
    const n = String(index).padStart(5, '0');
    const keys = [
      `_state/${id}/chunks/${n}.json`,
      `temp/${id}/dub/chunk_${n}.ts`,
      `temp/${id}/subs/chunk_${n}.srt`,
      `temp/${id}/meta/chunk_${n}.json`,
    ];
    if (action === 'retranslate' || action === 'edit_text') keys.push(`_state/${id}/r3/translation_${n}.json`);
    for (const key of keys) {
      try { await deleteLogical(env, key); } catch {}
    }
  }

  job.r3Enabled = true;
  job.r3Version = 3;
  job.r3Repair = {
    action,
    chunks,
    value: cleanText(body.value, 500) || null,
    requestedAt: new Date().toISOString(),
  };
  job.status = 'queued';
  job.pauseRequested = false;
  job.error = null;
  job.progress = Math.min(90, Math.max(8, Number(job.progress || 8)));
  job.stage = `เข้าคิวซ่อมเฉพาะช่วง ${chunks.map(x => x + 1).join(', ')}`;
  job.retryCount = Number(job.retryCount || 0) + 1;
  await writeJob(env, job);
  const dispatch = await dispatchDubbing(env, job, url.origin);
  if (!dispatch.triggered) {
    job.status = 'failed';
    job.stage = 'ส่งงานซ่อมไม่สำเร็จ';
    job.error = dispatch.detail || dispatch.reason || 'GitHub dispatch failed';
    await writeJob(env, job);
  }
  return json({ ok: dispatch.triggered, job, dispatch }, dispatch.triggered ? 202 : 502);
}

async function handleInternalComplete(request, env, ctx, url) {
  if (!workerAuthorized(request, env)) return json({ error: 'worker unauthorized' }, 401);
  const body = await request.clone().json().catch(() => ({}));
  const id = cleanText(body.jobId, 100);
  const job = id ? await readJob(env, id) : null;
  if (!job) return json({ error: 'R3 Quality Gate: job not found' }, 404);

  const errors = [];
  const outputKey = String(body.outputKey || '');
  const duration = Number(body.duration || 0);
  const sizeBytes = Number(body.sizeBytes || 0);
  if (!outputKey.startsWith(`outputs/${id}/`)) errors.push('output_key_invalid');
  if (!(duration > 0)) errors.push('duration_invalid');
  if (!(sizeBytes > 0)) errors.push('output_size_invalid');
  const output = outputKey ? await resolveLogical(env, outputKey) : null;
  if (!output?.id || Number(output.size || 0) <= 0) errors.push('output_missing');

  const total = Math.max(0, Number(job.chunkTotal || 0));
  if (total <= 0) errors.push('chunk_total_invalid');
  const missing = [];
  for (let i = 0; i < total; i += 1) {
    const n = String(i).padStart(5, '0');
    const [checkpoint, meta, chunk] = await Promise.all([
      resolveLogical(env, `_state/${id}/chunks/${n}.json`),
      resolveLogical(env, `temp/${id}/meta/chunk_${n}.json`),
      resolveLogical(env, `temp/${id}/dub/chunk_${n}.ts`),
    ]);
    if (!checkpoint?.id || !meta?.id || !chunk?.id || Number(chunk?.size || 0) <= 0) missing.push(i);
  }
  if (missing.length) errors.push(`chunks_missing:${missing.slice(0, 30).join(',')}`);
  if (job.subtitles !== false && !body.subtitleKey) errors.push('subtitle_missing');

  if (errors.length) {
    job.r3FinalGate = { status: 'failed', errors, checkedAt: new Date().toISOString() };
    await writeJob(env, job);
    return json({ error: 'R3 Quality Gate ไม่ผ่าน', errors }, 409);
  }

  job.r3FinalGate = {
    status: 'pass',
    errors: [],
    checkedAt: new Date().toISOString(),
    chunks: total,
    duration,
    sizeBytes: Math.max(sizeBytes, Number(output?.size || 0)),
  };
  await writeJob(env, job);
  return fullWorker.fetch(request, env, ctx);
}

async function enrichHealth(response) {
  if (!response.ok) return response;
  const data = await response.clone().json().catch(() => null);
  if (!data) return response;
  Object.assign(data, {
    r3SmartStudio: true,
    r3Version: 3,
    contextTranslation: true,
    glossaryMemory: true,
    deterministicCasting: true,
    timingRescue: true,
    qualityGate: true,
    finalQualityGate: true,
    segmentRepair: true,
    batchQueue: true,
    quotaCacheGuard: true,
  });
  return new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
}

async function injectR3(response) {
  if (!response.ok || !String(response.headers.get('content-type') || '').includes('text/html')) return response;
  let html = await response.text();
  if (!html.includes('r3-studio.css')) html = html.replace('</head>', '  <link rel="stylesheet" href="./r3-studio.css?v=r3-1" />\n</head>');
  if (!html.includes('r3-studio.js')) html = html.replace('</body>', '  <script src="./r3-studio.js?v=r3-1" defer></script>\n</body>');
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  return new Response(html, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const repair = url.pathname.match(/^\/api\/r3\/jobs\/([^/]+)\/repair$/);
    if (repair && request.method === 'POST') return handleRepair(request, env, url, decodeURIComponent(repair[1]));
    if (url.pathname === '/api/r3/batch' && request.method === 'POST') return handleBatch(request, env, ctx, url);
    if (url.pathname === '/api/internal/r3/job' && request.method === 'GET') {
      if (!workerAuthorized(request, env)) return json({ error: 'worker unauthorized' }, 401);
      const id = url.searchParams.get('id') || '';
      const job = await readJob(env, id);
      return job ? json({ job }) : json({ error: 'not found' }, 404);
    }
    if (url.pathname === '/api/internal/complete' && request.method === 'POST') return handleInternalComplete(request, env, ctx, url);

    if (url.pathname === '/api/jobs' && request.method === 'POST') {
      const body = await request.clone().json().catch(() => ({}));
      const created = await createOneJob(request, env, ctx, url, body);
      return created.response;
    }

    let response = await fullWorker.fetch(request, env, ctx);
    if (request.method === 'GET' && url.pathname === '/api/health') response = await enrichHealth(response);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) response = await injectR3(response);
    return response;
  },

  async scheduled(controller, env, ctx) {
    return fullWorker.scheduled(controller, env, ctx);
  },
};
