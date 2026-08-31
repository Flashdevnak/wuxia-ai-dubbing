const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

// Public community APIs are fallbacks only. They are intentionally tried as a
// small pool because YouTube frequently blocks datacenter IPs, including ours.
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.syncpundit.io',
  'https://piped-api.hostux.net',
  'https://api.piped.yt',
  'https://pipedapi.pfcd.me',
];
const INVIDIOUS_INSTANCES = ['https://inv.nadeko.net'];

function baseLang(value) {
  return String(value || '').toLowerCase().split('-')[0].split('_')[0];
}

function videoId(value) {
  const raw = String(value || '').trim();
  let url;
  try { url = new URL(raw); } catch { throw new Error('ลิงก์ YouTube ไม่ถูกต้อง'); }
  const host = url.hostname.toLowerCase();
  if (host === 'youtu.be' || host === 'www.youtu.be') return url.pathname.split('/').filter(Boolean)[0] || '';
  if (host.endsWith('youtube.com')) {
    const q = url.searchParams.get('v');
    if (q) return q;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length > 1 && ['shorts', 'embed', 'live'].includes(parts[0])) return parts[1];
  }
  throw new Error('ไม่พบรหัสวิดีโอ YouTube');
}

async function fetchTimeout(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

async function getText(url, extra = {}, timeoutMs = 9000) {
  const res = await fetchTimeout(url, {
    headers: {
      'user-agent': UA,
      'accept': '*/*',
      'accept-language': 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7',
      ...extra,
    },
  }, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function getJson(url, extra = {}, timeoutMs = 9000) {
  const res = await fetchTimeout(url, {
    headers: {
      'user-agent': UA,
      'accept': 'application/json,text/plain,*/*',
      'accept-language': 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7',
      ...extra,
    },
  }, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

function cleanText(value) {
  return decodeEntities(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseSrv1(xml) {
  const entries = [];
  const re = /<text\s+([^>]+)>([\s\S]*?)<\/text>/gi;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    const attrs = m[1];
    const sm = attrs.match(/\bstart="([^"]+)"/i);
    const dm = attrs.match(/\bdur="([^"]+)"/i);
    const start = Number(sm?.[1] || 0);
    const duration = Math.max(0.05, Number(dm?.[1] || 0));
    const text = cleanText(m[2]);
    if (Number.isFinite(start) && text) entries.push({ start: Math.max(0, start), duration, text });
  }
  return entries;
}

function timeSeconds(value) {
  const v = String(value || '').trim().replace(',', '.');
  if (/^\d+(?:\.\d+)?s$/.test(v)) return Number(v.slice(0, -1));
  const parts = v.split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n))) return NaN;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(v);
}

function parseVtt(raw) {
  const text = String(raw || '').replace(/\r/g, '');
  const re = /(?:^|\n)(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})\s+-->\s+(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})[^\n]*\n([\s\S]*?)(?=\n\n|$)/g;
  const out = [];
  let m;
  let last = '';
  while ((m = re.exec(text))) {
    const start = timeSeconds(m[1]);
    const end = timeSeconds(m[2]);
    const body = cleanText(m[3].replace(/^\d+\s*$/gm, ''));
    if (!body || body === last || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    last = body;
    out.push({ start, duration: Math.max(0.05, end - start), text: body });
  }
  return out;
}

function parseTtml(raw) {
  const text = String(raw || '');
  const out = [];
  const re = /<p\s+([^>]+)>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(text))) {
    const attrs = m[1];
    const body = cleanText(m[2]);
    if (!body) continue;
    let start = NaN, duration = NaN;
    const begin = attrs.match(/\bbegin="([^"]+)"/i)?.[1];
    const end = attrs.match(/\bend="([^"]+)"/i)?.[1];
    const dur = attrs.match(/\bdur="([^"]+)"/i)?.[1];
    const t = attrs.match(/\bt="([^"]+)"/i)?.[1];
    const d = attrs.match(/\bd="([^"]+)"/i)?.[1];
    if (begin) start = timeSeconds(begin);
    else if (t && Number.isFinite(Number(t))) start = Number(t) / 1000;
    if (dur) duration = timeSeconds(dur);
    else if (d && Number.isFinite(Number(d))) duration = Number(d) / 1000;
    else if (end && Number.isFinite(start)) duration = timeSeconds(end) - start;
    if (Number.isFinite(start) && Number.isFinite(duration) && duration > 0) out.push({ start: Math.max(0, start), duration: Math.max(0.05, duration), text: body });
  }
  return out;
}

function parseCaption(raw) {
  return parseSrv1(raw).length ? parseSrv1(raw) : (parseVtt(raw).length ? parseVtt(raw) : parseTtml(raw));
}

function chooseGenericTrack(tracks, targetLang, sourceLang, codeKey = 'languageCode') {
  const target = baseLang(targetLang);
  const source = baseLang(sourceLang);
  for (const t of tracks) if (baseLang(t?.[codeKey] || t?.code || t?.language_code) === target) return t;
  if (source && source !== 'auto') {
    for (const t of tracks) if (baseLang(t?.[codeKey] || t?.code || t?.language_code) === source) return t;
  }
  return tracks[0] || null;
}

async function fetchProxyCaption(url, base) {
  if (!url) return null;
  const absolute = new URL(url, base).toString();
  const variants = [absolute];
  try {
    const u = new URL(absolute);
    u.searchParams.set('fmt', 'srv1');
    variants.unshift(u.toString());
  } catch {}
  for (const candidate of [...new Set(variants)]) {
    try {
      const raw = await getText(candidate, {}, 10000);
      const entries = parseCaption(raw);
      if (entries.length) return entries;
    } catch {}
  }
  return null;
}

async function pipedOne(base, id, targetLang, sourceLang) {
  const info = await getJson(`${base}/streams/${encodeURIComponent(id)}`, {}, 10000);
  const subtitles = Array.isArray(info?.subtitles) ? info.subtitles : [];
  if (!subtitles.length) throw new Error('no subtitles');
  const chosen = chooseGenericTrack(subtitles, targetLang, sourceLang, 'code');
  if (!chosen?.url) throw new Error('no subtitle url');
  const language = String(chosen.code || sourceLang || 'auto');
  const exact = baseLang(language) === baseLang(targetLang);

  if (!exact) {
    // Piped usually returns a proxied timedtext URL. Try the same unsigned
    // language switch visible in the Bunny HAR before falling back to source.
    try {
      const u = new URL(chosen.url, base);
      u.searchParams.set('lang', targetLang);
      u.searchParams.delete('tlang');
      const translated = await fetchProxyCaption(u.toString(), base);
      if (translated?.length) return { entries: translated, language: targetLang, targetReady: true, title: String(info?.title || ''), origin: `piped:${new URL(base).hostname}` };
      u.searchParams.set('lang', language);
      u.searchParams.set('tlang', targetLang);
      const translated2 = await fetchProxyCaption(u.toString(), base);
      if (translated2?.length) return { entries: translated2, language: targetLang, targetReady: true, title: String(info?.title || ''), origin: `piped-translate:${new URL(base).hostname}` };
    } catch {}
  }

  const entries = await fetchProxyCaption(chosen.url, base);
  if (!entries?.length) throw new Error('empty subtitle');
  return { entries, language, targetReady: exact, title: String(info?.title || ''), origin: `piped:${new URL(base).hostname}` };
}

async function pipedTranscript(id, targetLang, sourceLang) {
  const attempts = await Promise.allSettled(PIPED_INSTANCES.slice(0, 6).map(base => pipedOne(base, id, targetLang, sourceLang)));
  const good = attempts.filter(x => x.status === 'fulfilled').map(x => x.value).filter(x => x?.entries?.length);
  return good.find(x => x.targetReady) || good[0] || null;
}

async function invidiousOne(base, id, targetLang, sourceLang) {
  const listing = await getJson(`${base}/api/v1/captions/${encodeURIComponent(id)}`, {}, 10000);
  const captions = Array.isArray(listing?.captions) ? listing.captions : [];
  if (!captions.length) throw new Error('no captions');
  const chosen = chooseGenericTrack(captions, targetLang, sourceLang, 'languageCode');
  if (!chosen) throw new Error('no caption track');
  const language = String(chosen.languageCode || sourceLang || 'auto');
  const exact = baseLang(language) === baseLang(targetLang);
  const q = new URLSearchParams({ lang: language });
  if (!exact) q.set('tlang', targetLang);
  let raw = await getText(`${base}/api/v1/captions/${encodeURIComponent(id)}?${q}`, {}, 10000);
  let entries = parseCaption(raw);
  if (!entries.length && !exact) {
    q.delete('tlang');
    raw = await getText(`${base}/api/v1/captions/${encodeURIComponent(id)}?${q}`, {}, 10000);
    entries = parseCaption(raw);
  }
  if (!entries.length) throw new Error('empty captions');
  return { entries, language: !exact && q.has('tlang') ? targetLang : language, targetReady: exact || q.has('tlang'), title: '', origin: `invidious:${new URL(base).hostname}` };
}

async function invidiousTranscript(id, targetLang, sourceLang) {
  const attempts = await Promise.allSettled(INVIDIOUS_INSTANCES.map(base => invidiousOne(base, id, targetLang, sourceLang)));
  const good = attempts.filter(x => x.status === 'fulfilled').map(x => x.value).filter(x => x?.entries?.length);
  return good.find(x => x.targetReady) || good[0] || null;
}

function balancedJson(text, marker) {
  const pos = text.indexOf(marker);
  if (pos < 0) return null;
  const first = text.indexOf('{', pos + marker.length);
  if (first < 0) return null;
  let depth = 0, quote = '', escaped = false;
  for (let i = first; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(first, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function playerFromHtml(html) {
  for (const marker of ['var ytInitialPlayerResponse =', 'ytInitialPlayerResponse =', 'window["ytInitialPlayerResponse"] =']) {
    const found = balancedJson(html, marker);
    if (found) return found;
  }
  return null;
}

function configFromHtml(html) {
  const key = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1] || '';
  const version = html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION"\s*:\s*"([^"]+)"/)?.[1] || '';
  return { key, version };
}

async function playerFromInnertube(id, key, version) {
  if (!key) return null;
  const res = await fetchTimeout(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(key)}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': UA,
      'origin': 'https://www.youtube.com',
      'referer': `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
      'accept-language': 'en-US,en;q=0.9',
    },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: version || '2.20260830.00.00', hl: 'en', gl: 'US' } },
      videoId: id,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  }, 9000);
  if (!res.ok) return null;
  try { return await res.json(); } catch { return null; }
}

function tracksFromPlayer(player) {
  const renderer = player?.captions?.playerCaptionsTracklistRenderer;
  const tracks = Array.isArray(renderer?.captionTracks) ? renderer.captionTracks : [];
  const translations = Array.isArray(renderer?.translationLanguages) ? renderer.translationLanguages : [];
  return { tracks, translations };
}

function chooseTrack(tracks, targetLang, sourceLang) {
  const target = baseLang(targetLang);
  const source = baseLang(sourceLang);
  for (const t of tracks) if (baseLang(t.languageCode) === target) return t;
  if (source && source !== 'auto') {
    for (const t of tracks) if (baseLang(t.languageCode) === source) return t;
  }
  for (const t of tracks) if (String(t.kind || '').toLowerCase() !== 'asr') return t;
  return tracks[0] || null;
}

function signedVariant(baseUrl, { lang, tlang, fmt = 'srv1' } = {}) {
  const u = new URL(baseUrl, 'https://www.youtube.com');
  if (lang) u.searchParams.set('lang', lang);
  if (tlang) u.searchParams.set('tlang', tlang); else u.searchParams.delete('tlang');
  u.searchParams.set('fmt', fmt);
  return u.toString();
}

async function fetchCaption(url, id) {
  try {
    const xml = await getText(url, { 'referer': `https://www.youtube.com/watch?v=${id}` }, 9000);
    const entries = parseCaption(xml);
    return entries.length ? { xml, entries } : null;
  } catch { return null; }
}

async function directUnsigned(id, targetLang, sourceLang) {
  let list;
  try { list = await getText(`https://www.youtube.com/api/timedtext?v=${encodeURIComponent(id)}&type=list&hl=en`, {}, 6000); }
  catch { return null; }
  const tracks = [...list.matchAll(/<track\s+([^>]+?)\/?>(?:<\/track>)?/gi)].map(m => {
    const a = m[1];
    const attr = n => decodeEntities(a.match(new RegExp(`\\b${n}="([^"]*)"`, 'i'))?.[1] || '');
    return { languageCode: attr('lang_code') || attr('lang'), name: attr('name'), kind: attr('kind'), isTranslatable: /(?:cantran|can_translate)="(?:1|true)"/i.test(a), baseUrl: '' };
  }).filter(t => t.languageCode);
  if (!tracks.length) return null;
  const chosen = chooseTrack(tracks, targetLang, sourceLang);
  const params = new URLSearchParams({ v: id, lang: chosen.languageCode, fmt: 'srv1' });
  if (chosen.name) params.set('name', chosen.name);
  if (chosen.kind) params.set('kind', chosen.kind);
  const exact = baseLang(chosen.languageCode) === baseLang(targetLang);
  if (!exact && chosen.isTranslatable) params.set('tlang', targetLang);
  let hit = await fetchCaption(`https://www.youtube.com/api/timedtext?${params}`, id);
  if (!hit && !exact) {
    params.delete('tlang'); params.set('lang', targetLang);
    hit = await fetchCaption(`https://www.youtube.com/api/timedtext?${params}`, id);
  }
  if (!hit) return null;
  return { ...hit, language: exact || chosen.isTranslatable ? targetLang : chosen.languageCode, targetReady: exact || chosen.isTranslatable, origin: 'cloudflare-timedtext-direct' };
}

async function getPlayer(id) {
  const pages = [
    `https://www.youtube.com/watch?v=${encodeURIComponent(id)}&hl=en&bpctr=9999999999&has_verified=1`,
    `https://www.youtube.com/embed/${encodeURIComponent(id)}?hl=en`,
    `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?hl=en`,
  ];
  let last = '';
  for (const page of pages) {
    try {
      const html = await getText(page, { 'referer': 'https://www.google.com/' }, 7000);
      last = html;
      const direct = playerFromHtml(html);
      if (tracksFromPlayer(direct).tracks.length) return direct;
      const cfg = configFromHtml(html);
      const inner = await playerFromInnertube(id, cfg.key, cfg.version);
      if (tracksFromPlayer(inner).tracks.length) return inner;
    } catch {}
  }
  const cfg = configFromHtml(last);
  return playerFromInnertube(id, cfg.key, cfg.version);
}

async function androidTranscript(id, targetLang, sourceLang) {
  try {
    const androidUA = 'com.google.android.youtube/19.47.53 (Linux; U; Android 14) gzip';
    const res = await fetchTimeout(
      `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_API_KEY}&prettyPrint=false`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': androidUA,
          'x-youtube-client-name': '3',
          'x-youtube-client-version': '19.47.53',
        },
        body: JSON.stringify({
          context: {
            client: {
              hl: 'en',
              gl: 'US',
              clientName: 'ANDROID',
              clientVersion: '19.47.53',
              androidSdkVersion: 34,
              userAgent: androidUA,
            },
          },
          videoId: id,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
      },
      10000,
    );
    if (!res.ok) return null;
    const player = await res.json();
    const { tracks, translations } = tracksFromPlayer(player);
    if (!tracks.length) return null;
    const chosen = chooseTrack(tracks, targetLang, sourceLang);
    if (!chosen?.baseUrl) return null;
    const target = baseLang(targetLang);
    const exact = baseLang(chosen.languageCode) === target;
    const canTranslate = chosen.isTranslatable === true || translations.some(x => baseLang(x.languageCode) === target);
    const attempts = [];
    if (exact) attempts.push({ url: signedVariant(chosen.baseUrl, { fmt: 'srv1' }), language: chosen.languageCode, ready: true, origin: 'innertube-android-exact' });
    if (!exact && canTranslate) {
      attempts.push({ url: signedVariant(chosen.baseUrl, { tlang: targetLang, fmt: 'srv1' }), language: targetLang, ready: true, origin: 'innertube-android-translate' });
      attempts.push({ url: signedVariant(chosen.baseUrl, { lang: targetLang, fmt: 'srv1' }), language: targetLang, ready: true, origin: 'innertube-android-language' });
    }
    attempts.push({ url: signedVariant(chosen.baseUrl, { fmt: 'srv1' }), language: chosen.languageCode, ready: exact, origin: 'innertube-android-source' });
    for (const attempt of attempts) {
      const hit = await fetchCaption(attempt.url, id);
      if (hit?.entries?.length) {
        return {
          videoId: id,
          title: String(player?.videoDetails?.title || ''),
          language: attempt.language,
          targetLanguage: targetLang,
          targetReady: attempt.ready,
          origin: attempt.origin,
          format: 'srv1',
          entries: hit.entries,
        };
      }
    }
  } catch {}
  return null;
}

async function signedYouTubeTranscript(id, targetLang, sourceLang) {
  const player = await getPlayer(id);
  const { tracks, translations } = tracksFromPlayer(player);
  if (!tracks.length) return null;
  const chosen = chooseTrack(tracks, targetLang, sourceLang);
  if (!chosen?.baseUrl) return null;
  const target = baseLang(targetLang);
  const exact = baseLang(chosen.languageCode) === target;
  const translationAvailable = translations.some(x => baseLang(x.languageCode) === target);
  const attempts = [];
  if (exact) attempts.push({ url: signedVariant(chosen.baseUrl, { fmt: 'srv1' }), language: chosen.languageCode, ready: true, origin: 'cloudflare-signed-caption' });
  if (!exact && (chosen.isTranslatable || translationAvailable)) {
    attempts.push({ url: signedVariant(chosen.baseUrl, { lang: targetLang, fmt: 'srv1' }), language: targetLang, ready: true, origin: 'cloudflare-signed-caption-language' });
    attempts.push({ url: signedVariant(chosen.baseUrl, { tlang: targetLang, fmt: 'srv1' }), language: targetLang, ready: true, origin: 'cloudflare-signed-caption-translation' });
  }
  attempts.push({ url: signedVariant(chosen.baseUrl, { fmt: 'srv1' }), language: chosen.languageCode, ready: exact, origin: 'cloudflare-signed-caption-source' });
  for (const a of attempts) {
    const hit = await fetchCaption(a.url, id);
    if (hit?.entries?.length) return { videoId: id, title: String(player?.videoDetails?.title || ''), language: a.language, targetLanguage: targetLang, targetReady: a.ready, origin: a.origin, format: 'srv1', entries: hit.entries };
  }
  return null;
}

export async function fetchSignedYouTubeTranscript(signedUrl, targetLang = 'th', expectedVideoId = '') {
  let u;
  try { u = new URL(String(signedUrl || '').trim()); } catch { throw new Error('ลิงก์ซับจาก HAR ไม่ถูกต้อง'); }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || !(host === 'youtube.com' || host.endsWith('.youtube.com')) || u.pathname !== '/api/timedtext') {
    throw new Error('ลิงก์ซับจาก HAR ไม่ใช่ YouTube timedtext');
  }
  const id = String(u.searchParams.get('v') || '');
  const language = String(u.searchParams.get('lang') || '');
  const format = String(u.searchParams.get('fmt') || 'srv1').toLowerCase();
  if (!id || !language) throw new Error('ลิงก์ซับจาก HAR ขาดรหัสวิดีโอหรือภาษา');
  if (expectedVideoId && String(expectedVideoId) !== id) throw new Error('HAR นี้ไม่ตรงกับวิดีโอที่วางไว้');

  let raw;
  try { raw = await getText(u.toString(), {}, 15000); }
  catch (err) { throw new Error(`เปิดซับจาก HAR ไม่สำเร็จ อาจหมดอายุแล้ว (${err?.message || err})`); }
  const entries = parseCaption(raw);
  if (!entries.length) throw new Error('ซับจาก HAR ไม่มีข้อความ หรือหมดอายุแล้ว');
  return {
    videoId: id,
    title: '',
    language,
    targetLanguage: targetLang,
    targetReady: baseLang(language) === baseLang(targetLang),
    origin: 'bunny-har-signed-timedtext',
    format,
    entries,
  };
}

export async function fetchYouTubeTranscript(sourceUrl, targetLang = 'th', sourceLang = 'auto') {
  const id = videoId(sourceUrl);

  const direct = await directUnsigned(id, targetLang, sourceLang);
  if (direct?.entries?.length) return { videoId: id, targetLanguage: targetLang, format: 'srv1', ...direct };

  const android = await androidTranscript(id, targetLang, sourceLang);
  if (android?.entries?.length) return android;

  const piped = await pipedTranscript(id, targetLang, sourceLang);
  if (piped?.entries?.length) return { videoId: id, targetLanguage: targetLang, format: 'proxy-caption', ...piped };

  const inv = await invidiousTranscript(id, targetLang, sourceLang);
  if (inv?.entries?.length) return { videoId: id, targetLanguage: targetLang, format: 'proxy-caption', ...inv };

  const signed = await signedYouTubeTranscript(id, targetLang, sourceLang);
  if (signed?.entries?.length) return signed;

  throw new Error('ยังดึงคำบรรยายจาก YouTube ไม่ได้ ระบบลอง YouTube, Piped และ Invidious แล้ว');
}
