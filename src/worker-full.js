import safeWorker from './worker-safe.js';
import {
  deleteLogical,
  deletePrefix,
  listAppFiles,
  listJobs,
  readJob,
  writeJob,
} from './storage.js';

const ACTIVE_STATUSES = new Set(['queued', 'processing', 'paused']);
const CLEANABLE_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function retentionMinutes(env) {
  return Math.max(10, Number(env.TEMP_RETENTION_MINUTES || 30));
}

function afterDownloadMinutes(env) {
  return Math.max(5, Number(env.AFTER_DOWNLOAD_RETENTION_MINUTES || 10));
}

function dateMs(value) {
  const n = Date.parse(String(value || ''));
  return Number.isFinite(n) ? n : 0;
}

function jobOutputId(key) {
  const match = String(key || '').match(/^outputs\/([^/]+)\//);
  return match ? match[1] : '';
}

async function markDownloadStarted(env, key) {
  const id = jobOutputId(key);
  if (!id) return;
  const job = await readJob(env, id);
  if (!job || job.status !== 'completed') return;
  const now = Date.now();
  job.completedAt = job.completedAt || job.updatedAt || job.createdAt || new Date(now).toISOString();
  job.lastDownloadAt = new Date(now).toISOString();
  job.downloadDeleteAfter = new Date(now + afterDownloadMinutes(env) * 60_000).toISOString();
  await writeJob(env, job);
}

async function drainPrefix(env, prefix) {
  let totalBytes = 0;
  let totalCount = 0;
  for (let round = 0; round < 50; round += 1) {
    const result = await deletePrefix(env, prefix, 100);
    totalBytes += Number(result.bytes || 0);
    totalCount += Number(result.count || 0);
    if (Number(result.remaining || 0) <= 0) break;
  }
  return { bytes: totalBytes, count: totalCount };
}

function expiryForJob(job, env) {
  if (!CLEANABLE_STATUSES.has(String(job.status || ''))) return Infinity;
  const anchor = dateMs(job.completedAt || job.updatedAt || job.createdAt);
  if (!anchor) return Infinity;
  const normalExpiry = anchor + retentionMinutes(env) * 60_000;
  const downloadExpiry = dateMs(job.downloadDeleteAfter);
  return downloadExpiry ? Math.min(normalExpiry, downloadExpiry) : normalExpiry;
}

async function deleteExpiredJob(env, job, jobs) {
  const id = String(job.id || '');
  if (!id) return { bytes: 0, count: 0 };

  let bytes = 0;
  let count = 0;
  for (const prefix of [`temp/${id}/`, `_state/${id}/`, `outputs/${id}/`]) {
    const result = await drainPrefix(env, prefix);
    bytes += result.bytes;
    count += result.count;
  }

  const sourceKey = String(job.sourceKey || '');
  if (sourceKey) {
    const shared = jobs.some(other => other.id !== job.id && String(other.sourceKey || '') === sourceKey && ACTIVE_STATUSES.has(String(other.status || '')));
    if (!shared) {
      const freed = await deleteLogical(env, sourceKey);
      bytes += Number(freed || 0);
      if (freed) count += 1;
    }
  }

  const captionKey = String(job.captionKey || '');
  if (captionKey.startsWith('temp/caption-imports/')) {
    const shared = jobs.some(other => other.id !== job.id && String(other.captionKey || '') === captionKey && ACTIVE_STATUSES.has(String(other.status || '')));
    if (!shared) {
      const freed = await deleteLogical(env, captionKey);
      bytes += Number(freed || 0);
      if (freed) count += 1;
    }
  }

  const jobFreed = await deleteLogical(env, `_jobs/${id}.json`);
  bytes += Number(jobFreed || 0);
  if (jobFreed) count += 1;
  return { bytes, count };
}

async function cleanupOrphans(env, jobs, now) {
  const files = await listAppFiles(env);
  const activeIds = new Set(jobs.filter(j => ACTIVE_STATUSES.has(String(j.status || ''))).map(j => String(j.id || '')));
  const referencedSources = new Set(jobs.filter(j => ACTIVE_STATUSES.has(String(j.status || ''))).map(j => String(j.sourceKey || '')).filter(Boolean));
  const referencedCaptions = new Set(jobs.filter(j => ACTIVE_STATUSES.has(String(j.status || ''))).map(j => String(j.captionKey || '')).filter(Boolean));
  const cutoff = now - retentionMinutes(env) * 60_000;
  let bytes = 0;
  let count = 0;

  for (const file of files) {
    const key = String(file.appProperties?.logicalKey || '');
    const modified = dateMs(file.modifiedTime || file.createdTime);
    if (!key || !modified || modified > cutoff) continue;

    let removable = false;
    if (key.startsWith('uploads/')) {
      removable = !referencedSources.has(key);
    } else if (key.startsWith('temp/caption-imports/')) {
      removable = !referencedCaptions.has(key);
    } else {
      const match = key.match(/^(?:temp|outputs|_state)\/([^/]+)\//);
      if (match) removable = !activeIds.has(match[1]);
    }
    if (!removable) continue;

    const freed = await deleteLogical(env, key);
    bytes += Number(freed || 0);
    if (freed) count += 1;
  }
  return { bytes, count };
}

async function cleanupExpiredJobs(env) {
  const now = Date.now();
  const jobs = await listJobs(env);
  let bytes = 0;
  let count = 0;
  let jobsDeleted = 0;

  for (const job of jobs) {
    if (expiryForJob(job, env) > now) continue;
    const result = await deleteExpiredJob(env, job, jobs);
    bytes += result.bytes;
    count += result.count;
    jobsDeleted += 1;
  }

  const remainingJobs = await listJobs(env);
  const orphanResult = await cleanupOrphans(env, remainingJobs, now);
  bytes += orphanResult.bytes;
  count += orphanResult.count;

  console.log(JSON.stringify({
    event: 'temporary-cleanup',
    jobsDeleted,
    objectsDeleted: count,
    bytesFreed: bytes,
    retentionMinutes: retentionMinutes(env),
    afterDownloadMinutes: afterDownloadMinutes(env),
  }));
}

async function enrichHealth(response, env) {
  if (!response?.ok) return response;
  try {
    const data = await response.clone().json();
    const storageReady = data.driveReady === true;
    data.backend = 'cloudflare-r2-temp';
    data.storageReady = storageReady;
    data.driveReady = storageReady;
    data.retentionMinutes = retentionMinutes(env);
    data.afterDownloadMinutes = afterDownloadMinutes(env);
    data.temporaryStorage = true;
    data.voiceProfiles = true;
    data.hybridYoutubeTiming = true;
    data.fullAutoUi = true;
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store, no-cache, must-revalidate');
    return new Response(JSON.stringify(data), { status: response.status, headers });
  } catch {
    return response;
  }
}

async function injectFullAutoAssets(response) {
  if (!response?.ok) return response;
  const contentType = String(response.headers.get('content-type') || '');
  if (!contentType.includes('text/html')) return response;

  let html = await response.text();
  if (!html.includes('full-auto.css')) {
    const style = '<link rel="stylesheet" href="./full-auto.css?v=full-auto1" />';
    html = html.includes('</head>') ? html.replace('</head>', `  ${style}\n</head>`) : `${style}\n${html}`;
  }
  if (!html.includes('safety.js')) {
    const safety = '<script src="./safety.js?v=guard1" defer></script>';
    html = html.includes('</body>') ? html.replace('</body>', `  ${safety}\n</body>`) : `${html}\n${safety}`;
  }
  if (!html.includes('full-auto.js')) {
    const fullAuto = '<script src="./full-auto.js?v=full-auto1" defer></script>';
    html = html.includes('</body>') ? html.replace('</body>', `  ${fullAuto}\n</body>`) : `${html}\n${fullAuto}`;
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  return new Response(html, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isDownload = request.method === 'GET'
      && url.pathname === '/api/files/download'
      && Boolean(url.searchParams.get('ticket'));
    const downloadKey = isDownload ? String(url.searchParams.get('key') || '') : '';

    let response = await safeWorker.fetch(request, env, ctx);

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return enrichHealth(response, env);
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      response = await injectFullAutoAssets(response);
    }

    if (isDownload && response.ok && jobOutputId(downloadKey)) {
      const work = markDownloadStarted(env, downloadKey).catch(err => {
        console.warn('download retention marker failed', err?.message || err);
      });
      if (ctx?.waitUntil) ctx.waitUntil(work);
      else await work;
    }

    return response;
  },

  async scheduled(_controller, env, ctx) {
    const work = cleanupExpiredJobs(env).catch(err => {
      console.error('temporary cleanup failed', err?.stack || err?.message || err);
    });
    if (ctx?.waitUntil) ctx.waitUntil(work);
    else await work;
  },
};
