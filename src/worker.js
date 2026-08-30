import {
  PUBLIC_PART_SIZE,
  INTERNAL_PART_SIZE,
  fileKey,
  ensureRoot,
  resolveLogical,
  listAppFiles,
  startResumable,
  uploadPublicChunk,
  uploadInternalChunk,
  uploadStatus,
  completeUpload,
  abortUpload,
  uploadSmallText,
  downloadLogicalResponse,
  deleteLogical,
  deletePrefix,
  storageInfo,
  readJob,
  writeJob,
  listJobs,
} from './storage.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function publicAuthorized(request, env, url) {
  const supplied = request.headers.get('x-access-key') || url.searchParams.get('access_key') || '';
  return Boolean(env.ACCESS_KEY && sameSecret(supplied, env.ACCESS_KEY));
}

function workerAuthorized(request, env) {
  const supplied = request.headers.get('x-worker-token') || '';
  return Boolean(env.WORKER_SHARED_TOKEN && sameSecret(supplied, env.WORKER_SHARED_TOKEN));
}

function originAllowed(request, env) {
  const origin = request.headers.get('origin') || '';
  if (!origin) return true;
  const own = new URL(request.url).origin;
  const allowed = new Set([own, 'https://flashdevnak.github.io', env.ALLOWED_ORIGIN || ''].filter(Boolean));
  return allowed.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function cors(request, env) {
  const origin = request.headers.get('origin') || '';
  const h = {
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,content-length,range,x-access-key,x-worker-token',
    'access-control-expose-headers': 'content-length,content-range,accept-ranges,etag',
    'access-control-max-age': '86400',
  };
  if (originAllowed(request, env) && origin) h['access-control-allow-origin'] = origin;
  return h;
}

function withCors(response, request, env) {
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors(request, env))) h.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}

function noStore(response) {
  const h = new Headers(response.headers);
  h.set('cache-control', 'no-store, no-cache, must-revalidate');
  h.set('pragma', 'no-cache');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}

function cleanProgress(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}

function stripModelText(value) {
  let text = String(value ?? '').trim();
  text = text.replace(/^```(?:json|text)?\s*/i, '').replace(/\s*```$/i, '').trim();
  text = text.replace(/^(?:translation|translated text|คำแปล)\s*:\s*/i, '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function extractAIText(value, depth = 0) {
  if (depth > 8 || value == null) return '';
  if (typeof value === 'string') return stripModelText(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractAIText(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    const preferred = ['response', 'text', 'content', 'generated_text', 'output_text', 'result', 'output', 'message', 'choices'];
    for (const key of preferred) {
      if (key in value) {
        const found = extractAIText(value[key], depth + 1);
        if (found) return found;
      }
    }
    for (const nested of Object.values(value)) {
      const found = extractAIText(nested, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

function parseTranslationValue(value, expectedCount, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (Array.isArray(value)) {
    if (value.length === expectedCount && value.every(x => ['string', 'number', 'boolean'].includes(typeof x))) {
      return value.map(x => String(x));
    }
    for (const item of value) {
      const nested = parseTranslationValue(item, expectedCount, depth + 1);
      if (nested) return nested;
    }
    return null;
  }
  if (typeof value === 'object') {
    const preferred = ['translations', 'response', 'result', 'output', 'text', 'content', 'generated_text', 'message', 'choices'];
    for (const key of preferred) {
      if (key in value) {
        const nested = parseTranslationValue(value[key], expectedCount, depth + 1);
        if (nested) return nested;
      }
    }
    for (const nestedValue of Object.values(value)) {
      const nested = parseTranslationValue(nestedValue, expectedCount, depth + 1);
      if (nested) return nested;
    }
    return null;
  }
  if (typeof value !== 'string') return null;

  const text = stripModelText(value);
  if (!text) return null;
  const candidates = [text];
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch && arrayMatch[0] !== text) candidates.push(arrayMatch[0]);
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch && objectMatch[0] !== text) candidates.push(objectMatch[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const normalized = parseTranslationValue(parsed, expectedCount, depth + 1);
      if (normalized) return normalized;
    } catch {}
  }

  if (expectedCount === 1) return [text];

  const lines = text.split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)\]:-]?)\s*/, '').trim())
    .filter(Boolean);
  if (lines.length === expectedCount) return lines;
  return null;
}

function modelName(env) {
  return env.TRANSLATE_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast';
}

async function runTranslationBatch(env, texts, sourceLang, targetLang) {
  const payload = {
    messages: [
      {
        role: 'system',
        content: 'Translate subtitle items faithfully and naturally. Preserve names, emotion and order. Output exactly one JSON object shaped like {"translations":["..."]}. No explanation or markdown.',
      },
      {
        role: 'user',
        content: JSON.stringify({ sourceLanguage: sourceLang || 'auto', targetLanguage: targetLang, texts }),
      },
    ],
    temperature: 0,
    max_tokens: 4096,
  };
  return env.AI.run(modelName(env), payload);
}

async function runSingleTranslation(env, text, sourceLang, targetLang) {
  const payload = {
    messages: [
      {
        role: 'system',
        content: `Translate one subtitle from ${sourceLang || 'auto'} to ${targetLang}. Return only the translated subtitle text. No label, quote, markdown or explanation.`,
      },
      { role: 'user', content: text },
    ],
    temperature: 0,
    max_tokens: 512,
  };
  const out = await env.AI.run(modelName(env), payload);
  return extractAIText(out);
}

async function translateWithAI(env, texts, sourceLang, targetLang) {
  if (!env.AI) throw new Error('Workers AI binding unavailable');
  if (sourceLang === targetLang) return texts;

  try {
    const batchOut = await runTranslationBatch(env, texts, sourceLang, targetLang);
    const translations = parseTranslationValue(batchOut, texts.length);
    if (translations && translations.every(x => String(x).trim())) return translations.map(x => String(x).trim());
  } catch (err) {
    console.warn('Workers AI batch translation failed; retrying per subtitle', err?.message || String(err));
  }

  const results = new Array(texts.length);
  let successful = 0;
  for (let start = 0; start < texts.length; start += 4) {
    const indexes = Array.from({ length: Math.min(4, texts.length - start) }, (_, i) => start + i);
    const values = await Promise.all(indexes.map(async idx => {
      const original = String(texts[idx] || '');
      if (!original.trim()) return '';
      try {
        const translated = await runSingleTranslation(env, original, sourceLang, targetLang);
        if (translated) {
          successful += 1;
          return translated;
        }
      } catch (err) {
        console.warn(`Workers AI single translation ${idx} failed`, err?.message || String(err));
      }
      return null;
    }));
    indexes.forEach((idx, i) => { results[idx] = values[i] ?? String(texts[idx] || ''); });
  }

  if (!successful && texts.some(x => String(x).trim())) throw new Error('Workers AI translation unavailable');
  return results;
}

function githubHeaders(env) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'wuxia-ai-dubbing-worker',
    'content-type': 'application/json',
  };
}

async function triggerGitHub(env, job, workerBase) {
  if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) return { triggered: false, reason: 'GitHub dispatch not configured' };
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: 'POST',
    headers: githubHeaders(env),
    body: JSON.stringify({ event_type: 'dubbing_job', client_payload: { job, workerBase } }),
  });
  return { triggered: res.ok, status: res.status, detail: res.ok ? undefined : await res.text() };
}

async function cancelGitHubRun(env, runId) {
  const id = Number(runId || 0);
  if (!id || !env.GITHUB_REPO || !env.GITHUB_TOKEN) return { requested: false, reason: 'run not registered' };
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/runs/${id}/cancel`, {
    method: 'POST',
    headers: githubHeaders(env),
  });
  return { requested: res.ok, status: res.status, detail: res.ok ? undefined : (await res.text()).slice(0, 500) };
}

async function handleInternal(request, env, url) {
  if (!workerAuthorized(request, env)) return json({ error: 'worker unauthorized' }, 401);
  const p = url.pathname;

  if (/^\/api\/internal\/jobs\/[^/]+$/.test(p)) {
    const id = decodeURIComponent(p.split('/').pop());
    if (request.method === 'GET') {
      const job = await readJob(env, id);
      return job ? json({ job }) : json({ error: 'not found' }, 404);
    }
    if (request.method === 'PATCH') {
      const current = await readJob(env, id);
      if (!current) return json({ error: 'not found' }, 404);
      const patch = await request.json();
      const paused = current.pauseRequested === true || current.status === 'paused';
      const allowed = ['status', 'stage', 'outputKey', 'subtitleKey', 'log', 'duration', 'sizeBytes', 'chunkTotal', 'error', 'runId', 'runAttempt'];
      for (const k of allowed) {
        if (!(k in patch)) continue;
        if (paused && (k === 'status' || k === 'stage') && patch[k] !== 'paused') continue;
        current[k] = patch[k];
      }
      if ('progress' in patch) current.progress = Math.max(cleanProgress(current.progress), cleanProgress(patch.progress));
      await writeJob(env, current);
      return json({ job: current });
    }
  }

  if (p === '/api/internal/exists' && request.method === 'GET') {
    const key = url.searchParams.get('key');
    if (!key) return json({ error: 'missing key' }, 400);
    const file = await resolveLogical(env, key);
    return json({
      exists: Boolean(file?.id),
      key,
      size: Number(file?.size || 0),
      modified: file?.modifiedTime || null,
    });
  }

  if (p === '/api/internal/file' && request.method === 'GET') {
    const key = url.searchParams.get('key');
    if (!key) return json({ error: 'missing key' }, 400);
    const result = await downloadLogicalResponse(request, env, key, false);
    return result.response || json(result.error, result.status);
  }

  if (p === '/api/internal/uploads/start' && request.method === 'POST') {
    const body = await request.json();
    const key = String(body.key || '');
    if (!key || key.startsWith('_jobs/') || key.includes('..')) return json({ error: 'invalid key' }, 400);
    return json(await startResumable(env, key, body.type || 'application/octet-stream', body.size ?? null, INTERNAL_PART_SIZE));
  }

  if (p === '/api/internal/uploads/part' && request.method === 'PUT') {
    const result = await uploadInternalChunk(request, env, url);
    return json(result.body, result.status);
  }

  if (p === '/api/internal/uploads/complete' && request.method === 'POST') {
    return json(await completeUpload(env, await request.json()));
  }

  if (p === '/api/internal/chunk-complete' && request.method === 'POST') {
    const body = await request.json();
    const jobId = String(body.jobId || '');
    const index = Number(body.index);
    const total = Number(body.total);
    if (!jobId || !Number.isInteger(index) || !Number.isInteger(total) || total < 1) return json({ error: 'invalid chunk state' }, 400);
    await uploadSmallText(env, `_state/${jobId}/chunks/${String(index).padStart(5, '0')}.json`, JSON.stringify({ index, at: new Date().toISOString() }), 'application/json');
    const files = await listAppFiles(env);
    const completed = files.filter(f => String(f.appProperties?.logicalKey || '').startsWith(`_state/${jobId}/chunks/`)).length;
    const job = await readJob(env, jobId);
    if (job) {
      const computed = Math.min(92, Math.round(28 + (completed / total) * 62));
      job.progress = Math.max(cleanProgress(job.progress), computed);
      if (job.pauseRequested === true || job.status === 'paused') {
        job.status = 'paused';
        job.stage = 'หยุดชั่วคราว';
      } else {
        job.status = 'processing';
        job.stage = completed >= total ? 'พากย์ครบแล้ว กำลังรวมวิดีโอ' : `พากย์เสร็จ ${completed}/${total} ช่วง`;
      }
      await writeJob(env, job);
    }
    return json({ ok: true, completed, total, allDone: completed >= total });
  }

  if (p === '/api/internal/translate' && request.method === 'POST') {
    const body = await request.json();
    const texts = Array.isArray(body.texts) ? body.texts.map(x => String(x)) : [];
    if (!texts.length || texts.length > 20) return json({ error: 'invalid translation batch' }, 400);
    const translations = await translateWithAI(env, texts, String(body.sourceLang || 'auto'), String(body.targetLang || 'th'));
    return json({ translations });
  }

  if (p === '/api/internal/complete' && request.method === 'POST') {
    const body = await request.json();
    const job = await readJob(env, body.jobId);
    if (!job) return json({ error: 'not found' }, 404);
    job.status = 'completed';
    job.pauseRequested = false;
    job.progress = 100;
    job.stage = 'เสร็จสมบูรณ์';
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
      if (job.sourceType === 'upload' && body.deleteSource === true && job.sourceKey) {
        freedBytes += await deleteLogical(env, job.sourceKey);
        job.sourceKey = null;
        await writeJob(env, job);
      }
    }
    return json({ ok: true, job, freedBytes });
  }

  if (p === '/api/internal/fail' && request.method === 'POST') {
    const body = await request.json();
    const job = await readJob(env, body.jobId);
    if (!job) return json({ error: 'not found' }, 404);
    if (job.pauseRequested === true || job.status === 'paused') {
      job.status = 'paused';
      job.stage = 'หยุดชั่วคราว';
      await writeJob(env, job);
      return json({ ok: true, paused: true });
    }
    job.status = 'failed';
    job.progress = Math.max(3, cleanProgress(job.progress));
    job.stage = 'ประมวลผลไม่สำเร็จ';
    job.error = String(body.error || 'unknown error').slice(0, 1800);
    await writeJob(env, job);
    return json({ ok: true });
  }

  return json({ error: 'internal route not found' }, 404);
}

async function handleApi(request, env, url) {
  const p = url.pathname;

  if (p === '/api/health') {
    let driveReady = false;
    let detail = null;
    try {
      await ensureRoot(env);
      driveReady = true;
    } catch (err) {
      detail = err?.message || String(err);
    }
    return json({
      ok: true,
      app: env.APP_NAME || 'Wuxia AI Dubbing',
      backend: 'google-drive',
      core: 'clean-v2.2',
      uploadMode: 'same-origin-multipart',
      publicPartSize: PUBLIC_PART_SIZE,
      driveReady,
      detail,
    });
  }

  if (p.startsWith('/api/internal/')) return handleInternal(request, env, url);
  if (!publicAuthorized(request, env, url)) return json({ error: 'กรุณาใส่รหัสสำนัก' }, 401);

  if (p === '/api/storage' && request.method === 'GET') return json(await storageInfo(env));

  if (p === '/api/files' && request.method === 'GET') {
    const files = await listAppFiles(env);
    const visible = files
      .map(f => ({
        key: String(f.appProperties?.logicalKey || ''),
        size: Number(f.size || 0),
        uploaded: f.createdTime,
        modified: f.modifiedTime,
        fileId: f.id,
      }))
      .filter(f => f.key && !f.key.startsWith('_jobs/') && !f.key.startsWith('_state/'));
    return json({ files: visible });
  }

  if (p === '/api/files/download' && request.method === 'GET') {
    const key = url.searchParams.get('key');
    if (!key || key.startsWith('_jobs/') || key.startsWith('_state/')) return json({ error: 'invalid key' }, 400);
    const result = await downloadLogicalResponse(request, env, key, true);
    return result.response || json(result.error, result.status);
  }

  if (p === '/api/files' && request.method === 'DELETE') {
    const key = url.searchParams.get('key');
    if (!key || key.startsWith('_jobs/') || key.startsWith('_state/')) return json({ error: 'invalid key' }, 400);
    const freedBytes = await deleteLogical(env, key);
    return json({ ok: true, key, freedBytes });
  }

  if (p === '/api/uploads/start' && request.method === 'POST') {
    const body = await request.json();
    const size = Number(body.size || 0);
    if (!Number.isFinite(size) || size <= 0) return json({ error: 'invalid file size' }, 400);
    const key = fileKey(body.name || 'video.bin');
    return json(await startResumable(env, key, body.type || 'application/octet-stream', size, PUBLIC_PART_SIZE));
  }

  if (p === '/api/uploads/chunk' && request.method === 'POST') {
    const result = await uploadPublicChunk(request, env);
    return json(result.body, result.status);
  }

  if (p === '/api/uploads/status' && request.method === 'POST') return json(await uploadStatus(env, await request.json()));
  if (p === '/api/uploads/complete' && request.method === 'POST') return json(await completeUpload(env, await request.json()));
  if (p === '/api/uploads/abort' && request.method === 'POST') return json(await abortUpload(env, await request.json()));

  if (p === '/api/jobs' && request.method === 'GET') return json({ jobs: await listJobs(env) });

  if (p === '/api/jobs' && request.method === 'POST') {
    const body = await request.json();
    if (body.sourceType === 'upload') {
      if (!body.sourceKey) return json({ error: 'missing uploaded file' }, 400);
      const src = await resolveLogical(env, body.sourceKey);
      if (!src) return json({ error: 'uploaded file not found' }, 404);
    }
    if (body.sourceType === 'link' && !/^https?:\/\//i.test(body.sourceUrl || '')) return json({ error: 'invalid source url' }, 400);
    const job = {
      id: crypto.randomUUID(),
      title: body.title || 'งานพากย์ใหม่',
      sourceType: body.sourceType || 'upload',
      sourceKey: body.sourceKey || null,
      sourceUrl: body.sourceUrl || null,
      sourceLang: body.sourceLang || 'auto',
      targetLang: body.targetLang || 'th',
      voiceMode: body.voiceMode || 'auto',
      processingMode: ['fast', 'balanced', 'quality'].includes(body.processingMode) ? body.processingMode : 'fast',
      subtitles: body.subtitles !== false,
      keepMusic: body.keepMusic !== false,
      speakerSeparation: body.speakerSeparation === true,
      autoCleanup: body.autoCleanup !== false,
      pauseRequested: false,
      retryCount: 0,
      status: 'queued',
      progress: 3,
      stage: 'เข้าคิวประมวลผล',
      createdAt: new Date().toISOString(),
    };
    await writeJob(env, job);
    const workerBase = `${url.protocol}//${url.host}`;
    const dispatch = await triggerGitHub(env, job, workerBase);
    if (!dispatch.triggered) {
      job.stage = 'ยังเริ่มประมวลผลไม่ได้';
      job.error = dispatch.detail || dispatch.reason || null;
      await writeJob(env, job);
    }
    return json({ job, dispatch }, 201);
  }

  const control = p.match(/^\/api\/jobs\/([^/]+)\/(pause|resume|retry)$/);
  if (control && request.method === 'POST') {
    const id = decodeURIComponent(control[1]);
    const action = control[2];
    const job = await readJob(env, id);
    if (!job) return json({ error: 'ไม่พบงานนี้' }, 404);
    if (job.status === 'completed') return json({ error: 'งานนี้เสร็จแล้ว' }, 409);

    if (action === 'pause') {
      if (job.status === 'failed') return json({ error: 'งานนี้หยุดอยู่แล้ว ให้กดลองใหม่แทน' }, 409);
      job.pauseRequested = true;
      job.status = 'paused';
      job.stage = 'หยุดชั่วคราว';
      await writeJob(env, job);
      const cancel = await cancelGitHubRun(env, job.runId);
      return json({ ok: true, job, cancel });
    }

    if (job.sourceType === 'upload' && job.sourceKey) {
      const src = await resolveLogical(env, job.sourceKey);
      if (!src) {
        const total = Number(job.chunkTotal || 0);
        let recoveryReady = Number.isInteger(total) && total > 0;
        if (recoveryReady) {
          const files = await listAppFiles(env);
          const keys = new Set(files.map(f => String(f.appProperties?.logicalKey || '')));
          for (let i = 0; i < total; i++) {
            const n = String(i).padStart(5, '0');
            const required = [
              `temp/${job.id}/dub/chunk_${n}.ts`,
              `temp/${job.id}/meta/chunk_${n}.json`,
              `_state/${job.id}/chunks/${n}.json`,
            ];
            if (job.subtitles !== false) required.push(`temp/${job.id}/subs/chunk_${n}.srt`);
            if (!required.every(key => keys.has(key))) {
              recoveryReady = false;
              break;
            }
          }
        }
        if (!recoveryReady) {
          return json({ error: 'ไฟล์ต้นฉบับถูกลบแล้ว และไฟล์ที่ทำไว้ยังไม่ครบ กรุณาอัปโหลดต้นฉบับใหม่' }, 409);
        }
      }
    }

    job.pauseRequested = false;
    job.status = 'queued';
    job.error = null;
    job.runId = null;
    job.runAttempt = null;
    job.retryCount = Number(job.retryCount || 0) + 1;
    job.stage = action === 'retry' ? 'กำลังลองใหม่จากจุดล่าสุด' : 'กำลังทำต่อจากจุดล่าสุด';
    await writeJob(env, job);
    const workerBase = `${url.protocol}//${url.host}`;
    const dispatch = await triggerGitHub(env, job, workerBase);
    if (!dispatch.triggered) {
      job.status = 'failed';
      job.stage = 'เริ่มงานต่อไม่สำเร็จ';
      job.error = dispatch.detail || dispatch.reason || 'ส่งงานไป GitHub Actions ไม่สำเร็จ';
      await writeJob(env, job);
    }
    return json({ ok: dispatch.triggered, job, dispatch }, dispatch.triggered ? 200 : 502);
  }

  if (/^\/api\/jobs\/[^/]+$/.test(p)) {
    const id = decodeURIComponent(p.split('/').pop());
    if (request.method === 'GET') {
      const job = await readJob(env, id);
      return job ? json({ job }) : json({ error: 'not found' }, 404);
    }
    if (request.method === 'DELETE') {
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

  if (p === '/api/cleanup/temp' && request.method === 'POST') {
    const result = await deletePrefix(env, 'temp/');
    return json({ ok: true, freedBytes: result.bytes, deleted: result.count });
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      if (!originAllowed(request, env)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors(request, env) });
    }
    try {
      let response;
      if (url.pathname.startsWith('/api/')) {
        response = await handleApi(request, env, url);
      } else {
        response = await env.ASSETS.fetch(request);
        if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/app.js' || url.pathname === '/styles.css') response = noStore(response);
      }
      return withCors(response, request, env);
    } catch (err) {
      console.error('worker error', err);
      return withCors(json({ error: err?.message || String(err) }, 500), request, env);
    }
  },
};