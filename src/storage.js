const PUBLIC_PART_SIZE = 2 * 1024 * 1024;
const INTERNAL_PART_SIZE = 32 * 1024 * 1024;
const ROOT_MARKERS = ['wuxia-ai-dubbing-root-v2', 'wuxia-ai-dubbing-root-v1'];
const FOLDER_MIME = 'application/vnd.google-apps.folder';

let cachedGoogleToken = null;
let cachedRootId = null;

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

function displayNameForKey(key = 'file.bin') {
  const last = key.split('/').filter(Boolean).pop() || 'file.bin';
  if (key.startsWith('outputs/')) return safeName(last);
  if (key.startsWith('uploads/')) return safeName(last.replace(/^[0-9T\-]+-[0-9a-f-]+-/i, ''));
  return safeName(key.replaceAll('/', '__'));
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
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function encodeUploadState(state) {
  return b64urlEncode(JSON.stringify(state));
}

function decodeUploadState(value) {
  try {
    return JSON.parse(b64urlDecode(value));
  } catch {
    return null;
  }
}

function escapeDriveQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function googleAccessToken(env) {
  const now = Date.now();
  if (cachedGoogleToken && cachedGoogleToken.expiresAt > now + 60_000) return cachedGoogleToken.token;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    throw new Error('Google Drive OAuth ยังไม่ได้ตั้งค่า');
  }
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    throw new Error(`Google OAuth refresh failed (${r.status}): ${data.error_description || data.error || 'unknown'}`);
  }
  cachedGoogleToken = {
    token: data.access_token,
    expiresAt: now + Math.max(300, Number(data.expires_in || 3600)) * 1000,
  };
  return cachedGoogleToken.token;
}

async function driveFetch(env, url, options = {}, retry = true) {
  const token = await googleAccessToken(env);
  const headers = new Headers(options.headers || {});
  headers.set('authorization', `Bearer ${token}`);
  const r = await fetch(url, { ...options, headers });
  if (r.status === 401 && retry) {
    cachedGoogleToken = null;
    return driveFetch(env, url, options, false);
  }
  return r;
}

async function driveJson(env, url, options = {}) {
  const r = await driveFetch(env, url, options);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || data?.error_description || data?.error || `HTTP ${r.status}`;
    throw new Error(`Google Drive API: ${msg}`);
  }
  return data;
}

async function driveList(env, q, fields = 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,appProperties,trashed)') {
  let pageToken = '';
  const files = [];
  do {
    const u = new URL('https://www.googleapis.com/drive/v3/files');
    u.searchParams.set('q', q);
    u.searchParams.set('spaces', 'drive');
    u.searchParams.set('pageSize', '1000');
    u.searchParams.set('fields', fields);
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const data = await driveJson(env, u.toString());
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return files;
}

async function ensureRoot(env) {
  if (cachedRootId) return cachedRootId;
  for (const marker of ROOT_MARKERS) {
    const q = `trashed=false and mimeType='${FOLDER_MIME}' and appProperties has { key='wuxiaRoot' and value='${marker}' }`;
    const found = await driveList(env, q, 'files(id,name,appProperties)');
    if (found[0]?.id) {
      cachedRootId = found[0].id;
      return cachedRootId;
    }
  }
  const metadata = {
    name: env.GOOGLE_DRIVE_FOLDER || 'Wuxia AI Dubbing',
    mimeType: FOLDER_MIME,
    appProperties: { wuxiaRoot: ROOT_MARKERS[0] },
  };
  const created = await driveJson(env, 'https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(metadata),
  });
  cachedRootId = created.id;
  return cachedRootId;
}

async function resolveLogical(env, key) {
  const root = await ensureRoot(env);
  const escaped = escapeDriveQueryValue(key);
  const q = `'${root}' in parents and trashed=false and appProperties has { key='logicalKey' and value='${escaped}' }`;
  const files = await driveList(env, q);
  if (!files.length) return null;
  files.sort((a, b) => String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')));
  return files[0];
}

async function listAppFiles(env) {
  const root = await ensureRoot(env);
  return driveList(env, `'${root}' in parents and trashed=false`);
}

async function createLogicalFile(env, key, mimeType, declaredSize = null) {
  const root = await ensureRoot(env);
  const existing = await resolveLogical(env, key);
  if (existing?.id) {
    await driveFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(existing.id)}`, { method: 'DELETE' });
  }
  const appProperties = { logicalKey: key, wuxiaType: logicalType(key) };
  if (declaredSize !== null && declaredSize !== undefined && Number.isFinite(Number(declaredSize))) {
    appProperties.declaredSize = String(Math.max(0, Number(declaredSize)));
  }
  const metadata = {
    name: displayNameForKey(key),
    parents: [root],
    mimeType: mimeType || 'application/octet-stream',
    appProperties,
  };
  return driveJson(env, 'https://www.googleapis.com/drive/v3/files?fields=id,name,size,mimeType,createdTime,modifiedTime,appProperties', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(metadata),
  });
}

async function startResumable(env, key, mimeType, declaredSize, partSize) {
  const file = await createLogicalFile(env, key, mimeType, declaredSize);
  const headers = {
    'content-type': 'application/json; charset=UTF-8',
    'x-upload-content-type': mimeType || 'application/octet-stream',
  };
  if (declaredSize !== null && declaredSize !== undefined && Number(declaredSize) >= 0) {
    headers['x-upload-content-length'] = String(Number(declaredSize));
  }
  const r = await driveFetch(
    env,
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(file.id)}?uploadType=resumable&fields=id,name,size,mimeType,createdTime,modifiedTime,appProperties`,
    { method: 'PATCH', headers, body: JSON.stringify({}) },
  );
  if (!r.ok) throw new Error(`Google Drive resumable start failed (${r.status}): ${(await r.text()).slice(0, 800)}`);
  const session = r.headers.get('location');
  if (!session) throw new Error('Google Drive did not return resumable upload session');
  return {
    key,
    uploadId: encodeUploadState({
      session,
      key,
      fileId: file.id,
      size: declaredSize === null || declaredSize === undefined ? null : Number(declaredSize),
      partSize,
    }),
    partSize,
  };
}

function validateUploadState(key, uploadId, partNumber) {
  const state = decodeUploadState(uploadId);
  if (!state?.session || !state?.fileId || !state?.key || state.key !== key) return null;
  if (partNumber !== undefined && (!Number.isInteger(partNumber) || partNumber < 1)) return null;
  return state;
}

async function sendDriveChunk(env, state, partNumber, body, length, contentType, finalTotal = null) {
  const partSize = Number(state.partSize || INTERNAL_PART_SIZE);
  if (!Number.isFinite(length) || length <= 0 || length > partSize) {
    return { response: null, error: { status: 413, body: { error: 'invalid chunk size' } } };
  }
  const start = (partNumber - 1) * partSize;
  const end = start + length - 1;
  const total = state.size !== null && state.size !== undefined
    ? Number(state.size)
    : (finalTotal !== null && finalTotal !== undefined ? Number(finalTotal) : null);
  if (Number.isFinite(total) && total < end + 1) {
    return { response: null, error: { status: 400, body: { error: 'invalid upload range' } } };
  }
  const totalSpec = Number.isFinite(total) ? String(total) : '*';
  const r = await driveFetch(env, state.session, {
    method: 'PUT',
    headers: {
      'content-type': contentType || 'application/octet-stream',
      'content-length': String(length),
      'content-range': `bytes ${start}-${end}/${totalSpec}`,
    },
    body,
  });
  if (r.status === 308) {
    return {
      response: {
        partNumber,
        etag: r.headers.get('etag') || `drive-part-${partNumber}`,
        received: r.headers.get('range') || null,
        complete: false,
      },
      error: null,
    };
  }
  if (r.ok) {
    const data = await r.json().catch(() => ({}));
    return {
      response: {
        partNumber,
        etag: data.md5Checksum || r.headers.get('etag') || `drive-final-${partNumber}`,
        complete: true,
        file: data,
      },
      error: null,
    };
  }
  return {
    response: null,
    error: {
      status: r.status,
      body: { error: `Google Drive upload failed (${r.status})`, detail: (await r.text()).slice(0, 1000) },
    },
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
  const bytes = await chunk.arrayBuffer();
  const result = await sendDriveChunk(env, state, partNumber, bytes, bytes.byteLength, chunk.type || 'application/octet-stream');
  if (result.error) return { status: result.error.status, body: result.error.body };
  return { status: 200, body: result.response };
}

async function uploadInternalChunk(request, env, url) {
  const key = url.searchParams.get('key') || '';
  const uploadId = url.searchParams.get('uploadId') || '';
  const partNumber = Number(url.searchParams.get('partNumber'));
  const state = validateUploadState(key, uploadId, partNumber);
  if (!state) return { status: 400, body: { error: 'invalid upload params' } };
  const length = Number(request.headers.get('content-length') || 0);
  const finalTotalParam = url.searchParams.get('finalTotal');
  const finalTotal = finalTotalParam ? Number(finalTotalParam) : null;
  const result = await sendDriveChunk(
    env,
    state,
    partNumber,
    request.body,
    length,
    request.headers.get('content-type') || 'application/octet-stream',
    finalTotal,
  );
  if (result.error) return { status: result.error.status, body: result.error.body };
  return { status: 200, body: result.response };
}

async function uploadStatus(env, body) {
  const key = String(body?.key || '');
  const uploadId = String(body?.uploadId || '');
  const state = validateUploadState(key, uploadId);
  if (!state || !Number.isFinite(Number(state.size))) throw new Error('invalid upload state');
  const total = Number(state.size);
  const r = await driveFetch(env, state.session, {
    method: 'PUT',
    headers: { 'content-length': '0', 'content-range': `bytes */${total}` },
    body: new Uint8Array(0),
  });
  if (r.status === 308) {
    const m = String(r.headers.get('range') || '').match(/bytes\s*=\s*0-(\d+)/i);
    return { ok: true, complete: false, nextOffset: m ? Number(m[1]) + 1 : 0, partSize: Number(state.partSize) };
  }
  if (r.ok) return { ok: true, complete: true, nextOffset: total, partSize: Number(state.partSize) };
  if (r.status === 404 || r.status === 410) return { ok: false, expired: true, nextOffset: 0, partSize: Number(state.partSize) };
  throw new Error(`Google Drive upload status failed (${r.status}): ${(await r.text()).slice(0, 500)}`);
}

async function completeUpload(env, body) {
  if (!body?.key || !body?.uploadId) throw new Error('invalid upload body');
  const state = validateUploadState(String(body.key), String(body.uploadId));
  if (!state) throw new Error('invalid upload state');
  const meta = await driveJson(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(state.fileId)}?fields=id,name,size,mimeType,createdTime,modifiedTime,appProperties`);
  const actual = Number(meta.size || 0);
  if (Number.isFinite(Number(state.size)) && Number(state.size) !== actual) {
    throw new Error(`upload incomplete: ${actual}/${state.size} bytes`);
  }
  return { ok: true, key: body.key, fileId: meta.id, size: actual, etag: meta.md5Checksum || meta.id };
}

async function abortUpload(env, body) {
  const state = decodeUploadState(body?.uploadId || '');
  if (state?.fileId) {
    await driveFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(state.fileId)}`, { method: 'DELETE' });
  } else if (body?.key) {
    const file = await resolveLogical(env, body.key);
    if (file?.id) await driveFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
  }
  return { ok: true };
}

async function uploadSmallText(env, key, text, mimeType = 'application/json') {
  let file = await resolveLogical(env, key);
  if (!file) file = await createLogicalFile(env, key, mimeType, new TextEncoder().encode(text).byteLength);
  const r = await driveFetch(env, `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(file.id)}?uploadType=media`, {
    method: 'PATCH',
    headers: { 'content-type': mimeType },
    body: text,
  });
  if (!r.ok) throw new Error(`Google Drive small upload failed (${r.status}): ${(await r.text()).slice(0, 800)}`);
  return file;
}

async function downloadLogicalResponse(request, env, key, attachment = false) {
  const file = await resolveLogical(env, key);
  if (!file?.id) return { status: 404, response: null, error: { error: 'not found' } };
  const headers = {};
  const range = request.headers.get('range');
  if (range) headers.range = range;
  const r = await driveFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`, { headers });
  if (!r.ok && r.status !== 206) {
    return { status: r.status, response: null, error: { error: `Google Drive download failed (${r.status})`, detail: (await r.text()).slice(0, 600) } };
  }
  const out = new Headers();
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = r.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set('accept-ranges', 'bytes');
  if (attachment) out.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name || key.split('/').pop())}`);
  return { status: r.status, response: new Response(r.body, { status: r.status, headers: out }), error: null };
}

async function deleteLogical(env, key) {
  const file = await resolveLogical(env, key);
  if (!file?.id) return 0;
  const size = Number(file.size || 0);
  const r = await driveFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 404) throw new Error(`Google Drive delete failed (${r.status})`);
  return size;
}

async function deletePrefix(env, prefix) {
  const files = await listAppFiles(env);
  const matches = files.filter(f => String(f.appProperties?.logicalKey || '').startsWith(prefix));
  let bytes = 0;
  for (const f of matches) {
    bytes += Number(f.size || 0);
    await driveFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
  }
  return { bytes, count: matches.length };
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
  let accountLimitBytes = Number(env.GOOGLE_STORAGE_GB || 15) * 1024 ** 3;
  let accountUsageBytes = 0;
  try {
    const about = await driveJson(env, 'https://www.googleapis.com/drive/v3/about?fields=storageQuota');
    accountLimitBytes = Number(about?.storageQuota?.limit || accountLimitBytes);
    accountUsageBytes = Number(about?.storageQuota?.usage || 0);
  } catch (err) {
    console.warn('Drive quota lookup failed', err?.message || err);
  }
  const nonAppUsage = Math.max(0, accountUsageBytes - bytes);
  const appCapacity = Math.max(bytes, accountLimitBytes - nonAppUsage);
  return {
    bytes,
    groups,
    objectCount: files.length,
    limitBytes: appCapacity,
    accountLimitBytes,
    accountUsageBytes,
    accountRemainingBytes: Math.max(0, accountLimitBytes - accountUsageBytes),
    provider: 'google-drive',
  };
}

async function readJsonLogical(env, key) {
  const file = await resolveLogical(env, key);
  if (!file?.id) return null;
  const r = await driveFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`);
  if (!r.ok) return null;
  return r.json().catch(() => null);
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
  const files = await listAppFiles(env);
  const jobFiles = files
    .filter(f => String(f.appProperties?.logicalKey || '').startsWith('_jobs/'))
    .sort((a, b) => String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')))
    .slice(0, 100);
  const jobs = [];
  for (const f of jobFiles) {
    const job = await readJsonLogical(env, String(f.appProperties.logicalKey));
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
