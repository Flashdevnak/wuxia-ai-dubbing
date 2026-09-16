import fastWorker from './worker-fast.js';
import { readJob, resolveLogical, writeJob } from './storage.js';

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

async function enrichHealth(response) {
  if (!response?.ok) return response;
  try {
    const data = await response.clone().json();
    data.separateAudioPairRecovery = true;
    data.separateAudioPairRecoveryVersion = 'pairfix-v1';
    data.failedJobAudioAttach = true;
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
    const script = '<script src="./pair-recovery.js?v=pairfix1" defer></script>';
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

    const attachMatch = path.match(/^\/api\/pair\/jobs\/([^/]+)\/attach-audio$/);
    if (attachMatch && request.method === 'POST') {
      return attachAndRetry(request, env, ctx, url, decodeURIComponent(attachMatch[1]));
    }

    const retryMatch = path.match(/^\/api\/jobs\/([^/]+)\/retry$/);
    if (retryMatch && request.method === 'POST') {
      const patched = await retryWithBodyPatch(request, env, ctx, url, decodeURIComponent(retryMatch[1]));
      if (patched) return patched;
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
