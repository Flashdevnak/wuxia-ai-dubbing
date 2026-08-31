const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

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

async function getText(url, extra = {}) {
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      'accept': '*/*',
      'accept-language': 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7',
      ...extra,
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`YouTube HTTP ${res.status}`);
  return res.text();
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
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
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (Number.isFinite(start) && text) entries.push({ start: Math.max(0, start), duration, text });
  }
  return entries;
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
  const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(key)}&prettyPrint=false`, {
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
  });
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
  const u = new URL(baseUrl);
  if (lang) u.searchParams.set('lang', lang);
  if (tlang) u.searchParams.set('tlang', tlang); else u.searchParams.delete('tlang');
  u.searchParams.set('fmt', fmt);
  return u.toString();
}

async function fetchCaption(url, id) {
  try {
    const xml = await getText(url, { 'referer': `https://www.youtube.com/watch?v=${id}` });
    const entries = parseSrv1(xml);
    return entries.length ? { xml, entries } : null;
  } catch { return null; }
}

async function directUnsigned(id, targetLang, sourceLang) {
  let list;
  try { list = await getText(`https://www.youtube.com/api/timedtext?v=${encodeURIComponent(id)}&type=list&hl=en`); }
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
      const html = await getText(page, { 'referer': 'https://www.google.com/' });
      last = html;
      const direct = playerFromHtml(html);
      const dtracks = tracksFromPlayer(direct).tracks;
      if (dtracks.length) return direct;
      const cfg = configFromHtml(html);
      const inner = await playerFromInnertube(id, cfg.key, cfg.version);
      if (tracksFromPlayer(inner).tracks.length) return inner;
    } catch {}
  }
  const cfg = configFromHtml(last);
  return playerFromInnertube(id, cfg.key, cfg.version);
}

export async function fetchYouTubeTranscript(sourceUrl, targetLang = 'th', sourceLang = 'auto') {
  const id = videoId(sourceUrl);

  const unsigned = await directUnsigned(id, targetLang, sourceLang);
  if (unsigned?.entries?.length) return { videoId: id, ...unsigned };

  const player = await getPlayer(id);
  const { tracks, translations } = tracksFromPlayer(player);
  if (!tracks.length) throw new Error('YouTube ไม่ส่งข้อมูลคำบรรยายให้ Cloudflare ในขณะนี้');

  const chosen = chooseTrack(tracks, targetLang, sourceLang);
  if (!chosen?.baseUrl) throw new Error('YouTube ไม่ส่งลิงก์คำบรรยายที่ใช้งานได้');
  const target = baseLang(targetLang);
  const exact = baseLang(chosen.languageCode) === target;
  const translationAvailable = translations.some(x => baseLang(x.languageCode) === target);

  const attempts = [];
  if (exact) attempts.push({ url: signedVariant(chosen.baseUrl, { fmt: 'srv1' }), language: chosen.languageCode, ready: true, origin: 'cloudflare-signed-caption' });
  if (!exact && (chosen.isTranslatable || translationAvailable)) {
    // DLBunny HAR shows the signed portion does not include lang/fmt. Try the
    // same style first (lang=target), then YouTube's conventional tlang form.
    attempts.push({ url: signedVariant(chosen.baseUrl, { lang: targetLang, fmt: 'srv1' }), language: targetLang, ready: true, origin: 'cloudflare-signed-caption-language' });
    attempts.push({ url: signedVariant(chosen.baseUrl, { tlang: targetLang, fmt: 'srv1' }), language: targetLang, ready: true, origin: 'cloudflare-signed-caption-translation' });
  }
  attempts.push({ url: signedVariant(chosen.baseUrl, { fmt: 'srv1' }), language: chosen.languageCode, ready: exact, origin: 'cloudflare-signed-caption-source' });

  for (const a of attempts) {
    const hit = await fetchCaption(a.url, id);
    if (hit?.entries?.length) {
      return {
        videoId: id,
        title: String(player?.videoDetails?.title || ''),
        language: a.language,
        targetLanguage: targetLang,
        targetReady: a.ready,
        origin: a.origin,
        format: 'srv1',
        entries: hit.entries,
      };
    }
  }
  throw new Error('พบคำบรรยาย YouTube แต่ดาวน์โหลดข้อความไม่ได้');
}
