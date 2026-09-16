import fastWorker from './worker-fast.js';
import {
  deleteLogical,
  deletePrefix,
  listJobs,
  readJob,
  resolveLogical,
  writeJob,
} from './storage.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function cleanText(value, max = 600) {
  return String(value || '').trim().slice(0, max);
}

function githubHeaders(env) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'wuxia-ai-dubbing-storage-cleanup',
  };
}

async function cancelRun(env, runId) {
  const id = Number(runId || 0);
  if (!id || !env.GITHUB_REPO || !env.GITHUB_TOKEN) return false;
  try {
    const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/runs/${id}/cancel`, {
      method: 'POST',
      headers: githubHeaders(env),
    });
    return response.ok || response.status === 409;
  } catch {
    return false;
  }
}

async function purgePrefixCompletely(env, prefix, maxRounds = 120) {
  let bytes = 0;
  let count = 0;
  let remaining = 0;
  let rounds = 0;
  do {
    const result = await deletePrefix(env, prefix, 100);
    bytes += Number(result.bytes || 0);
    count += Number(result.count || 0);
    remaining = Number(result.remaining || 0);
    rounds += 1;
  } while (remaining > 0 && rounds < maxRounds);
  return { bytes, count, remaining, rounds };
}

async function purgePrefixes(env, prefixes) {
  let freedBytes = 0;
  let deleted = 0;
  let remaining = 0;
  for (const prefix of prefixes) {
    const result = await purgePrefixCompletely(env, prefix);
    freedBytes += result.bytes;
    deleted += result.count;
    remaining += result.remaining;
  }
  return { freedBytes, deleted, remaining };
}

function cleanupPrefixes(kind) {
  if (kind === 'uploads') return ['uploads/'];
  if (kind === 'temp') return ['temp/', '_state/'];
  if (kind === 'outputs') return ['outputs/'];
  return ['uploads/', 'temp/', 'outputs/', '_state/', '_jobs/', '__wuxia_internal/multipart/'];
}

function activeJob(job) {
  return ['queued', 'processing', 'paused'].includes(String(job?.status || ''));
}

async function prepareJobsForCleanup(env, jobs, kind) {
  let cancellationRequests = 0;
  let affectedJobs = 0;
  for (const job of jobs) {
    if (!job?.id) continue;
    const touchesSource = kind === 'uploads' || kind === 'all';
    const touchesTemp = kind === 'temp' || kind === 'all';
    const touchesOutputs = kind === 'outputs' || kind === 'all';

    if ((touchesSource || touchesTemp) && activeJob(job)) {
      job.pauseRequested = true;
      job.status = 'paused';
      job.stage = kind === 'all' ? 'กำลังหยุดเพื่อล้างพื้นที่ทั้งหมด' : 'หยุดเพื่อล้างพื้นที่';
      if (job.runId && await cancelRun(env, job.runId)) cancellationRequests += 1;
      affectedJobs += 1;
      if (kind !== 'all') await writeJob(env, job);
      continue;
    }

    if (touchesTemp && kind !== 'all' && String(job.status || '') === 'failed') {
      job.pauseRequested = false;
      job.stage = 'ล้างไฟล์ชั่วคราวแล้ว · ลองใหม่จะเริ่มจากต้นฉบับ';
      job.chunkTotal = null;
      await writeJob(env, job);
      affectedJobs += 1;
    }

    if (touchesSource && kind !== 'all' && (job.sourceKey || job.sourceAudioKey)) {
      job.pauseRequested = true;
      job.status = 'failed';
      job.stage = 'ไฟล์ต้นฉบับถูกลบแล้ว';
      job.error = 'ไฟล์ต้นฉบับถูกลบจากพื้นที่ใช้งาน หากต้องการทำงานนี้อีกครั้ง กรุณาอัปโหลดไฟล์ใหม่';
      await writeJob(env, job);
      affectedJobs += 1;
    }

    if (touchesOutputs && kind !== 'all' && (job.outputKey || job.subtitleKey || job.transcriptXmlKey)) {
      job.outputKey = null;
      job.subtitleKey = null;
      job.transcriptXmlKey = null;
      if (job.status === 'completed') job.stage = 'ผลลัพธ์ถูกลบออกจากพื้นที่แล้ว';
      await writeJob(env, job);
      affectedJobs += 1;
    }
  }
  return { cancellationRequests, affectedJobs };
}

async function cleanupWorkspace(request, env, ctx, url, kind) {
  if (!publicAuthorized(request, env, url)) return json({ error: 'กรุณาใส่รหัสสำนัก' }, 401);
  const jobs = await listJobs(env);
  const prepared = await prepareJobsForCleanup(env, jobs, kind);
  const result = await purgePrefixes(env, cleanupPrefixes(kind));

  if (kind === 'all' && ctx?.waitUntil) {
    ctx.waitUntil((async () => {
      await new Promise(resolve => setTimeout(resolve, 2500));
      await purgePrefixes(env, cleanupPrefixes('all')).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 6500));
      await purgePrefixes(env, cleanupPrefixes('all')).catch(() => {});
    })());
  }

  return json({
    ok: result.remaining === 0,
    kind,
    freedBytes: result.freedBytes,
    deleted: result.deleted,
    remaining: result.remaining,
    affectedJobs: prepared.affectedJobs,
    cancellationRequests: prepared.cancellationRequests,
    workspacePurged: kind === 'all' && result.remaining === 0,
  });
}

async function attachAudio(env, jobId, body = {}) {
  const job = await readJob(env, jobId);
  if (!job) return { error: json({ error: 'ไม่พบงานนี้' }, 404), job: null };
  if (String(job.sourceType || '') !== 'upload') {
    return { error: json({ error: 'ผูกไฟล์เสียงแยกได้เฉพาะงานที่อัปโหลดวิดีโอ' }, 400), job: null };
  }

  const sourceAudioKey = cleanText(body.sourceAudioKey, 600);
  if (!sourceAudioKey.startsWith('uploads/') || sourceAudioKey.includes('..')) {
    return { error: json({ error: 'ไฟล์เสียงแยกไม่ถูกต้อง' }, 400), job: null };
  }
  const audio = await resolveLogical(env, sourceAudioKey);
  if (!audio?.id || Number(audio.size || 0) <= 0) {
    return { error: json({ error: 'ไม่พบไฟล์เสียงที่อัปโหลดไว้ กรุณาเลือกไฟล์เดิมอีกครั้ง' }, 404), job: null };
  }

  job.sourceAudioKey = sourceAudioKey;
  job.sourceAudioName = cleanText(body.sourceAudioName, 180) || sourceAudioKey.split('/').pop() || null;
  job.mediaPairMode = 'separate-audio';
  job.r3Enabled = true;
  job.r3Version = Math.max(3, Number(job.r3Version || 3));
  job.error = null;
  job.stage = 'ผูกไฟล์เสียงแยกแล้ว พร้อมลองใหม่';
  job.pairRecoveredAt = new Date().toISOString();
  await writeJob(env, job);
  return { error: null, job };
}

async function attachAndRetry(request, env, ctx, url, id) {
  if (!publicAuthorized(request, env, url)) return json({ error: 'unauthorized' }, 401);
  const body = await request.json().catch(() => ({}));
  const attached = await attachAudio(env, id, body);
  if (attached.error) return attached.error;
  if (body.retry === false) return json({ ok: true, job: attached.job, attached: true });

  const headers = new Headers(request.headers);
  headers.set('content-type', 'application/json');
  const retryRequest = new Request(new URL(`/api/jobs/${encodeURIComponent(id)}/retry`, url.origin), {
    method: 'POST',
    headers,
    body: '{}',
  });
  const response = await fastWorker.fetch(retryRequest, env, ctx);
  if (!response.ok) return response;
  const data = await response.clone().json().catch(() => ({}));
  data.attached = true;
  data.sourceAudioKey = attached.job.sourceAudioKey;
  return new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
}

async function retryWithBodyPatch(request, env, ctx, url, id) {
  if (!publicAuthorized(request, env, url)) return null;
  const body = await request.clone().json().catch(() => ({}));
  if (!body?.sourceAudioKey) return null;
  const attached = await attachAudio(env, id, body);
  if (attached.error) return attached.error;
  return fastWorker.fetch(request, env, ctx);
}

async function deleteJobExtras(request, env, ctx, id) {
  const before = await readJob(env, id);
  const response = await fastWorker.fetch(request, env, ctx);
  if (!response.ok || !before) return response;

  let extraFreed = 0;
  const keys = new Set([before.sourceAudioKey, before.captionKey].filter(Boolean).map(String));
  for (const key of keys) {
    if (!key.startsWith('_jobs/') && !key.startsWith('_state/')) {
      extraFreed += Number(await deleteLogical(env, key).catch(() => 0) || 0);
    }
  }
  extraFreed += (await purgePrefixCompletely(env, `temp/${id}/`)).bytes;
  extraFreed += (await purgePrefixCompletely(env, `_state/${id}/`)).bytes;

  if (!extraFreed) return response;
  try {
    const data = await response.clone().json();
    data.freedBytes = Number(data.freedBytes || 0) + extraFreed;
    return new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
  } catch {
    return response;
  }
}

async function enrichHealth(response) {
  if (!response?.ok) return response;
  try {
    const data = await response.clone().json();
    data.separateAudioPairRecovery = true;
    data.separateAudioPairRecoveryVersion = 'pairfix-v1';
    data.failedJobAudioAttach = true;
    data.storageCleanup = true;
    data.storageCleanupVersion = 'cleanup-v2';
    data.workspacePurge = true;
    data.jobLinkedAudioCleanup = true;
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store, no-cache, must-revalidate');
    return new Response(JSON.stringify(data), { status: response.status, headers });
  } catch {
    return response;
  }
}

async function injectPairRecovery(response) {
  if (!response?.ok || !String(response.headers.get('content-type') || '').includes('text/html')) return response;
  let html = await response.text();
  if (!html.includes('pair-recovery.js')) {
    const script = '<script src="./pair-recovery.js" defer></script>';
    html = html.includes('</body>') ? html.replace('</body>', `  ${script}\n</body>`) : `${html}\n${script}`;
  }
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  return new Response(html, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const cleanupMatch = path.match(/^\/api\/cleanup\/(uploads|temp|outputs|all)$/);
    if (cleanupMatch && request.method === 'POST') {
      return cleanupWorkspace(request, env, ctx, url, cleanupMatch[1]);
    }

    const attachMatch = path.match(/^\/api\/pair\/jobs\/([^/]+)\/attach-audio$/);
    if (attachMatch && request.method === 'POST') {
      return attachAndRetry(request, env, ctx, url, decodeURIComponent(attachMatch[1]));
    }

    const retryMatch = path.match(/^\/api\/jobs\/([^/]+)\/retry$/);
    if (retryMatch && request.method === 'POST') {
      const patched = await retryWithBodyPatch(request, env, ctx, url, decodeURIComponent(retryMatch[1]));
      if (patched) return patched;
    }

    const deleteMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
    if (deleteMatch && request.method === 'DELETE' && publicAuthorized(request, env, url)) {
      return deleteJobExtras(request, env, ctx, decodeURIComponent(deleteMatch[1]));
    }

    let response = await fastWorker.fetch(request, env, ctx);
    if (request.method === 'GET' && path === '/api/health') response = await enrichHealth(response);
    if (request.method === 'GET' && (path === '/' || path === '/index.html')) response = await injectPairRecovery(response);
    return response;
  },

  async scheduled(controller, env, ctx) {
    return fastWorker.scheduled(controller, env, ctx);
  },
};
