const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const LANGS = [
  ['auto', 'ตรวจอัตโนมัติ'], ['th', 'ไทย'], ['zh', 'จีน (แมนดาริน)'], ['en', 'อังกฤษ'],
  ['ja', 'ญี่ปุ่น'], ['ko', 'เกาหลี'], ['vi', 'เวียดนาม'], ['id', 'อินโดนีเซีย'],
  ['ms', 'มาเลย์'], ['es', 'สเปน'], ['fr', 'ฝรั่งเศส'], ['de', 'เยอรมัน'],
  ['pt', 'โปรตุเกส'], ['ru', 'รัสเซีย'], ['ar', 'อาหรับ'], ['hi', 'ฮินดี'],
  ['it', 'อิตาลี'], ['tr', 'ตุรกี'], ['nl', 'ดัตช์'], ['pl', 'โปแลนด์'],
];

const state = { sourceMode: 'link', sourceKey: null, jobs: [], files: [], storage: null };
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

function getAccessKey() {
  if (accessKey) return accessKey;
  const key = window.prompt('กรอกรหัสสำนักเพื่อเข้าใช้งานระบบ');
  if (!key) throw new Error('ต้องใส่รหัสสำนักก่อนใช้งาน');
  accessKey = key.trim();
  sessionStorage.setItem(ACCESS_KEY_SESSION, accessKey);
  return accessKey;
}

function clearAccessKey() {
  accessKey = '';
  sessionStorage.removeItem(ACCESS_KEY_SESSION);
}

function initSparks() {
  const field = $('#sparkField');
  if (!field) return;
  for (let i = 0; i < 32; i++) {
    const s = document.createElement('i');
    s.className = 'spark';
    s.style.left = Math.random() * 100 + '%';
    s.style.top = 20 + Math.random() * 85 + '%';
    s.style.setProperty('--dur', 5 + Math.random() * 7 + 's');
    s.style.setProperty('--drift', -40 + Math.random() * 80 + 'px');
    s.style.animationDelay = -Math.random() * 8 + 's';
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
  const m = $('#message');
  if (m) m.textContent = mode === 'link' ? 'โหมดลิงก์พร้อมแล้ว' : 'โหมดอัปโหลดไฟล์พร้อมแล้ว';
}

async function api(path, opts = {}) {
  if (IS_GITHUB_PAGES && !window.WUXIA_API_BASE) throw new Error('GitHub Pages เป็นหน้า Preview — ใช้ URL Cloudflare Worker สำหรับระบบจริง');
  const key = getAccessKey();
  const headers = { ...(opts.headers || {}), 'x-access-key': key };
  if (opts.body && !(opts.body instanceof FormData) && !(opts.body instanceof Blob) && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }
  const r = await fetch(API_BASE + path, { ...opts, headers, cache: 'no-store' });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) {
    clearAccessKey();
    throw new Error(data.error || 'รหัสสำนักไม่ถูกต้อง');
  }
  if (!r.ok) throw new Error(data.error || data.detail || `HTTP ${r.status}`);
  return data;
}

function showLoader(title, text = 'กำลังเตรียมงาน', pct = 5) {
  if (!$('#loadingOverlay')) return;
  $('#loadingTitle').textContent = title;
  $('#loadingText').textContent = text;
  $('#loadingPercent').textContent = pct + '%';
  $('#loadingBar').style.width = pct + '%';
  $('#loadingOverlay').classList.remove('hidden');
}

function updateLoader(text, pct) {
  if (!$('#loadingOverlay')) return;
  $('#loadingText').textContent = text;
  $('#loadingPercent').textContent = Math.round(pct) + '%';
  $('#loadingBar').style.width = Math.max(0, Math.min(100, pct)) + '%';
}

function hideLoader() {
  if (!$('#loadingOverlay')) return;
  setTimeout(() => $('#loadingOverlay').classList.add('hidden'), 250);
}

function uploadFingerprint(file) {
  return `${file.name}:${file.size}:${file.lastModified || 0}`;
}

function resumeStorageKey(file) {
  return UPLOAD_RESUME_PREFIX + uploadFingerprint(file);
}

function loadResume(file) {
  try {
    return JSON.parse(localStorage.getItem(resumeStorageKey(file)) || 'null');
  } catch {
    return null;
  }
}

function saveResume(file, value) {
  localStorage.setItem(resumeStorageKey(file), JSON.stringify(value));
}

function clearResume(file) {
  localStorage.removeItem(resumeStorageKey(file));
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
      $('#uploadStatus').textContent = `กำลังส่งไฟล์ · ${fmtBytes(sent)} / ${fmtBytes(file.size)}`;
    };

    xhr.onload = () => {
      let data = {};
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch {}
      if (xhr.status === 401) {
        clearAccessKey();
        reject(new Error(data.error || 'รหัสสำนักไม่ถูกต้อง'));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
        return;
      }
      reject(new Error(data.error || data.detail || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('เบราว์เซอร์ส่ง multipart ไป Cloudflare ไม่สำเร็จ'));
    xhr.ontimeout = () => reject(new Error('ส่งช่วงนี้เกิน 180 วินาที'));
    xhr.onabort = () => reject(new Error('การอัปโหลดถูกยกเลิก'));
    xhr.send(form);
  });
}

async function beginOrResumeUpload(file) {
  const saved = loadResume(file);
  if (saved?.key && saved?.uploadId && saved?.partSize) {
    try {
      const status = await api('/api/uploads/status', {
        method: 'POST',
        body: JSON.stringify({ key: saved.key, uploadId: saved.uploadId }),
      });
      if (status.complete) {
        return { ...saved, nextOffset: file.size, resumed: true, alreadyComplete: true };
      }
      if (!status.expired) {
        return { ...saved, nextOffset: Number(status.nextOffset || 0), resumed: true };
      }
    } catch (e) {
      console.warn('resume status failed, opening a new session', e);
    }
    clearResume(file);
  }

  const init = await api('/api/uploads/start', {
    method: 'POST',
    body: JSON.stringify({ name: file.name, size: file.size, type: file.type || 'application/octet-stream' }),
  });
  const fresh = { key: init.key, uploadId: init.uploadId, partSize: Number(init.partSize), nextOffset: 0, resumed: false };
  saveResume(file, fresh);
  return fresh;
}

async function uploadFile(file) {
  $('#uploadProgress').classList.remove('hidden');
  $('#uploadName').textContent = file.name;
  $('#uploadPct').textContent = '0%';
  $('#uploadBar').style.width = '0%';
  $('#uploadStatus').textContent = 'กำลังเปิด session อัปโหลดใหม่...';

  let upload;
  try {
    upload = await beginOrResumeUpload(file);
  } catch (e) {
    throw new Error(`เริ่มอัปโหลดไม่สำเร็จ: ${e.message}`);
  }

  const { key, uploadId, partSize } = upload;
  if (!partSize || partSize % (256 * 1024) !== 0) throw new Error('ขนาด chunk จากเซิร์ฟเวอร์ไม่ถูกต้อง');

  let nextOffset = Math.min(file.size, Number(upload.nextOffset || 0));
  if (nextOffset && nextOffset % partSize !== 0 && nextOffset !== file.size) {
    await api('/api/uploads/abort', { method: 'POST', body: JSON.stringify({ key, uploadId }) }).catch(() => {});
    clearResume(file);
    throw new Error('ตำแหน่ง Resume ไม่ตรงกับขอบ chunk กรุณาเลือกไฟล์ใหม่อีกครั้ง');
  }

  if (nextOffset > 0 && nextOffset < file.size) {
    $('#uploadStatus').textContent = `Resume จาก ${fmtBytes(nextOffset)} / ${fmtBytes(file.size)}`;
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
      $('#uploadStatus').textContent = `กำลังส่งส่วน ${partNumber}/${totalParts}${attempt > 1 ? ` · ลองใหม่ ${attempt}/5` : ''}`;
      try {
        confirmed = await xhrMultipartChunk({ key, uploadId, partNumber, chunk, file, overallStart: start });
        break;
      } catch (e) {
        lastError = e;
        try {
          const status = await api('/api/uploads/status', {
            method: 'POST',
            body: JSON.stringify({ key, uploadId }),
          });
          const remoteOffset = Number(status.nextOffset || 0);
          if (status.complete || remoteOffset >= end) {
            confirmed = { partNumber, recoveredByStatus: true };
            break;
          }
        } catch (statusErr) {
          console.warn('resume check after chunk error failed', statusErr);
        }
        if (attempt < 5) await sleep(800 * attempt);
      }
    }

    if (!confirmed) {
      throw new Error(`ส่วน ${partNumber}/${totalParts} ไม่สำเร็จ: ${lastError?.message || 'network error'}`);
    }

    nextOffset = end;
    partIndex++;
    saveResume(file, { key, uploadId, partSize, nextOffset });
    const pct = nextOffset / file.size * 100;
    $('#uploadPct').textContent = Math.floor(pct) + '%';
    $('#uploadBar').style.width = pct + '%';
    $('#uploadStatus').textContent = `Google Drive รับแล้ว ${fmtBytes(nextOffset)} / ${fmtBytes(file.size)} · ${partIndex}/${totalParts}`;
  }

  $('#uploadStatus').textContent = 'ส่งครบแล้ว · กำลังตรวจขนาดไฟล์ใน Google Drive';
  const done = await api('/api/uploads/complete', {
    method: 'POST',
    body: JSON.stringify({ key, uploadId }),
  });
  if (Number(done.size) !== Number(file.size)) throw new Error(`ขนาดไฟล์บน Drive ไม่ตรง: ${done.size}/${file.size} bytes`);

  clearResume(file);
  state.sourceKey = key;
  $('#uploadPct').textContent = '100%';
  $('#uploadBar').style.width = '100%';
  $('#uploadStatus').textContent = 'อัปโหลดเสร็จแล้ว · พร้อมสร้างงานพากย์';
  await loadStorage();
  return key;
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
    subtitles: $('#subtitles')?.checked !== false,
    keepMusic: $('#keepMusic')?.checked !== false,
    speakerSeparation: $('#speakerSep')?.checked !== false,
    autoCleanup: $('#autoCleanup')?.checked !== false,
  };
  if (payload.sourceType === 'link' && !payload.sourceUrl) throw new Error('กรุณาวางลิงก์ก่อน');
  if (payload.sourceType === 'upload' && !payload.sourceKey) throw new Error('กรุณาอัปโหลดไฟล์ให้เสร็จก่อน');

  showLoader('กำลังเปิดคัมภีร์งานพากย์', 'บันทึกงานลงคลัง', 18);
  const data = await api('/api/jobs', { method: 'POST', body: JSON.stringify(payload) });
  updateLoader(data.dispatch?.triggered ? 'ส่งงานเข้า GitHub Actions แล้ว' : 'สร้างงานแล้ว แต่ dispatch ยังไม่พร้อม', 100);
  setTimeout(hideLoader, 600);
  $('#message').textContent = data.dispatch?.triggered ? '✓ เริ่มประมวลผลแล้ว' : '✓ สร้างงานแล้ว แต่ backend ยัง dispatch ไม่ได้';
  await Promise.all([loadJobs(), loadStorage()]);
}

function jobHtml(j) {
  const p = Math.max(0, Math.min(100, Number(j.progress) || 0));
  const status = j.status === 'completed' ? 'เสร็จสมบูรณ์' : (j.stage || j.status || 'เข้าคิว');
  return `<article class="job-card"><div class="job-top"><div><div class="job-title">${esc(j.title)}</div><div class="job-meta">${esc(j.sourceLang)} → ${esc(j.targetLang)} · ${esc(status)}</div>${j.error ? `<div class="job-meta" style="color:#ff9c9c">${esc(j.error)}</div>` : ''}</div><div class="job-actions">${j.outputKey ? `<button class="mini-btn" data-file="${esc(j.outputKey)}">ดาวน์โหลด MP4</button>` : ''}${j.subtitleKey ? `<button class="mini-btn" data-file="${esc(j.subtitleKey)}">SRT</button>` : ''}<button class="mini-btn danger" data-delete-job="${esc(j.id)}">ลบ</button></div></div><div class="progress"><i style="width:${p}%"></i></div><div class="job-meta">${p}% · อัปเดต ${new Date(j.updatedAt || j.createdAt).toLocaleString('th-TH')}</div></article>`;
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
    if ($('#homeJobs')) $('#homeJobs').textContent = e.message || 'ยังเชื่อม API ไม่ได้';
  }
}

async function loadFiles() {
  try {
    const d = await api('/api/files');
    state.files = d.files || [];
    const mk = list => list.length ? list.map(f => `<div class="file-row"><div><b>${esc(f.key.split('/').pop())}</b><div class="file-meta">${fmtBytes(f.size)} · ${new Date(f.uploaded).toLocaleString('th-TH')}</div></div><div class="file-actions">${f.key.startsWith('outputs/') ? `<button class="mini-btn" data-file="${esc(f.key)}">ดาวน์โหลด</button>` : ''}<button class="mini-btn danger" data-delete-file="${esc(f.key)}">ลบ</button></div></div>`).join('') : 'ยังไม่มีไฟล์';
    const src = state.files.filter(f => f.key.startsWith('uploads/'));
    const out = state.files.filter(f => f.key.startsWith('outputs/'));
    $('#filesList')?.classList.toggle('empty-state', !src.length);
    if ($('#filesList')) $('#filesList').innerHTML = mk(src);
    $('#resultsList')?.classList.toggle('empty-state', !out.length);
    if ($('#resultsList')) $('#resultsList').innerHTML = mk(out);
  } catch (e) {
    console.warn(e);
  }
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
    if ($('#storageBreakdown')) $('#storageBreakdown').innerHTML = `<div><span><i style="background:#39d9c1"></i>ต้นฉบับ</span><b>${fmtBytes(g.uploads)}</b></div><div><span><i style="background:#e7b85c"></i>ชั่วคราว</span><b>${fmtBytes(g.temp)}</b></div><div><span><i style="background:#6ad6a2"></i>ผลลัพธ์</span><b>${fmtBytes(g.outputs)}</b></div>`;
    if ($('#stTotal')) $('#stTotal').textContent = fmtBytes(d.bytes);
    if ($('#stUpload')) $('#stUpload').textContent = fmtBytes(g.uploads);
    if ($('#stTemp')) $('#stTemp').textContent = fmtBytes(g.temp);
    if ($('#stOutput')) $('#stOutput').textContent = fmtBytes(g.outputs);
  } catch (e) {
    console.warn(e);
  }
}

function downloadFile(key) {
  const k = getAccessKey();
  const url = `${API_BASE}/api/files/download?key=${encodeURIComponent(key)}&access_key=${encodeURIComponent(k)}`;
  window.open(url, '_blank', 'noopener');
}

function bind() {
  $$('.nav-item').forEach(b => b.addEventListener('click', () => go(b.dataset.page)));
  $$('[data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
  $('#seeJobs')?.addEventListener('click', () => go('jobs'));
  $('#menuBtn')?.addEventListener('click', () => $('#sidebar')?.classList.toggle('open'));
  $('#linkCard')?.addEventListener('click', () => setMode('link'));
  $('#uploadCard')?.addEventListener('click', () => setMode('upload'));

  $('#analyzeLinkBtn')?.addEventListener('click', () => {
    const v = $('#videoUrl')?.value.trim();
    try {
      const u = new URL(v);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('bad protocol');
      $('#message').textContent = '✓ ลิงก์ถูกต้อง พร้อมสร้างงาน';
    } catch {
      $('#message').textContent = 'กรุณาตรวจสอบลิงก์อีกครั้ง';
    }
  });

  $('#fileInput')?.addEventListener('change', async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      state.sourceKey = null;
      showLoader('กำลังเตรียมอัปโหลด', `${f.name} · ${fmtBytes(f.size)}`, 4);
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
  $('#cleanupBtn')?.addEventListener('click', async () => {
    showLoader('กำลังกวาดลานยุทธภพ', 'ลบไฟล์ชั่วคราว', 35);
    try {
      await api('/api/cleanup/temp', { method: 'POST', body: '{}' });
      updateLoader('ล้างไฟล์ชั่วคราวแล้ว', 100);
      await loadStorage();
    } finally {
      setTimeout(hideLoader, 500);
    }
  });

  document.body.addEventListener('click', async e => {
    const dl = e.target.closest('[data-file]');
    if (dl) { downloadFile(dl.dataset.file); return; }
    const jb = e.target.closest('[data-delete-job]');
    if (jb && confirm('ลบงานนี้และไฟล์ที่เกี่ยวข้องหรือไม่?')) {
      await api('/api/jobs/' + jb.dataset.deleteJob, { method: 'DELETE' });
      await Promise.all([loadJobs(), loadFiles(), loadStorage()]);
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

if (IS_GITHUB_PAGES && !window.WUXIA_API_BASE) {
  if ($('#deployMode')) $('#deployMode').textContent = 'GitHub Preview';
  if ($('#message')) $('#message').textContent = 'หน้า Preview เท่านั้น · ใช้ Cloudflare Worker สำหรับระบบจริง';
  if ($('#topStorage')) $('#topStorage').textContent = 'Preview';
  if ($('#homeJobs')) $('#homeJobs').textContent = 'Preview UI พร้อม';
} else {
  if ($('#deployMode')) $('#deployMode').textContent = 'Core 2.0 · Drive';
  Promise.all([loadJobs(), loadFiles(), loadStorage()]);
  setInterval(loadJobs, 15000);
}
