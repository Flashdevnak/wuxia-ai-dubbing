(() => {
  'use strict';

  const ACCESS_KEY_SESSION = 'wuxia-access-key-v2';
  const VIDEO_RESUME_PREFIX = 'wuxia-upload-v4:';
  const AUDIO_RESUME_PREFIX = 'wuxia-audio-upload-v4:';
  const COMPLETE_PREFIX = 'wuxia-upload-complete-v4:';
  const PAIR_STATE_KEY = 'wuxia-media-pair-v4';
  const VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v']);
  const AUDIO_EXTS = new Set(['m4a', 'mp3', 'aac', 'wav', 'ogg', 'opus', 'flac', 'webm', 'mp4']);
  const API_BASE = window.WUXIA_API_BASE || '';

  const NORMAL_STALL_MS = 18000;
  const RETURN_STALL_MS = 26000;
  const RESPONSE_STALL_MS = 45000;
  const HARD_TIMEOUT_MS = 180000;
  const MAX_ATTEMPTS = 12;
  const WATCHDOG_MS = 1500;

  const runtime = {
    pairMode: 'embedded',
    videoKey: null,
    videoName: '',
    videoSize: 0,
    videoUploading: false,
    audioKey: null,
    audioName: '',
    audioSize: 0,
    audioUploading: false,
    lastForegroundAt: Date.now(),
    recoveryCount: 0,
  };

  const originalCreateJob = typeof window.createJob === 'function' ? window.createJob.bind(window) : null;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const extOf = name => String(name || '').split('.').pop()?.toLowerCase() || '';

  function fmtBytes(value) {
    let n = Number(value) || 0;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
  }

  function fmtRate(value) {
    const n = Number(value) || 0;
    return n > 0 ? `${fmtBytes(n)}/s` : 'กำลังวัดความเร็ว';
  }

  function fmtEta(value) {
    const s = Math.max(0, Math.round(Number(value) || 0));
    if (!s) return '';
    if (s < 60) return `${s} วินาที`;
    const m = Math.ceil(s / 60);
    if (m < 60) return `${m} นาที`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h} ชม. ${r} นาที` : `${h} ชม.`;
  }

  function getAccessKey() {
    let key = sessionStorage.getItem(ACCESS_KEY_SESSION) || '';
    if (key) return key;
    key = String(window.prompt('กรอกรหัสเข้าใช้งาน') || '').trim();
    if (!key) throw new Error('กรุณาใส่รหัสเข้าใช้งานก่อน');
    sessionStorage.setItem(ACCESS_KEY_SESSION, key);
    return key;
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}), 'x-access-key': getAccessKey() };
    if (options.body && !(options.body instanceof FormData) && !(options.body instanceof Blob) && !headers['content-type']) {
      headers['content-type'] = 'application/json';
    }
    const response = await window.fetch(API_BASE + path, { ...options, headers, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) sessionStorage.removeItem(ACCESS_KEY_SESSION);
    if (!response.ok) throw new Error(data.error || data.detail || `เกิดข้อผิดพลาด ${response.status}`);
    return data;
  }

  function fingerprint(file) {
    return `${file.name}:${file.size}:${file.lastModified || 0}`;
  }

  function localKey(prefix, file) {
    return `${prefix}${fingerprint(file)}`;
  }

  function loadLocal(prefix, file) {
    try { return JSON.parse(localStorage.getItem(localKey(prefix, file)) || 'null'); } catch { return null; }
  }

  function saveLocal(prefix, file, value) {
    try { localStorage.setItem(localKey(prefix, file), JSON.stringify(value)); } catch {}
  }

  function clearLocal(prefix, file) {
    try { localStorage.removeItem(localKey(prefix, file)); } catch {}
  }

  function loadPairState() {
    try { return JSON.parse(localStorage.getItem(PAIR_STATE_KEY) || 'null') || {}; } catch { return {}; }
  }

  function savePairState(patch) {
    const next = { ...loadPairState(), ...patch, updatedAt: new Date().toISOString() };
    try { localStorage.setItem(PAIR_STATE_KEY, JSON.stringify(next)); } catch {}
    return next;
  }

  async function findCompleted(file, role) {
    const saved = loadLocal(COMPLETE_PREFIX + role + ':', file);
    if (!saved?.key) return null;
    try {
      const listing = await api('/api/files');
      const found = (listing.files || []).find(x => x.key === saved.key && Number(x.size || 0) === Number(file.size || 0));
      if (!found) throw new Error('not found');
      return saved;
    } catch {
      clearLocal(COMPLETE_PREFIX + role + ':', file);
      return null;
    }
  }

  function connectionConcurrency(file, resumed) {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const effective = String(connection?.effectiveType || '').toLowerCase();
    if (connection?.saveData) return 1;
    if (effective.includes('2g')) return 1;
    if (effective === '3g') return 2;
    if (resumed) return 2;
    if (Number(file?.size || 0) < 64 * 1024 * 1024) return 2;
    if (Number(file?.size || 0) < 256 * 1024 * 1024) return 3;
    return 4;
  }

  async function beginOrResume(file, prefix) {
    const saved = loadLocal(prefix, file);
    if (saved?.key && saved?.uploadId && saved?.partSize) {
      try {
        const status = await api('/api/uploads/status', {
          method: 'POST',
          body: JSON.stringify({ key: saved.key, uploadId: saved.uploadId }),
        });
        if (status.complete) return { ...saved, nextOffset: file.size, resumed: true, alreadyComplete: true };
        if (!status.expired) return { ...saved, nextOffset: Number(status.nextOffset || 0), resumed: true, alreadyComplete: false };
      } catch {}
      clearLocal(prefix, file);
    }

    const started = await api('/api/uploads/start', {
      method: 'POST',
      body: JSON.stringify({ name: file.name, size: file.size, type: file.type || 'application/octet-stream' }),
    });
    const fresh = {
      key: started.key,
      uploadId: started.uploadId,
      partSize: Number(started.partSize || 0),
      nextOffset: 0,
      resumed: false,
      alreadyComplete: false,
    };
    saveLocal(prefix, file, fresh);
    return fresh;
  }

  function waitForOnline(maxMs = 90000) {
    if (navigator.onLine !== false) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { cleanup(); resolve(); };
      const timer = setTimeout(done, maxMs);
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener('online', done);
      };
      window.addEventListener('online', done, { once: true });
    });
  }

  function sendChunk({ key, uploadId, partNumber, chunk, onProgress }) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('key', key);
      form.append('uploadId', uploadId);
      form.append('partNumber', String(partNumber));
      form.append('chunk', chunk, `part-${String(partNumber).padStart(5, '0')}.bin`);

      const xhr = new XMLHttpRequest();
      let settled = false;
      let bodyFinished = false;
      let lastProgressAt = Date.now();
      let watchdog = null;
      let abortReason = '';

      const cleanup = () => { if (watchdog) clearInterval(watchdog); watchdog = null; };
      const finish = (ok, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        ok ? resolve(value) : reject(value);
      };

      xhr.open('POST', `${API_BASE}/api/uploads/chunk`, true);
      xhr.timeout = HARD_TIMEOUT_MS;
      xhr.responseType = 'text';
      xhr.setRequestHeader('x-access-key', getAccessKey());

      xhr.upload.onprogress = event => {
        lastProgressAt = Date.now();
        if (!event.lengthComputable) return;
        const loaded = Math.min(chunk.size, Number(event.loaded) || 0);
        bodyFinished = loaded >= chunk.size;
        onProgress?.(loaded);
      };
      xhr.onload = () => {
        let data = {};
        try { data = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch {}
        if (xhr.status >= 200 && xhr.status < 300) finish(true, data);
        else finish(false, new Error(data.error || data.detail || `อัปโหลดส่วนนี้ไม่สำเร็จ ${xhr.status}`));
      };
      xhr.onerror = () => finish(false, new Error('เครือข่ายสะดุดระหว่างอัปโหลด'));
      xhr.ontimeout = () => finish(false, new Error('การเชื่อมต่อส่วนนี้หมดเวลา'));
      xhr.onabort = () => finish(false, new Error(abortReason || 'เชื่อมต่อส่วนนี้ใหม่'));

      watchdog = setInterval(() => {
        if (settled || document.hidden) return;
        const now = Date.now();
        const sinceReturn = now - runtime.lastForegroundAt;
        const base = sinceReturn < 35000 ? RETURN_STALL_MS : NORMAL_STALL_MS;
        const jitter = (Number(partNumber) % 4) * 1200;
        const limit = bodyFinished ? RESPONSE_STALL_MS : base + jitter;
        if (now - lastProgressAt < limit) return;
        abortReason = bodyFinished
          ? 'ส่งส่วนไฟล์ครบแล้วแต่เซิร์ฟเวอร์ยังไม่ตอบ ระบบจะตรวจสถานะและเชื่อมต่อใหม่'
          : 'ช่องอัปโหลดหยุดเดิน ระบบจะตรวจสถานะและเชื่อมต่อใหม่';
        try { xhr.abort(); } catch { finish(false, new Error(abortReason)); }
      }, WATCHDOG_MS);

      xhr.send(form);
    });
  }

  async function reconcile(upload, task, fileSize) {
    try {
      const status = await api('/api/uploads/status', {
        method: 'POST',
        body: JSON.stringify({ key: upload.key, uploadId: upload.uploadId }),
      });
      if (status.complete) return { accepted: true, complete: true, nextOffset: fileSize };
      const nextOffset = Number(status.nextOffset || 0);
      return { accepted: nextOffset >= task.end, complete: false, nextOffset };
    } catch {
      return { accepted: false, complete: false, nextOffset: 0 };
    }
  }

  async function parallelUpload(file, { prefix, role, onProgress, onStage }) {
    const completed = await findCompleted(file, role);
    if (completed?.key) {
      onStage?.('พบไฟล์เดิมบนระบบแล้ว ไม่ต้องอัปโหลดซ้ำ');
      onProgress?.({ bytes: file.size, percent: 100, speed: 0, eta: 0, concurrency: 0 });
      return completed.key;
    }

    const upload = await beginOrResume(file, prefix);
    if (!upload.partSize) throw new Error('ไม่พบขนาดส่วนอัปโหลดจากเซิร์ฟเวอร์');
    if (upload.alreadyComplete) {
      saveLocal(COMPLETE_PREFIX + role + ':', file, { key: upload.key, size: file.size, name: file.name, completedAt: new Date().toISOString() });
      clearLocal(prefix, file);
      onProgress?.({ bytes: file.size, percent: 100, speed: 0, eta: 0, concurrency: 0 });
      return upload.key;
    }

    const partSize = Number(upload.partSize);
    let contiguousOffset = Math.min(file.size, Number(upload.nextOffset || 0));
    if (contiguousOffset && contiguousOffset % partSize !== 0 && contiguousOffset !== file.size) {
      throw new Error('ตำแหน่งทำต่อไม่สมบูรณ์ กรุณาเลือกไฟล์เดิมอีกครั้ง');
    }

    const totalParts = Math.max(1, Math.ceil(file.size / partSize));
    const firstPart = Math.floor(contiguousOffset / partSize) + 1;
    const tasks = [];
    for (let partNumber = firstPart; partNumber <= totalParts; partNumber += 1) {
      const start = (partNumber - 1) * partSize;
      const end = Math.min(file.size, start + partSize);
      tasks.push({ partNumber, start, end, size: end - start });
    }

    const concurrency = Math.max(1, Math.min(connectionConcurrency(file, upload.resumed), tasks.length || 1));
    const taskByNumber = new Map(tasks.map(x => [x.partNumber, x]));
    const activeLoaded = new Map();
    const confirmed = new Map();
    const completedParts = new Set();
    let commitPart = firstPart;
    let cursor = 0;
    let fatal = null;
    let shownBytes = contiguousOffset;
    const initialBytes = contiguousOffset;
    const startedAt = performance.now();

    function publish() {
      let bytes = initialBytes;
      for (const size of confirmed.values()) bytes += size;
      for (const [part, loaded] of activeLoaded.entries()) if (!confirmed.has(part)) bytes += loaded;
      shownBytes = Math.max(shownBytes, Math.min(file.size, bytes));
      const elapsed = Math.max(0.5, (performance.now() - startedAt) / 1000);
      const speed = Math.max(0, (shownBytes - initialBytes) / elapsed);
      const remaining = Math.max(0, file.size - shownBytes);
      onProgress?.({
        bytes: shownBytes,
        percent: file.size ? shownBytes / file.size * 100 : 100,
        speed,
        eta: speed > 32 * 1024 ? remaining / speed : 0,
        concurrency,
      });
    }

    function commitContiguous() {
      let changed = false;
      while (completedParts.has(commitPart)) {
        const task = taskByNumber.get(commitPart);
        if (!task) break;
        contiguousOffset = task.end;
        completedParts.delete(commitPart);
        commitPart += 1;
        changed = true;
      }
      if (changed) saveLocal(prefix, file, { key: upload.key, uploadId: upload.uploadId, partSize, nextOffset: contiguousOffset });
    }

    async function markAccepted(task) {
      activeLoaded.delete(task.partNumber);
      confirmed.set(task.partNumber, task.size);
      completedParts.add(task.partNumber);
      commitContiguous();
      publish();
    }

    async function uploadOne(task) {
      const chunk = file.slice(task.start, task.end, file.type || 'application/octet-stream');
      let lastError = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        if (fatal) return;
        await waitForOnline();
        activeLoaded.set(task.partNumber, 0);
        onStage?.(`กำลังส่ง ${task.partNumber}/${totalParts}${attempt > 1 ? ` · เชื่อมต่อใหม่ครั้งที่ ${attempt - 1}` : ''}`);
        try {
          await sendChunk({
            key: upload.key,
            uploadId: upload.uploadId,
            partNumber: task.partNumber,
            chunk,
            onProgress: loaded => { activeLoaded.set(task.partNumber, loaded); publish(); },
          });
          await markAccepted(task);
          return;
        } catch (error) {
          lastError = error;
          activeLoaded.delete(task.partNumber);
          publish();

          const reconciled = await reconcile(upload, task, file.size);
          if (reconciled.accepted) {
            await markAccepted(task);
            return;
          }

          runtime.recoveryCount += 1;
          onStage?.(`การเชื่อมต่อสะดุด · เก็บ ${Math.floor(contiguousOffset / file.size * 100)}% ที่ยืนยันแล้วไว้ · กำลังทำต่อ`);
          if (attempt < MAX_ATTEMPTS) {
            const delay = Math.min(5000, 700 + attempt * 350 + (task.partNumber % 4) * 250);
            await sleep(delay);
          }
        }
      }
      throw lastError || new Error(`ส่งส่วน ${task.partNumber} ไม่สำเร็จ`);
    }

    async function worker() {
      while (!fatal) {
        const i = cursor++;
        if (i >= tasks.length) return;
        try { await uploadOne(tasks[i]); }
        catch (error) { fatal = error; return; }
      }
    }

    if (tasks.length) {
      onStage?.(upload.resumed ? `ทำต่อจาก ${Math.floor(contiguousOffset / file.size * 100)}% · ${concurrency} ช่องทาง` : `เริ่มอัปโหลด · ${concurrency} ช่องทาง`);
      publish();
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      if (fatal) {
        throw new Error(`พักการอัปโหลดไว้ที่ ${Math.floor(contiguousOffset / file.size * 100)}% · เลือกไฟล์เดิมเพื่อทำต่อ (${fatal.message || 'เครือข่ายไม่เสถียร'})`);
      }
    }

    onStage?.('ส่งครบแล้ว · กำลังตรวจไฟล์');
    const done = await api('/api/uploads/complete', {
      method: 'POST',
      body: JSON.stringify({ key: upload.key, uploadId: upload.uploadId }),
    });
    if (Number(done.size || 0) !== Number(file.size || 0)) throw new Error('ขนาดไฟล์หลังอัปโหลดไม่ตรงกับต้นฉบับ');

    saveLocal(COMPLETE_PREFIX + role + ':', file, { key: upload.key, size: file.size, name: file.name, completedAt: new Date().toISOString() });
    clearLocal(prefix, file);
    onProgress?.({ bytes: file.size, percent: 100, speed: 0, eta: 0, concurrency });
    return upload.key;
  }

  function setVideoProgress({ bytes, percent, speed, eta, concurrency }) {
    const pct = Math.max(0, Math.min(100, Number(percent) || 0));
    const pctNode = document.querySelector('#uploadPct');
    const bar = document.querySelector('#uploadBar');
    const status = document.querySelector('#uploadStatus');
    if (pctNode) pctNode.textContent = `${Math.floor(pct)}%`;
    if (bar) bar.style.width = `${pct}%`;
    if (status) {
      const bits = [`${fmtBytes(bytes)} / ${fmtBytes(runtime.videoSize)}`];
      if (speed > 0) bits.push(fmtRate(speed));
      if (eta > 0) bits.push(`เหลือ ${fmtEta(eta)}`);
      if (concurrency > 1) bits.push(`${concurrency} ช่องทาง`);
      status.textContent = bits.join(' · ');
    }
  }

  function setAudioProgress({ bytes, percent, speed, eta, concurrency }) {
    const pct = Math.max(0, Math.min(100, Number(percent) || 0));
    const bar = document.querySelector('#pairAudioBar');
    const status = document.querySelector('#pairAudioStatus');
    if (bar) bar.style.width = `${pct}%`;
    if (status) {
      const bits = [`${fmtBytes(bytes)} / ${fmtBytes(runtime.audioSize)}`];
      if (speed > 0) bits.push(fmtRate(speed));
      if (eta > 0) bits.push(`เหลือ ${fmtEta(eta)}`);
      if (concurrency > 1) bits.push(`${concurrency} ช่องทาง`);
      status.textContent = bits.join(' · ');
      status.className = 'pair-audio-status';
    }
  }

  function showFileMeta(file) {
    const box = document.querySelector('#fileMeta');
    if (!box) return;
    box.classList.remove('hidden');
    box.innerHTML = `<div><span>ไฟล์วิดีโอ</span><b>${file.name}</b></div><div><span>ขนาด</span><b>${fmtBytes(file.size)}</b></div>`;
  }

  function updatePairSummary() {
    const summary = document.querySelector('#pairSummary');
    if (!summary) return;
    if (runtime.pairMode !== 'separate') {
      summary.innerHTML = '<b>เสียงอยู่ในวิดีโอ</b><span>ใช้วิดีโอไฟล์เดียว</span>';
      return;
    }
    if (runtime.audioKey) {
      summary.innerHTML = `<b>วิดีโอ + เสียงแยกพร้อมแล้ว</b><span>${runtime.audioName} · ${fmtBytes(runtime.audioSize)}</span>`;
      return;
    }
    summary.innerHTML = '<b>ต้องเลือกไฟล์เสียงเพิ่ม</b><span>ระบบจะใช้ภาพจากวิดีโอและเสียงจากไฟล์นี้</span>';
  }

  function setPairMode(mode) {
    runtime.pairMode = mode === 'separate' ? 'separate' : 'embedded';
    savePairState({ pairMode: runtime.pairMode });
    document.querySelectorAll('[data-pair-mode]').forEach(button => button.classList.toggle('active', button.dataset.pairMode === runtime.pairMode));
    document.querySelector('#pairAudioPicker')?.classList.toggle('hidden', runtime.pairMode !== 'separate');
    updatePairSummary();
  }

  function ensurePairPanel() {
    const wrap = document.querySelector('#fileInputWrap');
    if (!wrap || document.querySelector('#mediaPairPanel')) return;
    const panel = document.createElement('section');
    panel.id = 'mediaPairPanel';
    panel.className = 'media-pair-panel';
    panel.innerHTML = `
      <div class="pair-head"><div><b>เสียงต้นฉบับ</b><span>เลือกตามไฟล์ที่คุณมี</span></div></div>
      <div class="pair-mode-row">
        <button type="button" class="pair-mode active" data-pair-mode="embedded"><b>เสียงอยู่ในวิดีโอ</b><span>ใช้ไฟล์เดียว</span></button>
        <button type="button" class="pair-mode" data-pair-mode="separate"><b>มีไฟล์เสียงแยก</b><span>วิดีโอหนึ่งไฟล์ + เสียงหนึ่งไฟล์</span></button>
      </div>
      <div id="pairAudioPicker" class="pair-audio-picker hidden">
        <input id="pairAudioInput" type="file" accept="audio/*,.m4a,.mp3,.aac,.wav,.ogg,.opus,.flac,.webm,.mp4" />
        <label for="pairAudioInput" class="pair-audio-select"><b>เลือกไฟล์เสียง</b><span>M4A, MP3, AAC, WAV, OGG, OPUS, FLAC, WEBM หรือ MP4</span></label>
        <div class="pair-audio-progress"><i><em id="pairAudioBar"></em></i><span id="pairAudioStatus" class="pair-audio-status">ยังไม่ได้เลือกไฟล์เสียง</span></div>
      </div>
      <div id="pairSummary" class="pair-summary"><b>เสียงอยู่ในวิดีโอ</b><span>ใช้วิดีโอไฟล์เดียว</span></div>`;
    const progress = document.querySelector('#uploadProgress');
    if (progress) progress.insertAdjacentElement('afterend', panel);
    else wrap.appendChild(panel);
  }

  async function uploadVideo(file) {
    if (!VIDEO_EXTS.has(extOf(file.name))) throw new Error('รองรับ MP4, MOV, MKV, WEBM, AVI และ M4V');
    runtime.videoUploading = true;
    runtime.videoKey = null;
    runtime.videoName = file.name;
    runtime.videoSize = file.size;
    showFileMeta(file);
    document.querySelector('#uploadProgress')?.classList.remove('hidden');
    const name = document.querySelector('#uploadName');
    const status = document.querySelector('#uploadStatus');
    if (name) name.textContent = `${file.name} · ${fmtBytes(file.size)}`;
    if (status) status.textContent = 'กำลังตรวจไฟล์เดิมและเตรียมอัปโหลด';
    try {
      runtime.videoKey = await parallelUpload(file, {
        prefix: VIDEO_RESUME_PREFIX,
        role: 'video',
        onProgress: setVideoProgress,
        onStage: text => { if (status) status.textContent = text; },
      });
      savePairState({ videoKey: runtime.videoKey, videoName: file.name, videoSize: file.size });
      if (status) status.textContent = `พร้อมใช้ · ${fmtBytes(file.size)}`;
      const pct = document.querySelector('#uploadPct');
      const bar = document.querySelector('#uploadBar');
      if (pct) pct.textContent = '100%';
      if (bar) bar.style.width = '100%';
      return runtime.videoKey;
    } finally {
      runtime.videoUploading = false;
    }
  }

  async function uploadAudio(file) {
    if (!AUDIO_EXTS.has(extOf(file.name))) throw new Error('รองรับ M4A, MP3, AAC, WAV, OGG, OPUS, FLAC, WEBM และ MP4');
    runtime.audioUploading = true;
    runtime.audioKey = null;
    runtime.audioName = file.name;
    runtime.audioSize = file.size;
    updatePairSummary();
    try {
      runtime.audioKey = await parallelUpload(file, {
        prefix: AUDIO_RESUME_PREFIX,
        role: 'audio',
        onProgress: setAudioProgress,
        onStage: text => {
          const node = document.querySelector('#pairAudioStatus');
          if (node) { node.textContent = text; node.className = 'pair-audio-status'; }
        },
      });
      savePairState({ pairMode: 'separate', audioKey: runtime.audioKey, audioName: file.name, audioSize: file.size });
      const node = document.querySelector('#pairAudioStatus');
      const bar = document.querySelector('#pairAudioBar');
      if (node) { node.textContent = `พร้อมใช้ · ${file.name} · ${fmtBytes(file.size)}`; node.className = 'pair-audio-status ready'; }
      if (bar) bar.style.width = '100%';
      updatePairSummary();
      return runtime.audioKey;
    } finally {
      runtime.audioUploading = false;
    }
  }

  function projectTitle() {
    const series = String(document.querySelector('#r3Series')?.value || '').trim();
    const season = Math.max(1, Number(document.querySelector('#r3Season')?.value || 1) || 1);
    const episode = Math.max(1, Number(document.querySelector('#r3Episode')?.value || 1) || 1);
    return series ? `${series} · SS${season} EP${episode}` : `งานพากย์ · SS${season} EP${episode}`;
  }

  async function createJob() {
    if (runtime.videoUploading) throw new Error('วิดีโอยังอัปโหลดไม่เสร็จ');
    if (!runtime.videoKey) throw new Error('กรุณาเลือกวิดีโอและรอให้อัปโหลดครบก่อน');
    if (runtime.audioUploading) throw new Error('ไฟล์เสียงยังอัปโหลดไม่เสร็จ');
    if (runtime.pairMode === 'separate' && !runtime.audioKey) throw new Error('เลือก “มีไฟล์เสียงแยก” แล้ว กรุณาเลือกไฟล์เสียงให้ครบ');

    const payload = {
      title: projectTitle(),
      sourceType: 'upload',
      sourceKey: runtime.videoKey,
      sourceLang: document.querySelector('#sourceLang')?.value || 'auto',
      targetLang: document.querySelector('#targetLang')?.value || 'th',
      voiceMode: document.querySelector('#voiceMode')?.value || 'auto',
      processingMode: document.querySelector('#processingMode')?.value || 'fast',
      subtitles: document.querySelector('#subtitles')?.checked !== false,
      keepMusic: document.querySelector('#keepMusic')?.checked !== false,
      speakerSeparation: false,
      autoCleanup: document.querySelector('#autoCleanup')?.checked !== false,
      mediaPairMode: runtime.pairMode === 'separate' ? 'separate-audio' : 'embedded-audio',
    };
    if (runtime.pairMode === 'separate') {
      payload.sourceAudioKey = runtime.audioKey;
      payload.sourceAudioName = runtime.audioName;
    }

    const message = document.querySelector('#message');
    if (message) message.textContent = 'กำลังสร้างงานพากย์';
    const data = await api('/api/jobs', { method: 'POST', body: JSON.stringify(payload) });
    if (message) message.textContent = data.dispatch?.triggered ? 'เริ่มงานแล้ว ดูสถานะได้ที่แท็บ “งานพากย์”' : 'สร้างงานแล้ว แต่ระบบประมวลผลยังไม่เริ่ม';
    document.querySelector('#refreshBtn')?.click();
    return data;
  }

  function restorePairState() {
    const saved = loadPairState();
    runtime.pairMode = saved.pairMode === 'separate' ? 'separate' : 'embedded';
    runtime.videoKey = saved.videoKey || null;
    runtime.videoName = saved.videoName || '';
    runtime.videoSize = Number(saved.videoSize || 0);
    runtime.audioKey = saved.audioKey || null;
    runtime.audioName = saved.audioName || '';
    runtime.audioSize = Number(saved.audioSize || 0);
    setPairMode(runtime.pairMode);
  }

  function installEvents() {
    document.addEventListener('change', event => {
      if (event.target?.id === 'fileInput') {
        event.stopImmediatePropagation();
        const file = event.target.files?.[0];
        if (!file) return;
        uploadVideo(file).catch(error => {
          const status = document.querySelector('#uploadStatus');
          if (status) status.textContent = error.message || 'อัปโหลดวิดีโอไม่สำเร็จ';
        });
      }
      if (event.target?.id === 'pairAudioInput') {
        event.stopImmediatePropagation();
        const file = event.target.files?.[0];
        if (!file) return;
        uploadAudio(file).catch(error => {
          const status = document.querySelector('#pairAudioStatus');
          if (status) { status.textContent = error.message || 'อัปโหลดเสียงไม่สำเร็จ'; status.className = 'pair-audio-status error'; }
        });
      }
    }, true);

    document.addEventListener('click', event => {
      const mode = event.target.closest?.('[data-pair-mode]');
      if (mode) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPairMode(mode.dataset.pairMode);
      }
      const cleanup = event.target.closest?.('button')?.id || '';
      if (cleanup === 'cleanupUploadsBtn' || cleanup === 'cleanupAllBtn') {
        runtime.videoKey = null;
        runtime.audioKey = null;
        try { localStorage.removeItem(PAIR_STATE_KEY); } catch {}
      }
    }, true);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        runtime.lastForegroundAt = Date.now();
        const video = document.querySelector('#uploadStatus');
        const audio = document.querySelector('#pairAudioStatus');
        if (runtime.videoUploading && video) video.textContent = 'กลับมาหน้าเว็บแล้ว · กำลังให้การเชื่อมต่อฟื้นตัวและทำต่ออัตโนมัติ';
        if (runtime.audioUploading && audio) audio.textContent = 'กลับมาหน้าเว็บแล้ว · กำลังให้การเชื่อมต่อฟื้นตัวและทำต่ออัตโนมัติ';
      }
    });
    window.addEventListener('online', () => { runtime.lastForegroundAt = Date.now(); });
  }

  function install() {
    ensurePairPanel();
    restorePairState();
    installEvents();
    window.uploadFile = uploadVideo;
    window.createJob = createJob;
    document.documentElement.dataset.uploadEngine = 'resilient-multipart-v4';
    document.documentElement.dataset.uploadRecovery = 'adaptive-mobile-v4';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
