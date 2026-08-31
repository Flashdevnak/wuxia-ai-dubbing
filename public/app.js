const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const LANGS = [
  ['auto', 'ตรวจอัตโนมัติ'], ['th', 'ไทย'], ['zh', 'จีน (แมนดาริน)'], ['en', 'อังกฤษ'],
  ['ja', 'ญี่ปุ่น'], ['ko', 'เกาหลี'], ['vi', 'เวียดนาม'], ['id', 'อินโดนีเซีย'],
  ['ms', 'มาเลย์'], ['es', 'สเปน'], ['fr', 'ฝรั่งเศส'], ['de', 'เยอรมัน'],
  ['pt', 'โปรตุเกส'], ['ru', 'รัสเซีย'], ['ar', 'อาหรับ'], ['hi', 'ฮินดี'],
  ['it', 'อิตาลี'], ['tr', 'ตุรกี'], ['nl', 'ดัตช์'], ['pl', 'โปแลนด์'],
];

const SUPPORTED_EXTS = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v']);
const state = { sourceMode: 'link', sourceKey: null, captionUrl: null, captionMeta: null, harSubs: [], harFileName: '', jobs: [], files: [], storage: null, progressFloor: {} };
const IS_GITHUB_PAGES = location.hostname.endsWith('github.io');
const API_BASE = window.WUXIA_API_BASE || '';
const ACCESS_KEY_SESSION = 'wuxia-access-key-v2';
const UPLOAD_RESUME_PREFIX = 'wuxia-upload-v2:';
let accessKey = sessionStorage.getItem(ACCESS_KEY_SESSION) || '';

const fmtBytes = n => {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 2 ? 2 : i ? 1 : 0)} ${u[i]}`;
};
const esc = s => String(s ?? '').replace(/[&<>\"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[c] || c));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const extOf = name => String(name || '').split('.').pop()?.toLowerCase() || '';
const extLabel = name => extOf(name) ? `.${extOf(name).toUpperCase()}` : 'ไม่ทราบชนิด';
const langLabel = code => LANGS.find(x => x[0] === code)?.[1] || String(code || 'ไม่ทราบภาษา');

function getAccessKey() {
  if (accessKey) return accessKey;
  const key = window.prompt('กรอกรหัสเข้าใช้งาน');
  if (!key) throw new Error('กรุณาใส่รหัสเข้าใช้งานก่อน');
  accessKey = key.trim();
  sessionStorage.setItem(ACCESS_KEY_SESSION, accessKey);
  return accessKey;
}
function clearAccessKey() { accessKey = ''; sessionStorage.removeItem(ACCESS_KEY_SESSION); }

function initSparks() {
  const field = $('#sparkField');
  if (!field) return;
  field.innerHTML = '';
  for (let i = 0; i < 54; i++) {
    const s = document.createElement('i');
    s.className = 'spark';
    s.style.left = Math.random() * 100 + '%';
    s.style.top = 15 + Math.random() * 100 + '%';
    s.style.setProperty('--dur', 3.8 + Math.random() * 7 + 's');
    s.style.setProperty('--drift', -55 + Math.random() * 110 + 'px');
    s.style.setProperty('--size', 1 + Math.random() * 3 + 'px');
    s.style.animationDelay = -Math.random() * 9 + 's';
    field.appendChild(s);
  }
}

function fillLangs() {
  const src = $('#sourceLang');
  const tgt = $('#targetLang');
  if (!src || !tgt) return;
  for (const [value, label] of LANGS) {
    src.add(new Option(label, value));
    if (value !== 'auto') tgt.add(new Option(label, value));
  }
  src.value = 'auto';
  tgt.value = 'th';
  const cloud = $('#languageCloud');
  if (cloud) cloud.innerHTML = LANGS.filter(x => x[0] !== 'auto').map(x => `<span class="lang-pill">${esc(x[1])}</span>`).join('');
}

function go(page) {
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach(p => p.classList.toggle('active', p.dataset.pagePanel === page));
  $('#sidebar')?.classList.remove('open');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (page === 'files' || page === 'results') loadFiles();
  if (page === 'jobs') loadJobs();
  if (page === 'storage') loadStorage();
}

function setMode(mode) {
  state.sourceMode = mode;
  $('#linkInputWrap')?.classList.toggle('hidden', mode !== 'link');
  $('#fileInputWrap')?.classList.toggle('hidden', mode !== 'upload');
  $('#linkCard')?.classList.toggle('selected', mode === 'link');
  $('#uploadCard')?.classList.toggle('selected', mode === 'upload');
  const m = $('#message');
  if (m) m.textContent = mode === 'link' ? 'พร้อมรับลิงก์วิดีโอ' : 'เลือกไฟล์จากเครื่องเพื่ออัปโหลด';
}

async function api(path, opts = {}) {
  if (IS_GITHUB_PAGES && !window.WUXIA_API_BASE) throw new Error('หน้านี้เป็นตัวอย่าง กรุณาเปิดหน้า Cloudflare Worker เพื่อใช้งานจริง');
  const key = getAccessKey();
  const headers = { ...(opts.headers || {}), 'x-access-key': key };
  if (opts.body && !(opts.body instanceof FormData) && !(opts.body instanceof Blob) && !headers['content-type']) headers['content-type'] = 'application/json';
  const r = await fetch(API_BASE + path, { ...opts, headers, cache: 'no-store' });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { clearAccessKey(); throw new Error(data.error || 'รหัสเข้าใช้งานไม่ถูกต้อง'); }
  if (!r.ok) throw new Error(data.error || data.detail || `เกิดข้อผิดพลาด ${r.status}`);
  return data;
}

function showLoader(title, text = 'กำลังเตรียมงาน', pct = 2) {
  if (!$('#loadingOverlay')) return;
  $('#loadingTitle').textContent = title;
  $('#loadingText').textContent = text;
  $('#loadingPercent').textContent = Math.round(pct) + '%';
  $('#loadingBar').style.width = pct + '%';
  $('#loadingOverlay').classList.remove('hidden');
}
function updateLoader(text, pct) {
  if (!$('#loadingOverlay')) return;
  const old = Number($('#loadingPercent').textContent.replace('%', '')) || 0;
  const next = Math.max(old, Math.max(0, Math.min(100, Number(pct) || 0)));
  $('#loadingText').textContent = text;
  $('#loadingPercent').textContent = Math.round(next) + '%';
  $('#loadingBar').style.width = next + '%';
}
function hideLoader() { if ($('#loadingOverlay')) setTimeout(() => $('#loadingOverlay').classList.add('hidden'), 180); }

function uploadFingerprint(file) { return `${file.name}:${file.size}:${file.lastModified || 0}`; }
function resumeStorageKey(file) { return UPLOAD_RESUME_PREFIX + uploadFingerprint(file); }
function loadResume(file) { try { return JSON.parse(localStorage.getItem(resumeStorageKey(file)) || 'null'); } catch { return null; } }
function saveResume(file, value) { localStorage.setItem(resumeStorageKey(file), JSON.stringify(value)); }
function clearResume(file) { localStorage.removeItem(resumeStorageKey(file)); }

function showFileMeta(file) {
  const box = $('#fileMeta');
  if (!box) return;
  box.classList.remove('hidden');
  box.innerHTML = `<div><span>ชื่อไฟล์</span><b>${esc(file.name)}</b></div><div><span>ชนิดไฟล์</span><b>${esc(extLabel(file.name))}</b></div><div><span>ขนาด</span><b>${fmtBytes(file.size)}</b></div>`;
}

function baseLang(value) {
  return String(value || '').toLowerCase().split('-')[0].split('_')[0];
}

function youtubeVideoId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (host === 'youtu.be' || host === 'www.youtu.be') return u.pathname.split('/').filter(Boolean)[0] || '';
    if (host.endsWith('youtube.com')) {
      const id = u.searchParams.get('v');
      if (id) return id;
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length > 1 && ['shorts', 'embed', 'live'].includes(parts[0])) return parts[1];
    }
  } catch {}
  return '';
}

function decodeHarContent(content) {
  let raw = String(content?.text || '');
  if (String(content?.encoding || '').toLowerCase() !== 'base64') return raw;
  const binary = atob(raw.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function normalizedHarSubs(subs) {
  const out = [];
  for (const item of Array.isArray(subs) ? subs : []) {
    const raw = String(item?.url || '').trim();
    if (!raw) continue;
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      if (!(host === 'youtube.com' || host.endsWith('.youtube.com')) || u.pathname !== '/api/timedtext') continue;
      const videoId = String(u.searchParams.get('v') || '');
      const lang = String(u.searchParams.get('lang') || '');
      const fmt = String(u.searchParams.get('fmt') || item?.ext || '').toLowerCase();
      if (!videoId || !lang) continue;
      out.push({ url: u.toString(), videoId, lang, fmt, name: String(item?.name || lang) });
    } catch {}
  }
  return out;
}

function refreshHarCaption({ quiet = false } = {}) {
  if (!state.harSubs.length) return null;
  const target = baseLang($('#targetLang')?.value || 'th');
  const source = baseLang($('#sourceLang')?.value || 'auto');
  const formatRank = fmt => ({ srv1: 0, vtt: 1, srv2: 2, json3: 3, ttml: 4 }[fmt] ?? 9);
  const ranked = [...state.harSubs].sort((a, b) => formatRank(a.fmt) - formatRank(b.fmt));
  let chosen = ranked.find(x => baseLang(x.lang) === target);
  if (!chosen && source && source !== 'auto') chosen = ranked.find(x => baseLang(x.lang) === source);
  chosen ||= ranked[0] || null;
  if (!chosen) {
    state.captionUrl = null;
    state.captionMeta = null;
    if ($('#harStatus')) { $('#harStatus').textContent = 'ไม่พบลิงก์ซับที่ใช้ได้ใน HAR'; $('#harStatus').className = 'har-status error'; }
    return null;
  }

  const linkId = youtubeVideoId($('#videoUrl')?.value || '');
  if (linkId && chosen.videoId !== linkId) {
    state.captionUrl = null;
    state.captionMeta = chosen;
    if ($('#harStatus')) { $('#harStatus').textContent = `HAR เป็นวิดีโอ ${chosen.videoId} แต่ลิงก์ที่วางเป็น ${linkId}`; $('#harStatus').className = 'har-status error'; }
    if (!quiet) throw new Error('HAR นี้ไม่ตรงกับลิงก์ YouTube ที่วางไว้');
    return null;
  }

  state.captionUrl = chosen.url;
  state.captionMeta = chosen;
  const exact = baseLang(chosen.lang) === target;
  if ($('#harStatus')) {
    $('#harStatus').textContent = exact
      ? `พร้อมใช้ ซับ ${langLabel(chosen.lang)} รูปแบบ ${chosen.fmt || 'timedtext'}`
      : `พบซับ ${langLabel(chosen.lang)} ระบบจะแปลเป็น ${langLabel(target)}`;
    $('#harStatus').className = 'har-status ready';
  }
  return chosen;
}

async function importHar(file) {
  if (!file) return;
  if (!/\.har$/i.test(file.name) && file.type && !String(file.type).includes('json')) throw new Error('กรุณาเลือกไฟล์ .har');
  const root = JSON.parse(await file.text());
  const entries = Array.isArray(root?.log?.entries) ? root.log.entries : [];
  const found = [];
  for (const entry of entries) {
    const content = entry?.response?.content;
    if (!content?.text) continue;
    let body;
    try { body = JSON.parse(decodeHarContent(content)); } catch { continue; }
    if (Array.isArray(body?.subs)) found.push(...normalizedHarSubs(body.subs));
  }
  const unique = [...new Map(found.map(x => [x.url, x])).values()];
  if (!unique.length) throw new Error('ไม่พบ signed subtitle ของ YouTube ใน HAR นี้');
  state.harSubs = unique;
  state.harFileName = file.name;
  const selected = refreshHarCaption();
  if (!selected) throw new Error('ไม่พบซับที่ใช้ได้ใน HAR นี้');
  if (state.sourceMode === 'link' && !state.sourceKey) setMode('upload');
  if ($('#message')) $('#message').textContent = `✓ อ่าน HAR แล้ว พบซับ ${langLabel(selected.lang)} พร้อมใช้ เลือกวิดีโอต้นฉบับเพื่ออัปโหลดแล้วเริ่มพากย์ได้เลย`;
}

function xhrMultipartChunk({ key, uploadId, partNumber, chunk, file, overallStart }) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('key', key);
    form.append('uploadId', uploadId);
    form.append('partNumber', String(partNumber));
    form.append('chunk', chunk, `part-${String(partNumber).padStart(5, '0')}.bin`);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/api/uploads/chunk`, true);
    xhr.timeout = 180000;
    xhr.responseType = 'text';
    xhr.setRequestHeader('x-access-key', getAccessKey());
    xhr.upload.onprogress = e => {
      if (!e.lengthComputable) return;
      const sent = Math.min(file.size, overallStart + Math.min(chunk.size, e.loaded));
      const pct = file.size ? sent / file.size * 100 : 0;
      $('#uploadPct').textContent = Math.floor(pct) + '%';
      $('#uploadBar').style.width = pct + '%';
      $('#uploadStatus').textContent = `กำลังส่งไฟล์ ${fmtBytes(sent)} จาก ${fmtBytes(file.size)}`;
    };
    xhr.onload = () => {
      let data = {};
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch {}
      if (xhr.status === 401) { clearAccessKey(); reject(new Error(data.error || 'รหัสเข้าใช้งานไม่ถูกต้อง')); return; }
      if (xhr.status >= 200 && xhr.status < 300) { resolve(data); return; }
      reject(new Error(data.error || data.detail || `เกิดข้อผิดพลาด ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('ส่งไฟล์ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง'));
    xhr.ontimeout = () => reject(new Error('ส่งไฟล์ส่วนนี้นานเกินไป กรุณาลองอีกครั้ง'));
    xhr.onabort = () => reject(new Error('ยกเลิกการอัปโหลดแล้ว'));
    xhr.send(form);
  });
}

async function beginOrResumeUpload(file) {
  const saved = loadResume(file);
  if (saved?.key && saved?.uploadId && saved?.partSize) {
    try {
      const status = await api('/api/uploads/status', { method: 'POST', body: JSON.stringify({ key: saved.key, uploadId: saved.uploadId }) });
      if (status.complete) return { ...saved, nextOffset: file.size, resumed: true, alreadyComplete: true };
      if (!status.expired) return { ...saved, nextOffset: Number(status.nextOffset || 0), resumed: true };
    } catch (e) { console.warn('resume status failed, opening a new session', e); }
    clearResume(file);
  }
  const init = await api('/api/uploads/start', { method: 'POST', body: JSON.stringify({ name: file.name, size: file.size, type: file.type || 'application/octet-stream' }) });
  const fresh = { key: init.key, uploadId: init.uploadId, partSize: Number(init.partSize), nextOffset: 0, resumed: false };
  saveResume(file, fresh);
  return fresh;
}

async function uploadFile(file) {
  const ext = extOf(file.name);
  if (!SUPPORTED_EXTS.has(ext)) throw new Error(`ไม่รองรับ ${ext ? '.' + ext.toUpperCase() : 'ไฟล์นี้'} ใช้ MP4, MOV, MKV, WEBM, AVI หรือ M4V`);
  showFileMeta(file);
  $('#uploadProgress').classList.remove('hidden');
  $('#uploadName').textContent = `${file.name} (${extLabel(file.name)})`;
  $('#uploadPct').textContent = '0%';
  $('#uploadBar').style.width = '0%';
  $('#uploadStatus').textContent = 'กำลังเตรียมการอัปโหลด';

  let upload;
  try { upload = await beginOrResumeUpload(file); }
  catch (e) { throw new Error(`เริ่มอัปโหลดไม่สำเร็จ: ${e.message}`); }

  const { key, uploadId, partSize } = upload;
  if (!partSize || partSize % (256 * 1024) !== 0) throw new Error('ขนาดส่วนอัปโหลดจากเซิร์ฟเวอร์ไม่ถูกต้อง');
  let nextOffset = Math.min(file.size, Number(upload.nextOffset || 0));
  if (nextOffset && nextOffset % partSize !== 0 && nextOffset !== file.size) {
    await api('/api/uploads/abort', { method: 'POST', body: JSON.stringify({ key, uploadId }) }).catch(() => {});
    clearResume(file);
    throw new Error('ตำแหน่งอัปโหลดเดิมไม่ตรง กรุณาเลือกไฟล์ใหม่อีกครั้ง');
  }
  if (nextOffset > 0 && nextOffset < file.size) {
    $('#uploadStatus').textContent = `ทำต่อจาก ${fmtBytes(nextOffset)} จาก ${fmtBytes(file.size)}`;
    $('#uploadPct').textContent = Math.floor(nextOffset / file.size * 100) + '%';
    $('#uploadBar').style.width = nextOffset / file.size * 100 + '%';
  }

  const totalParts = Math.ceil(file.size / partSize);
  let partIndex = Math.floor(nextOffset / partSize);
  while (nextOffset < file.size) {
    const start = nextOffset;
    const end = Math.min(file.size, start + partSize);
    const chunk = file.slice(start, end, file.type || 'application/octet-stream');
    const partNumber = partIndex + 1;
    let lastError = null;
    let confirmed = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      $('#uploadStatus').textContent = `กำลังส่งส่วน ${partNumber}/${totalParts}${attempt > 1 ? ` ลองใหม่ครั้งที่ ${attempt}` : ''}`;
      try {
        confirmed = await xhrMultipartChunk({ key, uploadId, partNumber, chunk, file, overallStart: start });
        break;
      } catch (e) {
        lastError = e;
        try {
          const status = await api('/api/uploads/status', { method: 'POST', body: JSON.stringify({ key, uploadId }) });
          const remoteOffset = Number(status.nextOffset || 0);
          if (status.complete || remoteOffset >= end) { confirmed = { partNumber, recoveredByStatus: true }; break; }
        } catch (statusErr) { console.warn('resume check after chunk error failed', statusErr); }
        if (attempt < 5) await sleep(700 * attempt);
      }
    }
    if (!confirmed) throw new Error(`ส่งส่วน ${partNumber}/${totalParts} ไม่สำเร็จ: ${lastError?.message || 'การเชื่อมต่อมีปัญหา'}`);
    nextOffset = end;
    partIndex++;
    saveResume(file, { key, uploadId, partSize, nextOffset });
    const pct = nextOffset / file.size * 100;
    $('#uploadPct').textContent = Math.floor(pct) + '%';
    $('#uploadBar').style.width = pct + '%';
    $('#uploadStatus').textContent = `ส่งแล้ว ${fmtBytes(nextOffset)} จาก ${fmtBytes(file.size)} (${partIndex}/${totalParts})`;
  }

  $('#uploadStatus').textContent = 'ส่งครบแล้ว กำลังตรวจไฟล์';
  const done = await api('/api/uploads/complete', { method: 'POST', body: JSON.stringify({ key, uploadId }) });
  if (Number(done.size) !== Number(file.size)) throw new Error(`ขนาดไฟล์บน Google Drive ไม่ตรง ${done.size}/${file.size} bytes`);
  clearResume(file);
  state.sourceKey = key;
  $('#uploadPct').textContent = '100%';
  $('#uploadBar').style.width = '100%';
  $('#uploadStatus').textContent = `อัปโหลดเสร็จแล้ว ${extLabel(file.name)} พร้อมเริ่มพากย์`;
  await loadStorage();
  return key;
}

function updateSpeedNote() {
  const mode = $('#processingMode')?.value || 'fast';
  const map = {
    fast: ['โหมดเร็ว', 'แบ่งวิดีโอช่วงละประมาณ 5 นาที และทำพร้อมกันได้สูงสุด 4 ช่วง'],
    balanced: ['โหมดสมดุล', 'แบ่งวิดีโอช่วงละประมาณ 7 นาที ใช้เวลามากขึ้นเพื่อเพิ่มความแม่นยำ'],
    quality: ['โหมดคุณภาพสูง', 'แบ่งวิดีโอช่วงละประมาณ 10 นาที เน้นความแม่นยำและใช้เวลามากที่สุด'],
  };
  const [title, text] = map[mode];
  if ($('#speedNote')) $('#speedNote').innerHTML = `<b>${title}</b><span>${text}</span>`;
}

async function createJob() {
  const payload = {
    title: 'งานพากย์ ' + new Date().toLocaleString('th-TH'),
    sourceType: state.sourceMode,
    sourceKey: state.sourceKey,
    sourceUrl: $('#videoUrl')?.value.trim() || null,
    sourceLang: $('#sourceLang')?.value || 'auto',
    targetLang: $('#targetLang')?.value || 'th',
    voiceMode: $('#voiceMode')?.value || 'auto',
    processingMode: $('#processingMode')?.value || 'fast',
    subtitles: $('#subtitles')?.checked === true,
    keepMusic: $('#keepMusic')?.checked === true,
    speakerSeparation: $('#speakerSep')?.checked === true,
    autoCleanup: $('#autoCleanup')?.checked === true,
    captionUrl: state.captionUrl || null,
    captionSource: state.captionUrl ? 'bunny-har' : null,
    captionLanguage: state.captionMeta?.lang || null,
    captionFormat: state.captionMeta?.fmt || null,
    captionVideoId: state.captionMeta?.videoId || null,
  };
  if (payload.sourceType === 'link' && !payload.sourceUrl) throw new Error('กรุณาวางลิงก์ก่อน');
  if (payload.sourceType === 'upload' && !payload.sourceKey) throw new Error('กรุณาอัปโหลดไฟล์ให้เสร็จก่อน');
  if (payload.captionUrl) {
    refreshHarCaption();
    payload.captionUrl = state.captionUrl;
    payload.captionLanguage = state.captionMeta?.lang || null;
    payload.captionFormat = state.captionMeta?.fmt || null;
    payload.captionVideoId = state.captionMeta?.videoId || null;
  }

  showLoader('กำลังสร้างงานพากย์', 'กำลังส่งงานเข้าคิว', 2);
  const data = await api('/api/jobs', { method: 'POST', body: JSON.stringify(payload) });
  updateLoader(data.dispatch?.triggered ? 'เริ่มประมวลผลแล้ว' : 'สร้างงานแล้ว แต่ยังเริ่มประมวลผลไม่ได้', 3);
  setTimeout(hideLoader, 420);
  $('#message').textContent = data.dispatch?.triggered ? '✓ เริ่มประมวลผลแล้ว สามารถดูความคืบหน้าได้ด้านล่าง' : 'สร้างงานแล้ว แต่ระบบประมวลผลยังไม่พร้อม';
  await Promise.all([loadJobs(), loadStorage()]);
}

async function extractLinkTranscript() {
  const sourceUrl = $('#videoUrl')?.value.trim();
  if (!sourceUrl) throw new Error('กรุณาวางลิงก์ YouTube ก่อน');
  try {
    const u = new URL(sourceUrl);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('bad protocol');
  } catch {
    throw new Error('กรุณาตรวจสอบลิงก์อีกครั้ง');
  }

  const targetLang = $('#targetLang')?.value || 'th';
  const payload = {
    jobType: 'transcript',
    title: `คำบรรยาย YouTube ${new Date().toLocaleString('th-TH')}`,
    sourceType: 'link',
    sourceUrl,
    sourceLang: $('#sourceLang')?.value || 'auto',
    targetLang,
    subtitles: true,
    keepMusic: false,
    speakerSeparation: false,
    autoCleanup: false,
    captionUrl: state.captionUrl || null,
    captionSource: state.captionUrl ? 'bunny-har' : null,
    captionLanguage: state.captionMeta?.lang || null,
    captionFormat: state.captionMeta?.fmt || null,
    captionVideoId: state.captionMeta?.videoId || null,
  };

  showLoader('กำลังดึงคำบรรยาย', 'กำลังอ่านซับและเวลาเริ่ม–จบจาก YouTube', 5);
  const data = await api('/api/jobs', { method: 'POST', body: JSON.stringify(payload) });
  updateLoader(data.dispatch?.triggered ? 'ส่งงานดึงคำบรรยายแล้ว' : 'สร้างงานแล้ว แต่ระบบยังเริ่มไม่ได้', 15);
  $('#message').textContent = data.dispatch?.triggered
    ? `✓ กำลังดึงคำบรรยายเป็น ${langLabel(targetLang)} เมื่อเสร็จจะมีปุ่ม XML ซับ และคำบรรยาย`
    : 'สร้างงานแล้ว แต่ระบบดึงคำบรรยายยังไม่พร้อม';
  await loadJobs();
  setTimeout(hideLoader, 500);
}

async function controlJob(id, action) {
  const text = action === 'pause' ? 'กำลังหยุดงาน' : action === 'resume' ? 'กำลังทำงานต่อ' : 'กำลังลองใหม่';
  if ($('#message')) $('#message').textContent = text;
  const data = await api(`/api/jobs/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' });
  if ($('#message')) {
    $('#message').textContent = action === 'pause'
      ? '⏸ สั่งหยุดชั่วคราวแล้ว ระบบจะหยุดที่จุดที่ปลอดภัย'
      : action === 'resume'
        ? '▶ เริ่มทำต่อจากช่วงที่ทำไว้แล้ว'
        : '↻ เริ่มลองใหม่จากช่วงที่ทำไว้แล้ว';
  }
  await loadJobs();
  return data;
}

function friendlyError(error) {
  const raw = String(error || '');
  if (!raw) return '';
  if (raw.includes('GitHub Actions pipeline failed')) return 'ประมวลผลไม่สำเร็จ สามารถกดลองใหม่ได้';
  if (raw.includes('Google Drive upload failed')) return 'บันทึกไฟล์ลง Google Drive ไม่สำเร็จ สามารถกดลองใหม่ได้';
  if (raw.length > 360) return raw.slice(0, 350) + '…';
  return raw;
}

function jobHtml(j) {
  const raw = Math.max(0, Math.min(100, Number(j.progress) || 0));
  const floor = Number(state.progressFloor[j.id] || 0);
  const p = Math.max(raw, floor);
  state.progressFloor[j.id] = p;
  const statusText = j.status === 'completed' ? 'เสร็จสมบูรณ์' : j.status === 'paused' ? 'หยุดชั่วคราว' : (j.stage || j.status || 'เข้าคิว');
  const statusClass = j.status === 'failed' ? 'failed' : j.status === 'completed' ? 'completed' : 'processing';
  const err = friendlyError(j.error);
  const mode = j.processingMode === 'quality' ? 'คุณภาพสูง' : j.processingMode === 'balanced' ? 'สมดุล' : 'เร็ว';
  const jobMeta = j.jobType === 'transcript'
    ? `คำบรรยาย YouTube ${langLabel(j.sourceLang)} → ${langLabel(j.targetLang)}`
    : `ต้นฉบับ ${langLabel(j.sourceLang)} พากย์เป็น ${langLabel(j.targetLang)} โหมด${mode}`;
  const control = j.status === 'failed'
    ? `<button class="mini-btn" data-job-action="retry" data-job-id="${esc(j.id)}">↻ ลองใหม่</button>`
    : j.status === 'paused'
      ? `<button class="mini-btn" data-job-action="resume" data-job-id="${esc(j.id)}">▶ ทำต่อ</button>`
      : (j.status === 'queued' || j.status === 'processing')
        ? `<button class="mini-btn" data-job-action="pause" data-job-id="${esc(j.id)}">⏸ หยุดชั่วคราว</button>`
        : '';
  return `<article class="job-card ${statusClass}">
    <div class="job-top"><div class="job-copy"><div class="job-title">${esc(j.title)}</div><div class="job-meta">${esc(jobMeta)}</div><div class="job-stage"><span></span>${esc(statusText)}</div>${err ? `<div class="job-error">${esc(err)}</div>` : ''}</div>
    <div class="job-actions">${control}${j.outputKey ? `<button class="mini-btn" data-file="${esc(j.outputKey)}">ดาวน์โหลด MP4</button>` : ''}${j.subtitleKey ? `<button class="mini-btn" data-file="${esc(j.subtitleKey)}">คำบรรยาย</button>` : ''}${j.transcriptXmlKey ? `<button class="mini-btn" data-file="${esc(j.transcriptXmlKey)}">XML ซับ</button>` : ''}<button class="mini-btn danger" data-delete-job="${esc(j.id)}">ลบ</button></div></div>
    <div class="sword-progress job-sword"><i><em style="width:${p}%"></em></i><span class="sword-hilt">◆</span></div>
    <div class="job-foot"><b>${p}%</b><span>อัปเดต ${new Date(j.updatedAt || j.createdAt).toLocaleString('th-TH')}</span></div>
  </article>`;
}

async function loadJobs() {
  try {
    const d = await api('/api/jobs');
    state.jobs = d.jobs || [];
    const html = state.jobs.length ? state.jobs.map(jobHtml).join('') : 'ยังไม่มีงาน';
    $('#jobsList')?.classList.toggle('empty-state', !state.jobs.length);
    if ($('#jobsList')) $('#jobsList').innerHTML = html;
    $('#homeJobs')?.classList.toggle('empty-state', !state.jobs.length);
    if ($('#homeJobs')) $('#homeJobs').innerHTML = state.jobs.length ? state.jobs.slice(0, 3).map(jobHtml).join('') : 'ยังไม่มีงานพากย์';
  } catch (e) {
    if ($('#homeJobs')) $('#homeJobs').textContent = e.message || 'เชื่อมต่อระบบไม่ได้';
  }
}

function fileRow(f) {
  const name = f.key.split('/').pop();
  const when = new Date(f.uploaded).toLocaleString('th-TH');
  return `<div class="file-row"><div><b>${esc(name)}</b><div class="file-meta">ชนิด ${esc(extLabel(name))} ขนาด ${fmtBytes(f.size)} อัปโหลด ${when}</div></div><div class="file-actions">${f.key.startsWith('outputs/') ? `<button class="mini-btn" data-file="${esc(f.key)}">ดาวน์โหลด</button>` : ''}<button class="mini-btn danger" data-delete-file="${esc(f.key)}">ลบ</button></div></div>`;
}

async function loadFiles() {
  try {
    const d = await api('/api/files');
    state.files = d.files || [];
    const src = state.files.filter(f => f.key.startsWith('uploads/'));
    const out = state.files.filter(f => f.key.startsWith('outputs/'));
    const mk = list => list.length ? list.map(fileRow).join('') : 'ยังไม่มีไฟล์';
    $('#filesList')?.classList.toggle('empty-state', !src.length);
    if ($('#filesList')) $('#filesList').innerHTML = mk(src);
    $('#resultsList')?.classList.toggle('empty-state', !out.length);
    if ($('#resultsList')) $('#resultsList').innerHTML = mk(out);
  } catch (e) { console.warn(e); }
}

async function loadStorage() {
  try {
    const d = await api('/api/storage');
    state.storage = d;
    const gb = d.bytes / 1024 ** 3;
    const limit = d.limitBytes / 1024 ** 3;
    const pct = Math.min(100, d.limitBytes ? d.bytes / d.limitBytes * 100 : 0);
    if ($('#topStorage')) $('#topStorage').textContent = `${gb.toFixed(2)} GB / ${limit.toFixed(0)} GB`;
    if ($('#topStorageBar')) $('#topStorageBar').style.width = pct + '%';
    if ($('#ringGb')) $('#ringGb').textContent = gb.toFixed(2);
    if ($('#ringText')) $('#ringText').textContent = `${gb.toFixed(2)} GB`;
    $('.storage-ring')?.style.setProperty('--p', pct + '%');
    const g = d.groups || {};
    if ($('#storageBreakdown')) $('#storageBreakdown').innerHTML = `<div><span><i class="dot upload"></i>ต้นฉบับ</span><b>${fmtBytes(g.uploads)}</b></div><div><span><i class="dot temp"></i>ชั่วคราว</span><b>${fmtBytes(g.temp)}</b></div><div><span><i class="dot output"></i>ผลลัพธ์</span><b>${fmtBytes(g.outputs)}</b></div>`;
    if ($('#stTotal')) $('#stTotal').textContent = fmtBytes(d.bytes);
    if ($('#stUpload')) $('#stUpload').textContent = fmtBytes(g.uploads);
    if ($('#stTemp')) $('#stTemp').textContent = fmtBytes(g.temp);
    if ($('#stOutput')) $('#stOutput').textContent = fmtBytes(g.outputs);
    const cleanupButtons = [
      ['#cleanupUploadsBtn', 'ลบต้นฉบับ', Number(g.uploads || 0)],
      ['#cleanupBtn', 'ลบไฟล์ชั่วคราว', Number(g.temp || 0)],
      ['#cleanupOutputsBtn', 'ลบผลลัพธ์', Number(g.outputs || 0)],
      ['#cleanupAllBtn', 'ล้างทั้งหมด', Number(d.bytes || 0)],
    ];
    for (const [selector, label, bytes] of cleanupButtons) {
      const btn = $(selector);
      if (!btn) continue;
      btn.textContent = `${label} (${fmtBytes(bytes)})`;
      btn.disabled = bytes <= 0;
    }
  } catch (e) { console.warn(e); }
}

function downloadFile(key) {
  const k = getAccessKey();
  window.open(`${API_BASE}/api/files/download?key=${encodeURIComponent(key)}&access_key=${encodeURIComponent(k)}`, '_blank', 'noopener');
}

function bind() {
  $$('.nav-item').forEach(b => b.addEventListener('click', () => go(b.dataset.page)));
  $$('[data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
  $('#seeJobs')?.addEventListener('click', () => go('jobs'));
  $('#menuBtn')?.addEventListener('click', () => $('#sidebar')?.classList.toggle('open'));
  $('#linkCard')?.addEventListener('click', () => setMode('link'));
  $('#uploadCard')?.addEventListener('click', () => setMode('upload'));
  $('#processingMode')?.addEventListener('change', updateSpeedNote);
  $('#targetLang')?.addEventListener('change', () => { try { refreshHarCaption({ quiet: true }); } catch {} });
  $('#sourceLang')?.addEventListener('change', () => { try { refreshHarCaption({ quiet: true }); } catch {} });
  $('#videoUrl')?.addEventListener('input', () => { if (state.harSubs.length) refreshHarCaption({ quiet: true }); });
  $('#harInput')?.addEventListener('change', async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    if ($('#harStatus')) { $('#harStatus').textContent = 'กำลังอ่าน HAR'; $('#harStatus').className = 'har-status'; }
    try { await importHar(f); }
    catch (err) {
      state.captionUrl = null; state.captionMeta = null; state.harSubs = [];
      if ($('#harStatus')) { $('#harStatus').textContent = err.message; $('#harStatus').className = 'har-status error'; }
      if ($('#message')) $('#message').textContent = err.message;
    }
  });

  $('#analyzeLinkBtn')?.addEventListener('click', async () => {
    try { await extractLinkTranscript(); }
    catch (e) { hideLoader(); $('#message').textContent = e.message; }
  });

  $('#fileInput')?.addEventListener('change', async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      state.sourceKey = null;
      showFileMeta(f);
      showLoader('กำลังเตรียมไฟล์', `${f.name} ${extLabel(f.name)} ${fmtBytes(f.size)}`, 1);
      hideLoader();
      await uploadFile(f);
    } catch (err) {
      $('#uploadStatus').textContent = 'อัปโหลดไม่สำเร็จ: ' + err.message;
    }
  });

  $('#startBtn')?.addEventListener('click', async () => {
    try { await createJob(); }
    catch (e) { hideLoader(); $('#message').textContent = e.message; }
  });
  $('#refreshBtn')?.addEventListener('click', () => Promise.all([loadJobs(), loadFiles(), loadStorage()]));
  const cleanupActions = [
    ['#cleanupUploadsBtn', 'uploads', 'ไฟล์ต้นฉบับ', 'ลบไฟล์ต้นฉบับทั้งหมดหรือไม่? งานที่ยังต้องใช้ต้นฉบับอาจทำต่อไม่ได้'],
    ['#cleanupBtn', 'temp', 'ไฟล์ชั่วคราว', 'ลบไฟล์ชั่วคราวทั้งหมดหรือไม่? งานที่กำลังทำอยู่ควรหยุดให้เรียบร้อยก่อน'],
    ['#cleanupOutputsBtn', 'outputs', 'ไฟล์ผลลัพธ์', 'ลบไฟล์ผลลัพธ์ทั้งหมดหรือไม่? ไฟล์ที่ยังไม่ได้ดาวน์โหลดจะหายไป'],
    ['#cleanupAllBtn', 'all', 'ไฟล์ทั้งหมด', 'ล้างไฟล์และประวัติงานทั้งหมดหรือไม่? การกระทำนี้ย้อนกลับไม่ได้'],
  ];
  for (const [selector, kind, label, question] of cleanupActions) {
    $(selector)?.addEventListener('click', async () => {
      if (!confirm(question)) return;
      showLoader(`กำลังลบ${label}`, 'กำลังคืนพื้นที่', 35);
      try {
        let totalFreed = 0;
        let result = { remaining: 1 };
        let round = 0;
        while (Number(result.remaining || 0) > 0 && round < 100) {
          result = await api(`/api/cleanup/${kind}`, { method: 'POST', body: '{}' });
          totalFreed += Number(result.freedBytes || 0);
          round += 1;
          if (Number(result.remaining || 0) > 0) {
            updateLoader(`กำลังลบ${label} เหลือ ${result.remaining} รายการ`, Math.min(92, 35 + round * 6));
          }
        }
        if (Number(result.remaining || 0) > 0) throw new Error('ยังลบไฟล์ไม่หมด กรุณากดลองอีกครั้ง');
        updateLoader(`ลบแล้ว คืนพื้นที่ ${fmtBytes(totalFreed)}`, 100);
        if (kind === 'uploads' || kind === 'all') state.sourceKey = null;
        if (kind === 'all') state.progressFloor = {};
        await Promise.all([loadJobs(), loadFiles(), loadStorage()]);
      } catch (err) {
        updateLoader(err.message || 'ลบไฟล์ไม่สำเร็จ', 100);
      } finally {
        setTimeout(hideLoader, 650);
      }
    });
  }

  document.body.addEventListener('click', async e => {
    const dl = e.target.closest('[data-file]');
    if (dl) { downloadFile(dl.dataset.file); return; }

    const control = e.target.closest('[data-job-action]');
    if (control) {
      try { await controlJob(control.dataset.jobId, control.dataset.jobAction); }
      catch (err) {
        if ($('#message')) $('#message').textContent = err.message;
        else window.alert(err.message);
      }
      return;
    }

    const jb = e.target.closest('[data-delete-job]');
    if (jb && confirm('ลบงานนี้และไฟล์ที่เกี่ยวข้องหรือไม่?')) {
      await api('/api/jobs/' + jb.dataset.deleteJob, { method: 'DELETE' });
      delete state.progressFloor[jb.dataset.deleteJob];
      await Promise.all([loadJobs(), loadFiles(), loadStorage()]);
      return;
    }

    const fb = e.target.closest('[data-delete-file]');
    if (fb && confirm('ลบไฟล์นี้เพื่อคืนพื้นที่หรือไม่?')) {
      await api('/api/files?key=' + encodeURIComponent(fb.dataset.deleteFile), { method: 'DELETE' });
      await Promise.all([loadFiles(), loadStorage()]);
    }
  });

  $$('.voice-card').forEach(c => c.addEventListener('click', () => {
    $$('.voice-card').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
  }));
}

initSparks();
fillLangs();
bind();
updateSpeedNote();
setMode('link');

if (IS_GITHUB_PAGES && !window.WUXIA_API_BASE) {
  if ($('#deployMode')) $('#deployMode').textContent = 'หน้าตัวอย่าง';
  if ($('#message')) $('#message').textContent = 'หน้านี้ใช้ดูตัวอย่าง กรุณาเปิด Cloudflare Worker เพื่อใช้งานจริง';
  if ($('#topStorage')) $('#topStorage').textContent = 'ตัวอย่าง';
  if ($('#homeJobs')) $('#homeJobs').textContent = 'หน้าตัวอย่างพร้อมใช้งาน';
} else {
  if ($('#deployMode')) $('#deployMode').textContent = 'พร้อมใช้งาน';
  Promise.all([loadJobs(), loadFiles(), loadStorage()]);
  setInterval(() => { if (!document.hidden) loadJobs(); }, 6000);
}
