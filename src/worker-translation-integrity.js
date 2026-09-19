import innerWorker from './worker-separate-audio-dispatch.js';

const CONTRACT = 'translation-integrity-v1';
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const LEAK_MARKERS = [
  '{"translations"',
  '"translations":',
  '"sourceLanguage":',
  '"targetLanguage":',
  '"durationsSeconds":',
  '```json',
  '```text',
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function repeatedGarbage(text) {
  const value = String(text || '');
  if (/(.)\1{24,}/u.test(value)) return true;
  if (/(.{1,8})\1{10,}/u.test(value)) return true;
  return false;
}

function translationProblem(source, translated, targetLang, durationSeconds) {
  const src = String(source || '').trim();
  const out = String(translated || '').trim();
  if (!out) return 'empty';
  if (LEAK_MARKERS.some(marker => out.includes(marker))) return 'prompt-or-json-leak';
  if (targetLang === 'th' && CJK_RE.test(out)) return 'cjk-leak-in-thai';
  if (repeatedGarbage(out)) return 'repetition-runaway';

  const duration = Math.max(0, Number(durationSeconds || 0));
  const sourceAllowance = Math.max(0, src.length) * 12 + 160;
  const durationAllowance = duration > 0 ? Math.ceil(duration * 45) + 100 : 0;
  const maxChars = Math.max(260, Math.min(1200, sourceAllowance), Math.min(1200, durationAllowance));
  if (out.length > maxChars) return `oversized:${out.length}>${maxChars}`;
  return null;
}

async function guardTranslateResponse(request, response) {
  if (!response?.ok) return response;
  let body;
  let payload;
  try {
    body = await request.clone().json();
    payload = await response.clone().json();
  } catch {
    return json({ error: 'translation integrity: invalid json response', contract: CONTRACT }, 502);
  }

  const texts = Array.isArray(body?.texts) ? body.texts.map(x => String(x ?? '')) : [];
  const durations = Array.isArray(body?.durations) ? body.durations : [];
  const targetLang = String(body?.targetLang || '');
  const translations = Array.isArray(payload?.translations) ? payload.translations.map(x => String(x ?? '')) : [];
  const unresolvedIndexes = Array.isArray(payload?.unresolvedIndexes)
    ? payload.unresolvedIndexes.map(Number).filter(Number.isInteger)
    : [];
  const unresolved = new Set(unresolvedIndexes);

  if (!texts.length || translations.length !== texts.length) {
    return json({
      error: 'translation integrity: count mismatch',
      contract: CONTRACT,
      expected: texts.length,
      received: translations.length,
    }, 502);
  }

  const failures = [];
  for (let i = 0; i < texts.length; i += 1) {
    if (unresolved.has(i)) continue;
    const reason = translationProblem(texts[i], translations[i], targetLang, durations[i]);
    if (reason) failures.push({ index: i, reason, preview: translations[i].slice(0, 120) });
  }
  if (failures.length) {
    return json({
      error: 'translation integrity rejected unsafe model output',
      contract: CONTRACT,
      failures: failures.slice(0, 12),
    }, 502);
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  const clean = { ...payload, translationIntegrity: CONTRACT };
  return new Response(JSON.stringify(clean), { status: response.status, headers });
}

async function enrichHealth(response) {
  if (!response?.ok) return response;
  try {
    const data = await response.clone().json();
    data.translationIntegrity = true;
    data.translationIntegrityContract = CONTRACT;
    data.translationPromptLeakRejected = true;
    data.translationCjkLeakRejectedForThai = true;
    data.translationPartialRepair = true;
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store, no-cache, must-revalidate');
    return new Response(JSON.stringify(data), { status: response.status, headers });
  } catch {
    return response;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const translateProbe = request.method === 'POST' && url.pathname === '/api/internal/translate'
      ? request.clone()
      : null;

    let response = await innerWorker.fetch(request, env, ctx);
    if (translateProbe) response = await guardTranslateResponse(translateProbe, response);
    if (request.method === 'GET' && url.pathname === '/api/health') response = await enrichHealth(response);
    return response;
  },

  async scheduled(controller, env, ctx) {
    return innerWorker.scheduled(controller, env, ctx);
  },
};
