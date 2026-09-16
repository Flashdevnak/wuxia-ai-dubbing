const PUBLIC_PART_SIZE = 8 * 1024 * 1024;
const INTERNAL_PART_SIZE = 32 * 1024 * 1024;
const INTERNAL_PREFIX = '__wuxia_internal/';
const MULTIPART_PREFIX = `${INTERNAL_PREFIX}multipart/`;

function safeName(name = 'video.bin') {
  return String(name).replace(/[^a-zA-Z0-9._\-ก-๙一-龥ぁ-んァ-ヶ가-힣]+/g, '_').slice(0, 180);
}

function logicalType(key = '') {
  if (key.startsWith('uploads/')) return 'upload';
  if (key.startsWith('temp/')) return 'temp';
  if (key.startsWith('outputs/')) return 'output';
  if (key.startsWith('_jobs/')) return 'job';
  if (key.startsWith('_state/')) return 'state';
  return 'other';
}

function fileKey(name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `uploads/${stamp}-${crypto.randomUUID()}-${safeName(name)}`;
}

function b64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(text) {
  const pad = text.length % 4 ? '='.repeat(4 - (text.length % 4)) : '';
  const bin = atob(String(text).replace(/-/g, '+').replace(/_/g, '/') + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function encodeUploadState(state) {
  return b64urlEncode(JSON.stringify(state));
}

function decodeUploadState(value) {
  try { return JSON.parse(b64urlDecode(value)); } catch { return null; }
}

function requireBucket(env) {
  if (!env.MEDIA_BUCKET) throw new Error('Cloudflare R2 binding MEDIA_BUCKET ยังไม่พร้อม');
  return env.MEDIA_BUCKET;
}

function iso(value) {
  try { return new Date(value || Date.now()).toISOString(); } catch { return new Date().toISOString(); }
}

function shapeObject(obj) {
  if (!obj) return null;
  const uploaded = iso(obj.uploaded);
  const key = String(obj.key || '');
  return {
    id: key,
    name: key.split('/').filter(Boolean).pop() || key,
    size: Number(obj.size || 0),
    mimeType: obj.httpMetadata?.contentType || 'application/octet-stream',
    createdTime: uploaded,
    modifiedTime: uploaded,
    etag: obj.httpEtag || obj.etag || null,
    appProperties: { logicalKey: key, wuxiaType: logicalType(key) },
  };
}

async function ensureRoot(env) {
  requireBucket(env);
  return 'r2-temp';
}

async function resolveLogical(env, key) {
  if (!key || String(key).startsWith(INTERNAL_PREFIX)) return null;
  const obj = await requireBucket(env).head(String(key));
  return shapeObject(obj);
}

async function listRaw(env, options = {}) {
  const bucket = requireBucket(env);
  const out = [];
  let cursor;
  do {
    const page = await bucket.list({ limit: 1000, cursor, ...options });
    out.push(...(page.objects || []));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function listAppFiles(env) {
  const objects = await listRaw(env);
  return objects
    .filter(o => !String(o.key || '').startsWith(INTERNAL_PREFIX))
    .map(shapeObject);
}

function uploadStateCompatible(state) {
  return Boolean(
    state?.key
    && state?.fileId
    && state?.session
    && state?.r2UploadId
    && state?.sessionId
    && state.key === state.fileId
  );
}

function validateUploadState(key, uploadId, partNumber) {
  const state = decodeUploadState(uploadId);
  if (!uploadStateCompatible(state) || String(state.key) !== String(key)) return null;
  if (partNumber !== undefined && (!Number.isInteger(partNumber) || partNumber < 1)) return null;
  return state;
}

function partMetaPrefix(state) {
  return `${MULTIPART_PREFIX}${state.sessionId}/`;
}

async function deleteInternalPrefix(env, prefix) {
  const bucket = requireBucket(env);
  const items = await listRaw(env, { prefix });
  if (items.length) await bucket.delete(items.map(x => x.key));
}

async function startResumable(env, key, mimeType, declaredSize, partSize) {
  const bucket = requireBucket(env);
  const normalizedKey = String(key || '');
  if (!normalizedKey || normalizedKey.startsWith(INTERNAL_PREFIX) || normalizedKey.includes('..')) {
    throw new Error('invalid upload key');
  }
  await bucket.delete(normalizedKey).catch(() => {});
  const multipart = await bucket.createMultipartUpload(normalizedKey, {
    httpMetadata: { contentType: mimeType || 'application/octet-stream' },
    customMetadata: { logicalKey: normalizedKey, wuxiaType: logicalType(normalizedKey) },
  });
  const sessionId = crypto.randomUUID();
  return {
    key: normalizedKey,
    uploadId: encodeUploadState({
      // Compatibility fields are intentionally retained because worker-safe.js
      // signs opaque upload states that historically came from Google Drive.
      session: 'https://www.googleapis.com/upload/drive/v3/files/r2-compatible',
      fileId: normalizedKey,
      key: normalizedKey,
      size: declaredSize === null || declaredSize === undefined ? null : Number(declaredSize),
      partSize: Number(partSize),
      r2UploadId: multipart.uploadId,
      sessionId,
    }),
    partSize: Number(partSize),
  };
}

async function savePartMeta(env, state, partNumber, etag, size) {
  const key = `${partMetaPrefix(state)}${String(partNumber).padStart(7, '0')}.json`;
  await requireBucket(env).put(key, JSON.stringify({ partNumber, etag, size: Number(size || 0) }), {
    httpMetadata: { contentType: 'application/json' },
  });
}

async function loadPartMeta(env, state) {
  const bucket = requireBucket(env);
  const objects = await listRaw(env, { prefix: partMetaPrefix(state) });
  const rows = [];
  for (const obj of objects) {
    const body = await bucket.get(obj.key);
    if (!body) continue;
    try {
      const value = JSON.parse(await body.text());
      if (Number.isInteger(Number(value.partNumber)) && value.etag) {
        rows.push({ partNumber: Number(value.partNumber), etag: String(value.etag), size: Number(value.size || 0) });
      }
    } catch {}
  }
  rows.sort((a, b) => a.partNumber - b.partNumber);
  return rows;
}

async function uploadR2Part(env, state, partNumber, body, size) {
  const upload = requireBucket(env).resumeMultipartUpload(state.key, state.r2UploadId);
  const part = await upload.uploadPart(partNumber, body);
  await savePartMeta(env, state, partNumber, part.etag, size);
  return {
    partNumber,
    etag: part.etag,
    complete: false,
  };
}

async function uploadPublicChunk(request, env) {
  const form = await request.formData();
  const key = String(form.get('key') || '');
  const uploadId = String(form.get('uploadId') || '');
  const partNumber = Number(form.get('partNumber'));
  const chunk = form.get('chunk');
  const state = validateUploadState(key, uploadId, partNumber);
  if (!state) return { status: 400, body: { error: 'invalid upload params' } };
  if (!(chunk instanceof Blob) || !chunk.size) return { status: 400, body: { error: 'missing file chunk' } };
  if (chunk.size > Number(state.partSize || PUBLIC_PART_SIZE)) return { status: 413, body: { error: 'chunk too large' } };
  try {
    const bytes = await chunk.arrayBuffer();
    return { status: 200, body: await uploadR2Part(env, state, partNumber, bytes, bytes.byteLength) };
  } catch (err) {
    return { status: 502, body: { error: 'R2 upload failed', detail: String(err?.message || err).slice(0, 800) } };
  }
}

async function uploadInternalChunk(request, env, url) {
  const key = url.searchParams.get('key') || '';
  const uploadId = url.searchParams.get('uploadId') || '';
  const partNumber = Number(url.searchParams.get('partNumber'));
  const state = validateUploadState(key, uploadId, partNumber);
  if (!state) return { status: 400, body: { error: 'invalid upload params' } };
  const length = Number(request.headers.get('content-length') || 0);
  if (!Number.isFinite(length) || length <= 0 || length > Number(state.partSize || INTERNAL_PART_SIZE)) {
    return { status: 413, body: { error: 'invalid chunk size' } };
  }
  try {
    return { status: 200, body: await uploadR2Part(env, state, partNumber, request.body, length) };
  } catch (err) {
    return { status: 502, body: { error: 'R2 upload failed', detail: String(err?.message || err).slice(0, 800) } };
  }
}

async function uploadStatus(env, body) {
  const key = String(body?.key || '');
  const state = validateUploadState(key, String(body?.uploadId || ''));
  if (!state) throw new Error('invalid upload state');
  const existing = await requireBucket(env).head(key);
  if (existing && Number.isFinite(Number(state.size)) && Number(existing.size) === Number(state.size)) {
    return { ok: true, complete: true, nextOffset: Number(existing.size), partSize: Number(state.partSize) };
  }
  const parts = await loadPartMeta(env, state);
  let nextOffset = 0;
  let expectedPart = 1;
  for (const part of parts) {
    if (part.partNumber !== expectedPart) break;
    nextOffset += Number(part.size || 0);
    expectedPart += 1;
  }
  const total = Number.isFinite(Number(state.size)) ? Number(state.size) : nextOffset;
  return { ok: true, complete: false, nextOffset: Math.min(nextOffset, total), partSize: Number(state.partSize) };
}

async function completeUpload(env, body) {
  const key = String(body?.key || '');
  const state = validateUploadState(key, String(body?.uploadId || ''));
  if (!state) throw new Error('invalid upload state');
  const parts = await loadPartMeta(env, state);
  if (!parts.length) throw new Error('upload incomplete: no parts');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].partNumber !== i + 1) throw new Error(`upload incomplete: missing part ${i + 1}`);
  }
  const upload = requireBucket(env).resumeMultipartUpload(state.key, state.r2UploadId);
  await upload.complete(parts.map(p => ({ partNumber: p.partNumber, etag: p.etag })));
  await deleteInternalPrefix(env, partMetaPrefix(state));
  const meta = await requireBucket(env).head(key);
  if (!meta) throw new Error('R2 completed object not found');
  const actual = Number(meta.size || 0);
  if (state.size !== null && state.size !== undefined && Number.isFinite(Number(state.size)) && actual !== Number(state.size)) {
    throw new Error(`upload incomplete: ${actual}/${state.size} bytes`);
  }
  return { ok: true, key, fileId: key, size: actual, etag: meta.httpEtag || meta.etag || key };
}

async function abortUpload(env, body) {
  const key = String(body?.key || '');
  const state = decodeUploadState(String(body?.uploadId || ''));
  if (uploadStateCompatible(state) && state.key === key) {
    try { await requireBucket(env).resumeMultipartUpload(state.key, state.r2UploadId).abort(); } catch {}
    await deleteInternalPrefix(env, partMetaPrefix(state)).catch(() => {});
  }
  if (key) await requireBucket(env).delete(key).catch(() => {});
  return { ok: true };
}

async function uploadSmallText(env, key, text, mimeType = 'application/json') {
  const bucket = requireBucket(env);
  await bucket.put(String(key), text, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { logicalKey: String(key), wuxiaType: logicalType(String(key)) },
  });
  return resolveLogical(env, String(key));
}

async function downloadLogicalResponse(request, env, key, attachment = false) {
  const bucket = requireBucket(env);
  const rangeHeader = request.headers.get('range');
  const object = await bucket.get(String(key), rangeHeader ? { range: request.headers } : undefined);
  if (!object) return { status: 404, response: null, error: { error: 'not found' } };
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag || object.etag || '');
  headers.set('accept-ranges', 'bytes');
  let status = 200;
  if (rangeHeader && object.range) {
    status = 206;
    const offset = Number(object.range.offset || 0);
    const length = Number(object.range.length || 0);
    headers.set('content-range', `bytes ${offset}-${offset + Math.max(0, length - 1)}/${object.size}`);
    headers.set('content-length', String(length));
  } else {
    headers.set('content-length', String(object.size));
  }
  if (attachment) {
    const name = String(key).split('/').filter(Boolean).pop() || 'download.bin';
    headers.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  return { status, response: new Response(object.body, { status, headers }), error: null };
}

async function deleteLogical(env, key) {
  const head = await requireBucket(env).head(String(key));
  if (!head) return 0;
  const size = Number(head.size || 0);
  await requireBucket(env).delete(String(key));
  return size;
}

async function deletePrefix(env, prefix, limit = null) {
  const bucket = requireBucket(env);
  const objects = await listRaw(env, { prefix: String(prefix || '') });
  const requested = Number(limit);
  const cap = Number.isFinite(requested) && requested > 0 ? Math.min(100, Math.floor(requested)) : objects.length;
  const matches = objects.slice(0, cap);
  const bytes = matches.reduce((sum, x) => sum + Number(x.size || 0), 0);
  if (matches.length) await bucket.delete(matches.map(x => x.key));
  return { bytes, count: matches.length, remaining: Math.max(0, objects.length - matches.length) };
}

async function storageInfo(env) {
  const files = await listAppFiles(env);
  let bytes = 0;
  const groups = { uploads: 0, temp: 0, outputs: 0, jobs: 0, other: 0 };
  for (const f of files) {
    const key = String(f.appProperties?.logicalKey || '');
    const size = Number(f.size || 0);
    bytes += size;
    if (key.startsWith('uploads/')) groups.uploads += size;
    else if (key.startsWith('temp/')) groups.temp += size;
    else if (key.startsWith('outputs/')) groups.outputs += size;
    else if (key.startsWith('_jobs/') || key.startsWith('_state/')) groups.jobs += size;
    else groups.other += size;
  }
  const budgetGb = Math.max(1, Number(env.TEMP_STORAGE_BUDGET_GB || 5));
  return {
    bytes,
    groups,
    objectCount: files.length,
    limitBytes: budgetGb * 1024 ** 3,
    accountLimitBytes: budgetGb * 1024 ** 3,
    accountUsageBytes: bytes,
    accountRemainingBytes: Math.max(0, budgetGb * 1024 ** 3 - bytes),
    provider: 'cloudflare-r2-temp',
    retentionMinutes: Math.max(10, Number(env.TEMP_RETENTION_MINUTES || 30)),
  };
}

async function readJsonLogical(env, key) {
  const object = await requireBucket(env).get(String(key));
  if (!object) return null;
  return object.json().catch(() => null);
}

async function readJob(env, id) {
  return readJsonLogical(env, `_jobs/${id}.json`);
}

async function writeJob(env, job) {
  job.updatedAt = new Date().toISOString();
  await uploadSmallText(env, `_jobs/${job.id}.json`, JSON.stringify(job), 'application/json');
  return job;
}

async function listJobs(env) {
  const objects = await listRaw(env, { prefix: '_jobs/' });
  objects.sort((a, b) => new Date(b.uploaded || 0).getTime() - new Date(a.uploaded || 0).getTime());
  const jobs = [];
  for (const object of objects.slice(0, 100)) {
    const job = await readJsonLogical(env, object.key);
    if (job) jobs.push(job);
  }
  return jobs;
}

export {
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
};
