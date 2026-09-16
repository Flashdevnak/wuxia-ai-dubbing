import baseWorker from './worker.js';
import { deleteLogical, readJob, resolveLogical } from './storage.js';

const enc = new TextEncoder();

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

function originAllowed(request, env) {
  const origin = request.headers.get('origin') || '';
  if (!origin) return true;
  const own = new URL(request.url).origin;
  const allowed = new Set([own, 'https://flashdevnak.github.io', env.ALLOWED_ORIGIN || ''].filter(Boolean));
  return allowed.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function directJson(request, env, data, status = 200) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
  });
  const origin = request.headers.get('origin') || '';
  if (origin && originAllowed(request, env)) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    headers.set('access-control-allow-headers', 'content-type,content-length,range,x-access-key,x-worker-token');
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function b64urlFromBytes(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function bytesFromB64url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 ? '='.repeat(4 - (normalized.length % 4)) : '';
  const binary = atob(normalized + pad);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function b64urlText(value) {
  return b64urlFromBytes(enc.encode(String(value)));
}

function textFromB64url(value) {
  return new TextDecoder().decode(bytesFromB64url(value));
}

function signingSecret(env) {
  return String(env.WORKER_SHARED_TOKEN || env.ACCESS_KEY || '');
}

async function hmac(env, value) {
  const secret = signingSecret(env);
  if (!secret) throw new Error('upload signing secret unavailable');
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return b64urlFromBytes(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(value))));
}

async function sealValue(env, prefix, payload) {
  const encoded = b64urlText(JSON.stringify(payload));
  return `${prefix}.${encoded}.${await hmac(env, `${prefix}.${encoded}`)}`;
}

async function openValue(env, token, prefix) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const signed = `${parts[0]}.${parts[1]}`;
  const expected = await hmac(env, signed);
  if (!sameSecret(parts[2], expected)) return null;
  try {
    const payload = JSON.parse(textFromB64url(parts[1]));
    if (!payload || Number(payload.e || 0) < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function decodeLegacyUploadState(value) {
  try {
    return JSON.parse(textFromB64url(String(value || '')));
  } catch {
    return null;
  }
}

function safeGoogleUploadSession(state, expectedKey) {
  if (!state || String(state.key || '') !== String(expectedKey || '') || !state.fileId || !state.session) return false;
  try {
    const u = new URL(String(state.session));
    return u.protocol === 'https:'
      && u.hostname.toLowerCase() === 'www.googleapis.com'
      && u.pathname.startsWith('/upload/drive/v3/files/');
  } catch {
    return false;
  }
}

async function sealUploadId(env, inner) {
  return sealValue(env, 'u1', {
    u: String(inner),
    e: Date.now() + (7 * 24 * 60 * 60 * 1000),
  });
}

async function openUploadId(env, token, expectedKey) {
  const signed = await openValue(env, token, 'u1');
  if (signed?.u) {
    const state = decodeLegacyUploadState(signed.u);
    if (!safeGoogleUploadSession(state, expectedKey)) return null;
    return String(signed.u);
  }

  // Backward-compatible recovery for uploads started before signed upload IDs.
  // Legacy IDs are accepted only if their fileId matches the logical file that
  // currently belongs to this application key.
  const legacy = decodeLegacyUploadState(token);
  if (!safeGoogleUploadSession(legacy, expectedKey)) return null;
  const current = await resolveLogical(env, String(expectedKey || ''));
  if (!current?.id || String(current.id) !== String(legacy.fileId)) return null;
  return String(token);
}

async function wrapStartResponse(response, env) {
  if (!response.ok) return response;
  let data;
  try {
    data = await response.clone().json();
  } catch {
    return response;
  }
  if (!data?.uploadId) return response;
  data.uploadId = await sealUploadId(env, data.uploadId);
  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  return new Response(JSON.stringify(data), { status: response.status, headers });
}

async function rewriteJsonUploadRequest(request, env) {
  const body = await request.clone().json();
  const key = String(body?.key || '');
  const inner = await openUploadId(env, body?.uploadId, key);
  if (!inner) return null;
  body.uploadId = inner;
  const headers = new Headers(request.headers);
  headers.set('content-type', 'application/json');
  headers.delete('content-length');
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify(body),
    redirect: request.redirect,
  });
}

async function rewriteMultipartUploadRequest(request, env) {
  const form = await request.clone().formData();
  const key = String(form.get('key') || '');
  const inner = await openUploadId(env, form.get('uploadId'), key);
  if (!inner) return null;
  form.set('uploadId', inner);
  const headers = new Headers(request.headers);
  headers.delete('content-type');
  headers.delete('content-length');
  return new Request(request.url, {
    method: request.method,
    headers,
    body: form,
    redirect: request.redirect,
  });
}

async function rewriteQueryUploadRequest(request, env, url) {
  const key = String(url.searchParams.get('key') || '');
  const inner = await openUploadId(env, url.searchParams.get('uploadId'), key);
  if (!inner) return null;
  const nextUrl = new URL(url.toString());
  nextUrl.searchParams.set('uploadId', inner);
  return new Request(nextUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: request.redirect,
  });
}

async function makeDownloadTicket(env, key) {
  return sealValue(env, 'd1', {
    k: String(key),
    e: Date.now() + (2 * 60 * 1000),
    n: crypto.randomUUID(),
  });
}

async function validDownloadTicket(env, token, key) {
  const payload = await openValue(env, token, 'd1');
  return Boolean(payload && String(payload.k || '') === String(key || ''));
}

function githubHeaders(env) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'wuxia-ai-dubbing-safety-wrapper',
  };
}

async function githubRunState(env, runId) {
  const id = Number(runId || 0);
  if (!id || !env.GITHUB_REPO || !env.GITHUB_TOKEN) return null;
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/runs/${id}`, {
    headers: githubHeaders(env),
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => ({}));
  return { status: data.status || null, conclusion: data.conclusion || null };
}

async function requestRunCancel(env, runId) {
  const id = Number(runId || 0);
  if (!id || !env.GITHUB_REPO || !env.GITHUB_TOKEN) return false;
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/runs/${id}/cancel`, {
    method: 'POST',
    headers: githubHeaders(env),
  });
  return response.ok || response.status === 409;
}

async function protectActiveJobDelete(request, env, url) {
  const match = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (!match || request.method !== 'DELETE' || !publicAuthorized(request, env, url)) return null;

  const id = decodeURIComponent(match[1]);
  const job = await readJob(env, id);
  if (!job) return null;

  if (job.runId) {
    const run = await githubRunState(env, job.runId);
    if (!run || run.status !== 'completed') {
      await requestRunCancel(env, job.runId);
      return directJson(request, env, {
        error: 'งานประมวลผลยังไม่หยุดสนิท ระบบส่งคำสั่งยกเลิกแล้ว กรุณารอสักครู่แล้วกดลบอีกครั้ง',
        cancelling: true,
        jobId: id,
      }, 409);
    }
  }

  if (['queued', 'processing'].includes(String(job.status || ''))) {
    return directJson(request, env, {
      error: 'งานนี้ยังทำอยู่ กรุณากดหยุดชั่วคราวก่อน แล้วจึงลบงาน',
      jobId: id,
    }, 409);
  }
  return null;
}

async function deleteJobWithExtras(request, env, url) {
  const match = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (!match || request.method !== 'DELETE' || !publicAuthorized(request, env, url)) return null;
  const id = decodeURIComponent(match[1]);
  const before = await readJob(env, id);
  const response = await baseWorker.fetch(request, env);
  if (!response.ok || !before?.transcriptXmlKey) return response;

  let extraFreed = 0;
  try {
    extraFreed = await deleteLogical(env, String(before.transcriptXmlKey));
  } catch (err) {
    console.warn('extra transcript cleanup failed', err?.message || err);
    return response;
  }

  if (!extraFreed) return response;
  try {
    const data = await response.clone().json();
    data.freedBytes = Number(data.freedBytes || 0) + Number(extraFreed || 0);
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(data), { status: response.status, headers });
  } catch {
    return response;
  }
}

async function enrichHealthResponse(response) {
  if (!response?.ok) return response;
  try {
    const data = await response.clone().json();
    data.safety = 'guard-v1';
    data.signedUploads = true;
    data.downloadTickets = true;
    data.activeDeleteProtection = true;
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store, no-cache, must-revalidate');
    return new Response(JSON.stringify(data), { status: response.status, headers });
  } catch {
    return response;
  }
}

async function injectSafetyAsset(response) {
  if (!response?.ok) return response;
  const contentType = String(response.headers.get('content-type') || '');
  if (!contentType.includes('text/html')) return response;
  const html = await response.text();
  if (html.includes('safety.js')) {
    return new Response(html, { status: response.status, headers: response.headers });
  }
  const script = '<script src="./safety.js?v=guard1" defer></script>';
  const next = html.includes('</body>') ? html.replace('</body>', `  ${script}\n</body>`) : `${html}\n${script}`;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  return new Response(next, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Short-lived download tickets prevent the master access key from appearing
    // in browser history, referrers and download URLs.
    if (path === '/api/files/download-ticket' && request.method === 'POST') {
      if (!publicAuthorized(request, env, url)) {
        return directJson(request, env, { error: 'กรุณาใส่รหัสสำนัก' }, 401);
      }
      const body = await request.json().catch(() => ({}));
      const key = String(body.key || '');
      if (!key || key.startsWith('_jobs/') || key.startsWith('_state/')) {
        return directJson(request, env, { error: 'invalid key' }, 400);
      }
      const file = await resolveLogical(env, key);
      if (!file?.id) return directJson(request, env, { error: 'not found' }, 404);
      return directJson(request, env, { ok: true, ticket: await makeDownloadTicket(env, key), expiresIn: 120 });
    }

    if (path === '/api/files/download' && request.method === 'GET' && url.searchParams.get('ticket')) {
      const key = String(url.searchParams.get('key') || '');
      if (!await validDownloadTicket(env, url.searchParams.get('ticket'), key)) {
        return directJson(request, env, { error: 'ลิงก์ดาวน์โหลดหมดอายุหรือไม่ถูกต้อง' }, 401);
      }
      const headers = new Headers(request.headers);
      headers.set('x-access-key', String(env.ACCESS_KEY || ''));
      const authorized = new Request(request, { headers });
      return baseWorker.fetch(authorized, env);
    }

    const deleteBlock = await protectActiveJobDelete(request, env, url);
    if (deleteBlock) return deleteBlock;

    const safeDelete = await deleteJobWithExtras(request, env, url);
    if (safeDelete) return safeDelete;

    const isPublicStart = path === '/api/uploads/start' && request.method === 'POST';
    const isInternalStart = path === '/api/internal/uploads/start' && request.method === 'POST';
    if (isPublicStart || isInternalStart) {
      return wrapStartResponse(await baseWorker.fetch(request, env), env);
    }

    if (path === '/api/uploads/chunk' && request.method === 'POST') {
      const rewritten = await rewriteMultipartUploadRequest(request, env);
      if (!rewritten) return directJson(request, env, { error: 'invalid or expired upload session' }, 400);
      return baseWorker.fetch(rewritten, env);
    }

    if (
      ['/api/uploads/status', '/api/uploads/complete', '/api/uploads/abort', '/api/internal/uploads/complete'].includes(path)
      && request.method === 'POST'
    ) {
      const rewritten = await rewriteJsonUploadRequest(request, env);
      if (!rewritten) return directJson(request, env, { error: 'invalid or expired upload session' }, 400);
      return baseWorker.fetch(rewritten, env);
    }

    if (path === '/api/internal/uploads/part' && request.method === 'PUT') {
      const rewritten = await rewriteQueryUploadRequest(request, env, url);
      if (!rewritten) return directJson(request, env, { error: 'invalid or expired upload session' }, 400);
      return baseWorker.fetch(rewritten, env);
    }

    const response = await baseWorker.fetch(request, env);
    if (request.method === 'GET' && path === '/api/health') {
      return enrichHealthResponse(response);
    }
    if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
      return injectSafetyAsset(response);
    }
    return response;
  },
};
