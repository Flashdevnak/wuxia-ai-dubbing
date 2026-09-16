import pairWorker from './worker-pairfix.js';
import {
  deleteLogical,
  listAppFiles,
  listJobs,
  readJob,
  resolveLogical,
  writeJob,
} from './storage.js';

const ACTIVE_STATUSES = new Set(['queued', 'processing', 'paused']);
const STORAGE_COMPACTION_VERSION = 2;

// Retired runtime assets: upload-fast.js and mobile-upload-recovery.js.
// They remain in repository history for rollback, but are removed from served HTML.

function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function workerAuthorized(request, env) {
  return Boolean(env.WORKER_SHARED_TOKEN && sameSecret(request.headers.get('x-worker-token') || '', env.WORKER_SHARED_TOKEN));
}

function jobSourceKeys(job) {
  return [...new Set([
    String(job?.sourceKey || ''),
    String(job?.sourceAudioKey || ''),
  ].filter(Boolean))];
}

function logicalKey(file) {
  return String(file?.appProperties?.logicalKey || '');
}

async function deleteIfPresent(env, key) {
  if (!key) return 0;
  return Number(await deleteLogical(env, key).catch(() => 0)) || 0;
}

async function releaseCompletedChunkSources(env, jobId, index) {
  if (!jobId || !Number.isInteger(index) || index < 0) return 0;
  const n = String(index).padStart(5, '0');
  let freed = 0;
  freed += await deleteIfPresent(env, `temp/${jobId}/source/chunk_${n}.mkv`);
  freed += await deleteIfPresent(env, `temp/${jobId}/transcript/chunk_${n}.json`);
  return freed;
}

function allDubChunksDurable(job, files) {
  const jobId = String(job?.id || '');
  const total = Number(job?.chunkTotal || 0);
  if (!jobId || !Number.isInteger(total) || total < 1) return false;
  const keys = new Set(files.map(logicalKey));
  for (let index = 0; index < total; index += 1) {
    const n = String(index).padStart(5, '0');
    const required = [
      `_state/${jobId}/chunks/${n}.json`,
      `temp/${jobId}/dub/chunk_${n}.ts`,
      `temp/${jobId}/meta/chunk_${n}.json`,
    ];
    if (job?.subtitles !== false) required.push(`temp/${jobId}/subs/chunk_${n}.srt`);
    if (!required.every(key => keys.has(key))) return false;
  }
  return true;
}

async function releaseOriginalSources(env, job, jobs, reason) {
  const jobId = String(job?.id || '');
  if (!jobId || job?.autoCleanup === false) return { bytes: 0, count: 0 };
  let bytes = 0;
  let count = 0;
  for (const key of jobSourceKeys(job)) {
    const shared = jobs.some(other => (
      String(other?.id || '') !== jobId
      && ACTIVE_STATUSES.has(String(other?.status || ''))
      && jobSourceKeys(other).includes(key)
    ));
    if (shared) continue;
    const freed = await deleteIfPresent(env, key);
    if (freed) {
      bytes += freed;
      count += 1;
    }
  }
  if (bytes > 0) {
    console.log(JSON.stringify({ event: 'source-release', jobId, reason, bytesFreed: bytes, objectsDeleted: count }));
  }
  return { bytes, count };
}

async function compactActiveJobStorage(env, job, filesSnapshot = null, jobsSnapshot = null) {
  const jobId = String(job?.id || '');
  if (!jobId || !ACTIVE_STATUSES.has(String(job?.status || ''))) return { bytes: 0, count: 0 };
  if (Number(job?.chunkTotal || 0) < 1) return { bytes: 0, count: 0 };

  // The manifest is written only after segmentation is complete. Never remove
  // the old full paired source before this durable checkpoint exists.
  const manifest = await resolveLogical(env, `temp/${jobId}/manifest.json`).catch(() => null);
  if (!manifest?.id) return { bytes: 0, count: 0 };

  let bytes = 0;
  let count = 0;
  let originalsReleased = false;

  // Legacy separate-audio jobs created a full paired_source.mkv before they
  // were segmented. It is redundant after the manifest exists and can easily
  // consume another 1-2 GB by itself.
  const legacyPairFreed = await deleteIfPresent(env, `temp/${jobId}/paired_source.mkv`);
  if (legacyPairFreed) {
    bytes += legacyPairFreed;
    count += 1;
  }

  const files = filesSnapshot || await listAppFiles(env);
  const statePrefix = `_state/${jobId}/chunks/`;
  const completed = [];
  for (const file of files) {
    const key = logicalKey(file);
    if (!key.startsWith(statePrefix) || !key.endsWith('.json')) continue;
    const match = key.match(/\/([0-9]{5})\.json$/);
    if (match) completed.push(Number(match[1]));
  }

  for (const index of completed) {
    const freed = await releaseCompletedChunkSources(env, jobId, index);
    if (freed) {
      bytes += freed;
      count += 1;
    }
  }

  // Once every dubbed chunk + metadata + subtitle (when enabled) is durable,
  // finalization no longer needs the original 1-2 GB upload. Retry can recover
  // directly from the completed dubbed chunks. Releasing originals here keeps
  // final MP4 export from pushing R2 back toward the 5 GB workspace limit.
  if (allDubChunksDurable(job, files)) {
    const jobs = jobsSnapshot || await listJobs(env);
    const result = await releaseOriginalSources(env, job, jobs, 'all-dub-chunks-durable');
    bytes += result.bytes;
    count += result.count;
    originalsReleased = result.bytes > 0;
  }

  if (bytes > 0) {
    const current = await readJob(env, jobId).catch(() => null);
    if (current) {
      current.storageCompactionVersion = STORAGE_COMPACTION_VERSION;
      current.storageFreedBytes = Number(current.storageFreedBytes || 0) + bytes;
      current.storageCompactedAt = new Date().toISOString();
      if (originalsReleased) {
        current.storageSourcesReleasedAt = new Date().toISOString();
        current.storageSourceReleaseStage = 'all-dub-chunks-durable';
      }
      await writeJob(env, current).catch(() => {});
    }
    console.log(JSON.stringify({ event: 'active-storage-compaction', jobId, bytesFreed: bytes, objectsDeleted: count, originalsReleased }));
  }
  return { bytes, count };
}

async function handleChunkCompleteCompaction(env, jobId, index) {
  await releaseCompletedChunkSources(env, jobId, index);
  const job = await readJob(env, jobId).catch(() => null);
  if (!job) return;
  await compactActiveJobStorage(env, job);
}

async function compactAllActiveStorage(env) {
  const jobs = await listJobs(env);
  const files = await listAppFiles(env);
  let bytes = 0;
  let count = 0;
  for (const job of jobs) {
    if (!ACTIVE_STATUSES.has(String(job?.status || ''))) continue;
    const result = await compactActiveJobStorage(env, job, files, jobs);
    bytes += Number(result.bytes || 0);
    count += Number(result.count || 0);
  }
  return { bytes, count };
}

async function releaseFinishedJobSources(env, jobId) {
  const job = await readJob(env, jobId).catch(() => null);
  if (!job || String(job.status || '') !== 'completed' || job.autoCleanup === false) return { bytes: 0, count: 0 };
  const jobs = await listJobs(env);
  const result = await releaseOriginalSources(env, job, jobs, 'job-completed');
  if (result.bytes > 0) {
    job.storageCompactionVersion = STORAGE_COMPACTION_VERSION;
    job.storageFreedBytes = Number(job.storageFreedBytes || 0) + result.bytes;
    job.storageSourcesReleasedAt = new Date().toISOString();
    job.storageSourceReleaseStage = 'job-completed';
    await writeJob(env, job).catch(() => {});
  }
  return result;
}

function schedule(ctx, work) {
  const guarded = Promise.resolve(work).catch(err => {
    console.warn('storage compaction warning', err?.stack || err?.message || String(err));
  });
  if (ctx?.waitUntil) ctx.waitUntil(guarded);
  return guarded;
}

function withNoStore(response) {
  if (!response) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  headers.set('pragma', 'no-cache');
  headers.set('expires', '0');
  return new Response(response.body, { status: response.status, headers });
}

async function enrichHealth(response) {
  if (!response?.ok) return response;
  try {
    const data = await response.clone().json();
    Object.assign(data, {
      uploadAcceleration: 'resilient-multipart-v4',
      uploadEngineVersion: 4,
      uploadConcurrencyMax: 4,
      uploadResume: true,
      videoAndSeparateAudioParallel: true,
      mobileForegroundRecovery: true,
      mobileForegroundRecoveryVersion: 'adaptive-mobile-v4',
      mobileBackgroundUpload: true,
      mobileBackgroundUploadMode: 'best-effort-v4',
      mobileBackgroundUploadOsSuspendSafe: true,
      mobileForegroundStallMs: 18000,
      mobileReturnGraceMs: 26000,
      mobileResponseStallMs: 45000,
      mobileUploadHardTimeoutMs: 180000,
      uploadServerReconcile: true,
      uploadRetryAttempts: 12,
      uploadSessionMigration: 'v2-v3-to-v4',
      uploadSessionMigrationPreservesPartial: true,
      storageCompaction: true,
      storageCompactionVersion: STORAGE_COMPACTION_VERSION,
      directSeparateAudioSegmentation: true,
      releaseCompletedSourceChunks: true,
      releaseOriginalsAfterAllDubChunks: true,
      releaseOriginalsAfterCompletion: true,
      studioUiVersion: 2,
      versionQueryRequired: false,
    });
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store, no-cache, must-revalidate');
    return new Response(JSON.stringify(data), { status: response.status, headers });
  } catch {
    return response;
  }
}

async function rewriteHtml(response) {
  if (!response?.ok || !String(response.headers.get('content-type') || '').includes('text/html')) return response;
  let html = await response.text();

  html = html
    .replace(/\s*<script[^>]+src=["'][^"']*upload-fast\.js(?:\?[^"']*)?["'][^>]*><\/script>/gi, '')
    .replace(/\s*<script[^>]+src=["'][^"']*mobile-upload-recovery\.js(?:\?[^"']*)?["'][^>]*><\/script>/gi, '');

  html = html.replace(/((?:src|href)=["'][^"']+\.(?:js|css))\?v=[^"']+(["'])/gi, '$1$2');

  if (!html.includes('upload-engine-v4.js')) {
    const migrate = '<script src="./upload-migrate-v4.js"></script>';
    const engine = '<script src="./upload-engine-v4.js" defer></script>';
    const block = `${migrate}\n  ${engine}`;
    html = html.includes('<script src="./studio-v2.js"')
      ? html.replace('<script src="./studio-v2.js" defer></script>', `${block}\n  <script src="./studio-v2.js" defer></script>`)
      : html.replace('</body>', `  ${block}\n</body>`);
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  headers.set('pragma', 'no-cache');
  headers.set('expires', '0');
  return new Response(html, { status: response.status, headers });
}

function isCriticalAsset(pathname) {
  return [
    '/app.js',
    '/r3-studio.js',
    '/studio-ui.js',
    '/studio-v2.js',
    '/studio-v2.css',
    '/upload-migrate-v4.js',
    '/upload-engine-v4.js',
    '/pair-recovery.js',
    '/safety.js',
  ].includes(pathname);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const chunkCompleteProbe = request.method === 'POST' && url.pathname === '/api/internal/chunk-complete'
      ? request.clone()
      : null;
    const jobPatchProbe = request.method === 'PATCH' && /^\/api\/internal\/jobs\/[^/]+$/.test(url.pathname)
      ? request.clone()
      : null;
    const completeProbe = request.method === 'POST' && url.pathname === '/api/internal/complete'
      ? request.clone()
      : null;

    let response = await pairWorker.fetch(request, env, ctx);

    if (response.ok && chunkCompleteProbe && workerAuthorized(chunkCompleteProbe, env)) {
      const body = await chunkCompleteProbe.json().catch(() => ({}));
      const jobId = String(body.jobId || '');
      const index = Number(body.index);
      if (jobId && Number.isInteger(index)) schedule(ctx, handleChunkCompleteCompaction(env, jobId, index));
    }

    if (response.ok && jobPatchProbe && workerAuthorized(jobPatchProbe, env)) {
      const patch = await jobPatchProbe.json().catch(() => ({}));
      if (Number(patch.chunkTotal || 0) > 0) {
        const jobId = decodeURIComponent(url.pathname.split('/').pop() || '');
        const job = await readJob(env, jobId).catch(() => null);
        if (job) schedule(ctx, compactActiveJobStorage(env, job));
      }
    }

    if (response.ok && completeProbe && workerAuthorized(completeProbe, env)) {
      const body = await completeProbe.json().catch(() => ({}));
      const jobId = String(body.jobId || '');
      if (jobId) schedule(ctx, releaseFinishedJobSources(env, jobId));
    }

    if (request.method === 'GET' && url.pathname === '/api/storage') {
      // Looking at the storage page also opportunistically compacts safe,
      // redundant active-job files. The next refresh reflects the freed space.
      schedule(ctx, compactAllActiveStorage(env));
    }

    if (request.method === 'GET' && url.pathname === '/api/health') {
      response = await enrichHealth(response);
    }
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      response = await rewriteHtml(response);
    } else if (request.method === 'GET' && isCriticalAsset(url.pathname)) {
      response = withNoStore(response);
    }
    return response;
  },

  async scheduled(controller, env, ctx) {
    await pairWorker.scheduled(controller, env, ctx);
    schedule(ctx, compactAllActiveStorage(env));
  },
};
