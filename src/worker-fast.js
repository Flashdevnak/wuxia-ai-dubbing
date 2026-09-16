import r3Worker from './worker-r3.js';

async function enrichHealth(response) {
  if (!response?.ok) return response;
  try {
    const data = await response.clone().json();
    data.uploadAcceleration = 'parallel-multipart-v2';
    data.uploadConcurrencyMax = 4;
    data.uploadResume = true;
    data.videoAndSeparateAudioParallel = true;
    data.mobileForegroundRecovery = true;
    data.mobileForegroundRecoveryVersion = 'foreground-watchdog-v3';
    data.mobileBackgroundUpload = true;
    data.mobileBackgroundUploadMode = 'best-effort-v3';
    data.mobileBackgroundUploadOsSuspendSafe = true;
    data.mobileForegroundStallMs = 8000;
    data.mobileUploadHardTimeoutMs = 120000;
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store, no-cache, must-revalidate');
    return new Response(JSON.stringify(data), { status: response.status, headers });
  } catch {
    return response;
  }
}

async function injectFastUpload(response) {
  if (!response?.ok) return response;
  const contentType = String(response.headers.get('content-type') || '');
  if (!contentType.includes('text/html')) return response;

  let html = await response.text();
  if (!html.includes('upload-fast.js')) {
    const script = '<script src="./upload-fast.js?v=parallel2" defer></script>';
    html = html.includes('</body>') ? html.replace('</body>', `  ${script}\n</body>`) : `${html}\n${script}`;
  }
  if (!html.includes('mobile-upload-recovery.js')) {
    const recovery = '<script src="./mobile-upload-recovery.js?v=foreground3" defer></script>';
    html = html.includes('</body>') ? html.replace('</body>', `  ${recovery}\n</body>`) : `${html}\n${recovery}`;
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  return new Response(html, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let response = await r3Worker.fetch(request, env, ctx);

    if (request.method === 'GET' && url.pathname === '/api/health') {
      response = await enrichHealth(response);
    }
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      response = await injectFastUpload(response);
    }
    return response;
  },

  async scheduled(controller, env, ctx) {
    return r3Worker.scheduled(controller, env, ctx);
  },
};