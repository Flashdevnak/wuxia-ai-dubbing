(() => {
  const ACCESS_KEY_SESSION = 'wuxia-access-key-v2';
  const VIDEO_RESUME_PREFIX = 'wuxia-upload-v2:';
  const AUDIO_RESUME_PREFIX = 'wuxia-audio-upload-v1:';
  const VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v']);
  const AUDIO_EXTS = new Set(['m4a', 'mp3', 'aac', 'wav', 'ogg', 'opus', 'flac', 'webm', 'mp4']);
  const API_BASE = window.WUXIA_API_BASE || '';
  const FOREGROUND_STALL_MS = 8000;
  const RESPONSE_STALL_MS = 30000;
  const HARD_XHR_TIMEOUT_MS = 120000;
  const WATCHDOG_INTERVAL_MS = 1500;

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
  };

  const originalCreateJob = typeof window.createJob === 'function' ? window.createJob.bind(window) : null;

  const fmtBytes = value => {
    let n = Number(value) || 0;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
  };

  const fmtRate = bytesPerSecond => {
    const n = Number(bytesPerSecond) || 0;
    if (n <= 0) return 'กำลังวัดความเร็ว';
    return `${fmtBytes(n)}/s`;
  };

  const fmtEta = seconds => {
    const n = Math.max(0, Math.round(Number(seconds) || 0));
    if (!Number.isFinite(n) || n <= 0) return 'ใกล้เสร็จ';
    if (n < 60) return `ประมาณ ${n} วินาที`;
    const minutes = Math.ceil(n / 60);
    if (minutes < 60) return `ประมาณ ${minutes} นาที`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `ประมาณ ${hours} ชม. ${rest} นาที` : `ประมาณ ${hours} ชม.`;
  };

  const extOf = name => String(name || '').split('.').pop()?.toLowerCase() || '';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

  function resumeStorageKey(prefix, file) {
    return `${prefix}${fingerprint(file)}`;
  }

  function loadResume(prefix, file) {
    try { return JSON.parse(localStorage.getItem(resumeStorageKey(prefix, file)) || 'null'); } catch { return null; }
  }

  function saveResume(prefix, file, value) {
    try { localStorage.setItem(resumeStorageKey(prefix, file), JSON.stringify(value)); } catch {}
  }

  function clearResume(prefix, file) {
    try { localStorage.removeItem(resumeStorageKey(prefix, file)); } catch {}
  }

  function concurrencyFor(file) {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const effective = String(connection?.effectiveType || '').toLowerCase();
    if (connection?.saveData) return 2;
    if (effective.includes('2g')) return 1;
    if (effective === '3g') return 2;
    if (Number(file?.size || 0) < 64 * 1024 * 1024) return 2;
    if (Number(file?.size || 0) < 256 * 1024 * 1024) return 3;
    return 4;
  }

  async function beginOrResume(file, prefix) {
    const saved = loadResume(prefix, file);
    if (saved?.key && saved?.uploadId && saved?.partSize) {
      try {
        const status = await api('/api/uploads/status', {
          method: 'POST',
          body: JSON.stringify({ key: saved.key, uploadId: saved.uploadId }),
        });
        if (status.complete) {
          return { ...saved, nextOffset: file.size, resumed: true, alreadyComplete: true };
        }
        return { ...saved, nextOffset: Number(status.nextOffset || 0), resumed: true, alreadyComplete: false };
      } catch (error) {
        console.warn('fast upload resume check failed; opening a new session', error);
        clearResume(prefix, file);
      }
    }

    const started = await api('/api/uploads/start', {
      method: 'POST',
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
      }),
    });
    const fresh = {
      key: started.key,
      uploadId: started.uploadId,
      partSize: Number(started.partSize || 0),
      nextOffset: 0,
      resumed: false,
      alreadyComplete: false,
    };
    saveResume(prefix, file, fresh);
    return fresh;
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
      let watchdog = null;
      let abortReason = '';
      let lastProgressAt = Date.now();
      let bodyFinished = false;

      const cleanup = () => {
        if (watchdog) clearInterval(watchdog);
        watchdog = null;
      };
      const resolveOnce = value => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const rejectOnce = error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      xhr.open('POST', `${API_BASE}/api/uploads/chunk`, true);
      xhr.timeout = HARD_XHR_TIMEOUT_MS;
      xhr.responseType = 'text';
      xhr.setRequestHeader('x-access-key', getAccessKey());
      xhr.upload.onprogress = event => {
        lastProgressAt = Date.now();
        if (event.lengthComputable) {
          const loaded = Math.min(chunk.size, Number(event.loaded) || 0);
          bodyFinished = loaded >= chunk.size;
          onProgress?.(loaded);
        }
      };
      xhr.onload = () => {
        let data = {};
        try { data = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolveOnce(data);
        else rejectOnce(new Error(data.error || data.detail || `อัปโหลดส่วนนี้ไม่สำเร็จ ${xhr.status}`));
      };
      xhr.onerror = () => rejectOnce(new Error('ส่งไฟล์ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ต'));
      xhr.ontimeout = () => rejectOnce(new Error('อัปโหลดส่วนนี้นานเกินไป ระบบจะเชื่อมต่อใหม่'));
      xhr.onabort = () => rejectOnce(new Error(abortReason || 'อัปโหลดถูกยกเลิก'));

      // Foreground stall watchdog V3: Android can leave XHR alive but frozen after
      // the browser returns to the foreground. Do not wait for the old five-minute
      // XHR timeout. As soon as the page is visible, replace only a part that has
      // stopped making progress; completed multipart parts remain on R2.
      watchdog = setInterval(() => {
        if (settled) return;
        if (typeof document !== 'undefined' && document.hidden) return;
        const idleMs = Date.now() - lastProgressAt;
        const stallLimit = bodyFinished ? RESPONSE_STALL_MS : FOREGROUND_STALL_MS;
        if (idleMs < stallLimit) return;
        abortReason = bodyFinished
          ? 'เซิร์ฟเวอร์ไม่ตอบกลับหลังส่งส่วนไฟล์ครบ ระบบกำลังเชื่อมต่อใหม่'
          : 'การส่งส่วนไฟล์หยุดตอบสนอง ระบบกำลังเชื่อมต่อใหม่';
        try {
          xhr.abort();
        } catch {
          rejectOnce(new Error(abortReason));
        }
      }, WATCHDOG_INTERVAL_MS);

      xhr.send(form);
    });
  }

  async function parallelUpload(file, {
    prefix,
    onProgress,
    onStage,
  }) {
    const upload = await beginOrResume(file, prefix);
    const key = upload.key;
    const uploadId = upload.uploadId;
    const partSize = Number(upload.partSize || 0);
    if (!partSize) throw new Error('เซิร์ฟเวอร์ไม่ได้ส่งขนาดส่วนอัปโหลดกลับมา');
    if (upload.alreadyComplete) {
      clearResume(prefix, file);
      onProgress?.({ bytes: file.size, percent: 100, speed: 0, eta: 0, concurrency: 0 });
      return key;
    }

    let contiguousOffset = Math.min(file.size, Number(upload.nextOffset || 0));
    if (contiguousOffset && contiguousOffset % partSize !== 0 && contiguousOffset !== file.size) {
      await api('/api/uploads/abort', {
        method: 'POST',
        body: JSON.stringify({ key, uploadId }),
      }).catch(() => {});
      clearResume(prefix, file);
      throw new Error('ตำแหน่งอัปโหลดเดิมไม่ตรง กรุณาเลือกไฟล์อีกครั้ง');
    }

    const totalParts = Math.max(1, Math.ceil(file.size / partSize));
    const firstPart = Math.floor(contiguousOffset / partSize) + 1;
    const tasks = [];
    for (let partNumber = firstPart; partNumber <= totalParts; partNumber += 1) {
      const start = (partNumber - 1) * partSize;
      const end = Math.min(file.size, start + partSize);
      tasks.push({ partNumber, start, end, size: end - start });
    }

    const concurrency = Math.max(1, Math.min(concurrencyFor(file), tasks.length || 1));
    const activeLoaded = new Map();
    const confirmed = new Map();
    const completedParts = new Set();
    const taskByNumber = new Map(tasks.map(task => [task.partNumber, task]));
    let commitPart = firstPart;
    let cursor = 0;
    let fatalError = null;
    let displayedBytes = contiguousOffset;
    const initialBytes = contiguousOffset;
    const startedAt = performance.now();

    function publish() {
      let bytes = initialBytes;
      for (const size of confirmed.values()) bytes += size;
      for (const [partNumber, loaded] of activeLoaded.entries()) {
        if (!confirmed.has(partNumber)) bytes += loaded;
      }
      displayedBytes = Math.max(displayedBytes, Math.min(file.size, bytes));
      const elapsed = Math.max(0.25, (performance.now() - startedAt) / 1000);
      const speed = Math.max(0, (displayedBytes - initialBytes) / elapsed);
      const remaining = Math.max(0, file.size - displayedBytes);
      const eta = speed > 32 * 1024 ? remaining / speed : 0;
      onProgress?.({
        bytes: displayedBytes,
        percent: file.size ? (displayedBytes / file.size) * 100 : 100,
        speed,
        eta,
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
      if (changed) saveResume(prefix, file, { key, uploadId, partSize, nextOffset: contiguousOffset });
    }

    async function uploadOne(task) {
      const chunk = file.slice(task.start, task.end, file.type || 'application/octet-stream');
      let lastError = null;
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        if (fatalError) return;
        activeLoaded.set(task.partNumber, 0);
        onStage?.(`กำลังส่งส่วน ${task.partNumber}/${totalParts}${attempt > 1 ? ` ลองใหม่ ${attempt}` : ''}`);
        try {
          await sendChunk({
            key,
            uploadId,
            partNumber: task.partNumber,
            chunk,
            onProgress: loaded => {
              activeLoaded.set(task.partNumber, loaded);
              publish();
            },
          });
          activeLoaded.delete(task.partNumber);
          confirmed.set(task.partNumber, task.size);
          completedParts.add(task.partNumber);
          commitContiguous();
          publish();
          return;
        } catch (error) {
          lastError = error;
          activeLoaded.delete(task.partNumber);
          publish();
          if (/หยุดตอบสนอง|เชื่อมต่อใหม่|ยกเลิก|นานเกินไป/i.test(String(error?.message || ''))) {
            onStage?.(`ส่วน ${task.partNumber}/${totalParts} สะดุดชั่วคราว · กำลังเชื่อมต่อใหม่`);
          }
          if (attempt < 5) await sleep(Math.min(1800, 300 * attempt));
        }
      }
      throw lastError || new Error(`ส่งส่วน ${task.partNumber} ไม่สำเร็จ`);
    }

    async function worker() {
      while (!fatalError) {
        const index = cursor;
        cursor += 1;
        if (index >= tasks.length) return;
        try {
          await uploadOne(tasks[index]);
        } catch (error) {
          fatalError = error;
          return;
        }
      }
    }

    if (tasks.length) {
      onStage?.(`เริ่มอัปโหลดแบบขนาน ${concurrency} ช่องทาง`);
      publish();
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      if (fatalError) throw fatalError;
    }

    onStage?.('ส่งครบแล้ว กำลังตรวจไฟล์');
    const done = await api('/api/uploads/complete', {
      method: 'POST',
      body: JSON.stringify({ key, uploadId }),
    });
    if (Number(done.size) !== Number(file.size)) {
      throw new Error(`ขนาดไฟล์หลังอัปโหลดไม่ตรง ${done.size}/${file.size} bytes`);
    }
    clearResume(prefix, file);
    onProgress?.({ bytes: file.size, percent: 100, speed: 0, eta: 0, concurrency });
    return key;
  }

  function renderVideoProgress({ bytes, percent, speed, eta, concurrency }) {
    const pct = Math.max(0, Math.min(100, Number(percent) || 0));
    const pctNode = document.querySelector('#uploadPct');
    const bar = document.querySelector('#uploadBar');
    const status = document.querySelector('#uploadStatus');
    if (pctNode) pctNode.textContent = `${Math.floor(pct)}%`;
    if (bar) bar.style.width = `${pct}%`;
    if (status) {
      const speedText = speed > 0 ? ` · ${fmtRate(speed)}` : '';
      const etaText = eta > 0 ? ` · เหลือ ${fmtEta(eta)}` : '';
      const lanes = concurrency > 1 ? ` · ${concurrency} ช่องทาง` : '';
      status.textContent = `อัปโหลด ${fmtBytes(bytes)} จาก ${fmtBytes(runtime.videoSize)}${speedText}${etaText}${lanes}`;
    }
  }

  async function fastUploadVideo(file) {
    const ext = extOf(file.name);
    if (!VIDEO_EXTS.has(ext)) throw new Error('รองรับ MP4, MOV, MKV, WEBM, AVI และ M4V');
    runtime.videoUploading = true;
    runtime.videoKey = null;
    runtime.videoName = file.name;
    runtime.videoSize = file.size;

    const progress = document.querySelector('#uploadProgress');
    if (progress) progress.classList.remove('hidden');
    const name = document.querySelector('#uploadName');
    if (name) name.textContent = `${file.name} · ${fmtBytes(file.size)}`;
    const status = document.querySelector('#uploadStatus');
    if (status) status.textContent = 'กำลังเตรียมการอัปโหลดแบบหลายช่องทาง';

    try {
      runtime.videoKey = await parallelUpload(file, {
        prefix: VIDEO_RESUME_PREFIX,
        onProgress: renderVideoProgress,
        onStage: text => { if (status) status.textContent = text; },
      });
      if (status) status.textContent = `อัปโหลดวิดีโอเสร็จแล้ว ${fmtBytes(file.size)} พร้อมเริ่มงาน`;
      const pctNode = document.querySelector('#uploadPct');
      if (pctNode) pctNode.textContent = '100%';
      const bar = document.querySelector('#uploadBar');
      if (bar) bar.style.width = '100%';
      if (typeof window.loadStorage === 'function') window.loadStorage().catch(() => {});
      return runtime.videoKey;
    } finally {
      runtime.videoUploading = false;
    }
  }

  function setAudioProgress(percent) {
    const pct = Math.max(0, Math.min(100, Number(percent) || 0));
    const bar = document.querySelector('#pairAudioBar');
    if (bar) bar.style.width = `${pct}%`;
  }

  function setAudioStatus(text, kind = '') {
    const status = document.querySelector('#pairAudioStatus');
    if (!status) return;
    status.textContent = text;
    status.className = `pair-audio-status${kind ? ` ${kind}` : ''}`;
  }

  function updatePairSummary() {
    const summary = document.querySelector('#pairSummary');
    if (!summary) return;
    if (runtime.pairMode !== 'separate') {
      summary.innerHTML = '<b>ใช้เสียงจากวิดีโอ</b><span>เหมาะกับไฟล์ที่มีเสียงอยู่แล้ว</span>';
      return;
    }
    if (runtime.audioKey) {
      summary.innerHTML = `<b>ใช้ภาพจากวิดีโอ + เสียงแยก</b><span>${runtime.audioName} · ${fmtBytes(runtime.audioSize)}</span>`;
      return;
    }
    summary.innerHTML = '<b>รอไฟล์เสียง</b><span>เลือกไฟล์เสียงที่ดาวน์โหลดมาคู่กับวิดีโอ</span>';
  }

  function setPairMode(mode) {
    runtime.pairMode = mode === 'separate' ? 'separate' : 'embedded';
    document.querySelectorAll('[data-pair-mode]').forEach(button => {
      button.classList.toggle('active', button.dataset.pairMode === runtime.pairMode);
    });
    document.querySelector('#pairAudioPicker')?.classList.toggle('hidden', runtime.pairMode !== 'separate');
    updatePairSummary();
  }

  async function fastUploadAudio(file) {
    const ext = extOf(file.name);
    if (!AUDIO_EXTS.has(ext)) throw new Error('รองรับ M4A, MP3, AAC, WAV, OGG, OPUS, FLAC, WEBM และ MP4');
    runtime.audioUploading = true;
    runtime.audioKey = null;
    runtime.audioName = file.name;
    runtime.audioSize = file.size;
    setAudioProgress(0);
    setAudioStatus('กำลังเตรียมไฟล์เสียงแบบหลายช่องทาง');
    updatePairSummary();

    try {
      runtime.audioKey = await parallelUpload(file, {
        prefix: AUDIO_RESUME_PREFIX,
        onProgress: ({ bytes, percent, speed, eta, concurrency }) => {
          setAudioProgress(percent);
          const speedText = speed > 0 ? ` · ${fmtRate(speed)}` : '';
          const etaText = eta > 0 ? ` · เหลือ ${fmtEta(eta)}` : '';
          const lanes = concurrency > 1 ? ` · ${concurrency} ช่องทาง` : '';
          setAudioStatus(`อัปโหลดเสียง ${fmtBytes(bytes)} จาก ${fmtBytes(file.size)}${speedText}${etaText}${lanes}`);
        },
        onStage: text => setAudioStatus(text),
      });
      setAudioProgress(100);
      setAudioStatus(`พร้อมใช้ ${file.name} · ${fmtBytes(file.size)}`, 'ready');
      updatePairSummary();
      return runtime.audioKey;
    } finally {
      runtime.audioUploading = false;
    }
  }

  function isUploadMode() {
    return !document.querySelector('#fileInputWrap')?.classList.contains('hidden');
  }

  async function fastCreateJob() {
    if (!isUploadMode()) {
      if (originalCreateJob) return originalCreateJob();
      throw new Error('ระบบสร้างงานยังไม่พร้อม');
    }
    if (runtime.videoUploading) throw new Error('กรุณารอให้อัปโหลดวิดีโอเสร็จก่อน');
    if (!runtime.videoKey) throw new Error('กรุณาอัปโหลดวิดีโอให้เสร็จก่อน');
    if (runtime.audioUploading) throw new Error('กรุณารอให้อัปโหลดไฟล์เสียงเสร็จก่อน');
    if (runtime.pairMode === 'separate' && !runtime.audioKey) {
      throw new Error('เลือก “มีไฟล์เสียงแยก” แล้ว กรุณาอัปโหลดไฟล์เสียงให้เสร็จก่อน');
    }

    const payload = {
      title: 'งานพากย์ ' + new Date().toLocaleString('th-TH'),
      sourceType: 'upload',
      sourceKey: runtime.videoKey,
      sourceUrl: document.querySelector('#videoUrl')?.value.trim() || null,
      sourceLang: document.querySelector('#sourceLang')?.value || 'auto',
      targetLang: document.querySelector('#targetLang')?.value || 'th',
      voiceMode: document.querySelector('#voiceMode')?.value || 'auto',
      processingMode: document.querySelector('#processingMode')?.value || 'fast',
      subtitles: document.querySelector('#subtitles')?.checked === true,
      keepMusic: document.querySelector('#keepMusic')?.checked === true,
      speakerSeparation: document.querySelector('#speakerSep')?.checked === true,
      autoCleanup: document.querySelector('#autoCleanup')?.checked === true,
      captionUrl: null,
      captionKey: null,
      captionSource: null,
      captionLanguage: null,
      captionFormat: null,
      captionVideoId: null,
      mediaPairMode: runtime.pairMode === 'separate' ? 'separate-audio' : 'embedded-audio',
    };
    if (runtime.pairMode === 'separate') {
      payload.sourceAudioKey = runtime.audioKey;
      payload.sourceAudioName = runtime.audioName;
    }

    const message = document.querySelector('#message');
    if (message) message.textContent = 'กำลังส่งงานพากย์เข้าคิว';
    const data = await api('/api/jobs', { method: 'POST', body: JSON.stringify(payload) });
    if (message) {
      message.textContent = data.dispatch?.triggered
        ? 'เริ่มประมวลผลแล้ว ดูความคืบหน้าได้ในรายการงาน'
        : 'สร้างงานแล้ว แต่ระบบประมวลผลยังไม่เริ่ม';
    }
    const refreshes = [];
    if (typeof window.loadJobs === 'function') refreshes.push(window.loadJobs());
    if (typeof window.loadStorage === 'function') refreshes.push(window.loadStorage());
    if (refreshes.length) await Promise.allSettled(refreshes);
    return data;
  }

  function installCaptureGuards() {
    document.addEventListener('click', event => {
      const modeButton = event.target.closest?.('[data-pair-mode]');
      if (!modeButton) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setPairMode(modeButton.dataset.pairMode);
    }, true);

    document.addEventListener('change', event => {
      if (event.target?.id !== 'pairAudioInput') return;
      event.stopImmediatePropagation();
      const file = event.target.files?.[0];
      if (!file) return;
      fastUploadAudio(file).catch(error => {
        runtime.audioKey = null;
        setAudioProgress(0);
        setAudioStatus(error.message || 'อัปโหลดไฟล์เสียงไม่สำเร็จ', 'error');
        updatePairSummary();
      });
    }, true);

    document.addEventListener('click', event => {
      const id = event.target.closest?.('button')?.id || '';
      if (id === 'cleanupUploadsBtn' || id === 'cleanupAllBtn') {
        runtime.videoKey = null;
        runtime.audioKey = null;
      }
    }, true);
  }

  function install() {
    window.uploadFile = fastUploadVideo;
    window.createJob = fastCreateJob;
    installCaptureGuards();
    document.documentElement.dataset.uploadEngine = 'parallel-v2';
    document.documentElement.dataset.uploadConcurrencyMax = '4';
    document.documentElement.dataset.uploadForegroundWatchdog = 'foreground-stall-watchdog-v3';

    const status = document.querySelector('#uploadStatus');
    if (status && !status.textContent.trim()) status.textContent = 'พร้อมอัปโหลดแบบหลายช่องทาง';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();