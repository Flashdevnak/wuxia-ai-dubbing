import stabilityWorker from './worker-stability.js';
import { listAppFiles, readJob, resolveLogical, writeJob } from './storage.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate',
};

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

function cleanText(value, max = 600) {
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

function githubHeaders(env) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'wuxia-ai-dubbing-separate-audio-dispatch-v1',
    'content-type': 'application/json',
  };
}

async function triggerGitHub(env, job, workerBase) {
  if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) {
    return { triggered: false, reason: 'GitHub dispatch not configured' };
  }
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: 'POST',
    headers: githubHeaders(env),
    body: JSON.stringify({
      event_type: 'dubbing_job',
      client_payload: { job, workerBase },
    }),
  });
  return {
    triggered: response.ok,
    status: response.status,
    detail: response.ok ? undefined : (await response.text()).slice(0, 1000),
  };
}

async function validateUpload(env, key, label) {
  const clean = cleanText(key, 600);
  if (!clean.startsWith('uploads/') || clean.includes('..')) {
    throw new Error(`${label} ไม่ถูกต้อง`);
  }
  const file = await resolveLogical(env, clean);
  if (!file?.id || Number(file.size || 0) <= 0) {
    throw new Error(`ไม่พบ${label}บนเซิร์ฟเวอร์ กรุณาเลือกไฟล์เดิมอีกครั้ง`);
  }
  return { key: clean, size: Number(file.size || 0) };
}

async function createSeparateAudioJob(request, env, url, body) {
  if (!publicAuthorized(request, env, url)) return json({ error: 'กรุณาใส่รหัสสำนัก' }, 401);

  try {
    const video = await validateUpload(env, body.sourceKey, 'ไฟล์วิดีโอ');
    const audio = await validateUpload(env, body.sourceAudioKey, 'ไฟล์เสียงแยก');
    if (video.key === audio.key) return json({ error: 'วิดีโอและไฟล์เสียงต้องเป็นคนละไฟล์' }, 400);

    const job = {
      id: crypto.randomUUID(),
      jobType: 'dubbing',
      title: cleanText(body.title, 240) || 'งานพากย์ใหม่',
      sourceType: 'upload',
      sourceKey: video.key,
      sourceAudioKey: audio.key,
      sourceAudioName: cleanText(body.sourceAudioName, 180) || audio.key.split('/').pop() || null,
      mediaPairMode: 'separate-audio',
      sourceUrl: body.sourceUrl || null,
      sourceLang: cleanText(body.sourceLang, 40) || 'auto',
      targetLang: cleanText(body.targetLang, 40) || 'th',
      voiceMode: cleanText(body.voiceMode, 40) || 'auto',
      processingMode: ['fast', 'balanced', 'quality'].includes(body.processingMode) ? body.processingMode : 'fast',
      subtitles: body.subtitles !== false,
      keepMusic: body.keepMusic !== false,
      speakerSeparation: body.speakerSeparation === true,
      autoCleanup: body.autoCleanup !== false,
      captionUrl: body.captionUrl || null,
      captionKey: body.captionKey || null,
      captionSource: body.captionSource || null,
      captionLanguage: body.captionLanguage || null,
      captionFormat: body.captionFormat || null,
      captionVideoId: body.captionVideoId || null,
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
      pauseRequested: false,
      retryCount: 0,
      status: 'queued',
      progress: 3,
      stage: 'เข้าคิวประมวลผลวิดีโอ + เสียงแยก',
      createdAt: new Date().toISOString(),
      separateAudioDispatchContract: 'v1',
    };

    await writeJob(env, job);
    const workerBase = `${url.protocol}//${url.host}`;
    const dispatch = await triggerGitHub(env, job, workerBase);
    if (!dispatch.triggered) {
      job.status = 'failed';
      job.stage = 'ยังเริ่มประมวลผลไม่ได้';
      job.error = dispatch.detail || dispatch.reason || 'ไม่สามารถส่งงานไปประมวลผลได้';
      await writeJob(env, job);
    }
    return json({ job, dispatch }, 201);
  } catch (error) {
    return json({ error: error?.message || String(error) }, 400);
  }
}

async function enrichHealth(response) {
  if (!response?.ok) return response;
  try {
    const data = await response.clone().json();
    data.separateAudioDispatchContract = 'v1';
    data.separateAudioPersistBeforeDispatch = true;
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store, no-cache, must-revalidate');
    return new Response(JSON.stringify(data), { status: response.status, headers });
  } catch {
    return response;
  }
}

async function injectRetryRecovery(response) {
  if (!response?.ok || !String(response.headers.get('content-type') || '').includes('text/html')) return response;
  let html = await response.text();
  if (!html.includes('pair-retry-v2.js')) {
    html = html.includes('</body>')
      ? html.replace('</body>', '  <script src="./pair-retry-v2.js" defer></script>\n</body>')
      : `${html}\n<script src="./pair-retry-v2.js" defer></script>`;
  }
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  return new Response(html, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/jobs') {
      const body = await request.clone().json().catch(() => ({}));
      if (
        String(body.sourceType || '') === 'upload'
        && cleanText(body.sourceAudioKey, 600)
        && String(body.mediaPairMode || 'separate-audio') === 'separate-audio'
      ) {
        return createSeparateAudioJob(request, env, url, body);
      }
    }

    let response = await stabilityWorker.fetch(request, env, ctx);
    if (request.method === 'GET' && url.pathname === '/api/health') response = await enrichHealth(response);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      response = await injectRetryRecovery(response);
    }
    return response;
  },

  async scheduled(controller, env, ctx) {
    return stabilityWorker.scheduled(controller, env, ctx);
  },
};
