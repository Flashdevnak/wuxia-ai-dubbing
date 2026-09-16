import pairWorker from './worker-pairfix.js';

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

  // Retire the V2/V3 uploader and watchdog. V4 contains upload, retry,
  // foreground recovery and server reconciliation in one engine.
  html = html
    .replace(/\s*<script[^>]+src=["'][^"']*upload-fast\.js(?:\?[^"']*)?["'][^>]*><\/script>/gi, '')
    .replace(/\s*<script[^>]+src=["'][^"']*mobile-upload-recovery\.js(?:\?[^"']*)?["'][^>]*><\/script>/gi, '');

  // Never require ?v= cache-busting URLs. The Worker serves HTML and critical
  // Studio assets with no-store headers instead.
  html = html.replace(/((?:src|href)=["'][^"']+\.(?:js|css))\?v=[^"']+(["'])/gi, '$1$2');

  if (!html.includes('upload-engine-v4.js')) {
    const script = '<script src="./upload-engine-v4.js" defer></script>';
    html = html.includes('<script src="./studio-v2.js"')
      ? html.replace('<script src="./studio-v2.js" defer></script>', `${script}\n  <script src="./studio-v2.js" defer></script>`)
      : html.replace('</body>', `  ${script}\n</body>`);
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
    '/upload-engine-v4.js',
    '/pair-recovery.js',
    '/safety.js',
  ].includes(pathname);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let response = await pairWorker.fetch(request, env, ctx);

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
    return pairWorker.scheduled(controller, env, ctx);
  },
};
