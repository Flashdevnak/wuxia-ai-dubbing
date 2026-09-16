(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const ACCESS_KEY_SESSION = 'wuxia-access-key-v2';
  const AUDIO_RESUME_PREFIX = 'wuxia-audio-upload-v1:';
  const AUDIO_EXTS = new Set(['m4a', 'mp3', 'aac', 'wav', 'ogg', 'opus', 'flac', 'webm', 'mp4']);
  const state = {
    mode: 'embedded',
    audioKey: null,
    audioName: '',
    audioSize: 0,
    audioUploading: false,
    observerBusy: false,
  };

  const fmtBytes = value => {
    let n = Number(value) || 0;
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
  };

  const extOf = name => String(name || '').split('.').pop()?.toLowerCase() || '';

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
    if (options.body && !(options.body instanceof FormData) && !headers['content-type']) headers['content-type'] = 'application/json';
    const response = await fetch(path, { ...options, headers, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.detail || `เกิดข้อผิดพลาด ${response.status}`);
    return data;
  }

  function audioResumeKey(file) {
    return `${AUDIO_RESUME_PREFIX}${file.name}:${file.size}:${file.lastModified || 0}`;
  }

  function loadAudioResume(file) {
    try { return JSON.parse(localStorage.getItem(audioResumeKey(file)) || 'null'); } catch { return null; }
  }

  function saveAudioResume(file, value) {
    try { localStorage.setItem(audioResumeKey(file), JSON.stringify(value)); } catch {}
  }

  function clearAudioResume(file) {
    try { localStorage.removeItem(audioResumeKey(file)); } catch {}
  }

  function setAudioStatus(text, kind = '') {
    const node = $('#pairAudioStatus');
    if (!node) return;
    node.textContent = text;
    node.className = `pair-audio-status${kind ? ` ${kind}` : ''}`;
  }

  function setAudioProgress(pct) {
    const safe = Math.max(0, Math.min(100, Number(pct) || 0));
    const bar = $('#pairAudioBar');
    if (bar) bar.style.width = `${safe}%`;
  }

  function xhrChunk({ key, uploadId, partNumber, chunk, file, offset }) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('key', key);
      form.append('uploadId', uploadId);
      form.append('partNumber', String(partNumber));
      form.append('chunk', chunk, `audio-${String(partNumber).padStart(5, '0')}.bin`);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/uploads/chunk', true);
      xhr.timeout = 180000;
      xhr.responseType = 'text';
      xhr.setRequestHeader('x-access-key', getAccessKey());
      xhr.upload.onprogress = event => {
        if (!event.lengthComputable) return;
        const sent = Math.min(file.size, offset + Math.min(chunk.size, event.loaded));
        const pct = file.size ? (sent / file.size) * 100 : 0;
        setAudioProgress(pct);
        setAudioStatus(`กำลังอัปโหลดเสียง ${fmtBytes(sent)} จาก ${fmtBytes(file.size)}`);
      };
      xhr.onload = () => {
        let data = {};
        try { data = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || data.detail || `อัปโหลดเสียงไม่สำเร็จ ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('ส่งไฟล์เสียงไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ต'));
      xhr.ontimeout = () => reject(new Error('อัปโหลดไฟล์เสียงนานเกินไป กรุณาลองอีกครั้ง'));
      xhr.send(form);
    });
  }

  async function beginAudioUpload(file) {
    const saved = loadAudioResume(file);
    if (saved?.key && saved?.uploadId && saved?.partSize) {
      try {
        const status = await api('/api/uploads/status', {
          method: 'POST',
          body: JSON.stringify({ key: saved.key, uploadId: saved.uploadId }),
        });
        if (status.complete) return { ...saved, nextOffset: file.size };
        if (!status.expired) return { ...saved, nextOffset: Number(status.nextOffset || 0) };
      } catch {}
      clearAudioResume(file);
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
    };
    saveAudioResume(file, fresh);
    return fresh;
  }

  async function uploadAudio(file) {
    const ext = extOf(file.name);
    if (!AUDIO_EXTS.has(ext)) throw new Error('รองรับไฟล์เสียง M4A, MP3, AAC, WAV, OGG, OPUS, FLAC, WEBM และ MP4');
    state.audioUploading = true;
    state.audioKey = null;
    state.audioName = file.name;
    state.audioSize = file.size;
    setAudioProgress(0);
    setAudioStatus(`กำลังเตรียม ${file.name}`);

    try {
      const upload = await beginAudioUpload(file);
      const partSize = Number(upload.partSize || 0);
      if (!partSize) throw new Error('เซิร์ฟเวอร์ไม่ได้ส่งขนาดส่วนอัปโหลดกลับมา');
      let offset = Math.min(file.size, Number(upload.nextOffset || 0));
      let part = Math.floor(offset / partSize) + 1;
      const total = Math.max(1, Math.ceil(file.size / partSize));

      while (offset < file.size) {
        const end = Math.min(file.size, offset + partSize);
        const chunk = file.slice(offset, end, file.type || 'application/octet-stream');
        let sent = false;
        let lastError = null;
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          try {
            setAudioStatus(`กำลังส่งเสียงส่วน ${part}/${total}${attempt > 1 ? ` ลองใหม่ ${attempt}` : ''}`);
            await xhrChunk({ key: upload.key, uploadId: upload.uploadId, partNumber: part, chunk, file, offset });
            sent = true;
            break;
          } catch (err) {
            lastError = err;
            await new Promise(resolve => setTimeout(resolve, 450 * attempt));
          }
        }
        if (!sent) throw lastError || new Error('ส่งไฟล์เสียงไม่สำเร็จ');
        offset = end;
        part += 1;
        saveAudioResume(file, { ...upload, nextOffset: offset });
        setAudioProgress((offset / file.size) * 100);
      }

      const done = await api('/api/uploads/complete', {
        method: 'POST',
        body: JSON.stringify({ key: upload.key, uploadId: upload.uploadId }),
      });
      if (Number(done.size) !== Number(file.size)) throw new Error('ขนาดไฟล์เสียงหลังอัปโหลดไม่ตรงกับต้นฉบับ');
      clearAudioResume(file);
      state.audioKey = upload.key;
      setAudioProgress(100);
      setAudioStatus(`พร้อมใช้ ${file.name} · ${fmtBytes(file.size)}`, 'ready');
      updatePairSummary();
    } finally {
      state.audioUploading = false;
    }
  }

  function updatePairSummary() {
    const summary = $('#pairSummary');
    if (!summary) return;
    if (state.mode === 'embedded') {
      summary.innerHTML = '<b>ใช้เสียงจากวิดีโอ</b><span>เหมาะกับไฟล์ MP4 ที่เปิดแล้วมีเสียงตามปกติ</span>';
      return;
    }
    if (state.audioKey) {
      summary.innerHTML = `<b>ใช้ภาพจากวิดีโอ + เสียงแยก</b><span>${state.audioName} · ${fmtBytes(state.audioSize)}</span>`;
      return;
    }
    summary.innerHTML = '<b>รอไฟล์เสียง</b><span>เลือกไฟล์เสียงที่ดาวน์โหลดมาคู่กับวิดีโอ</span>';
  }

  function setPairMode(mode) {
    state.mode = mode === 'separate' ? 'separate' : 'embedded';
    $$('[data-pair-mode]').forEach(button => button.classList.toggle('active', button.dataset.pairMode === state.mode));
    $('#pairAudioPicker')?.classList.toggle('hidden', state.mode !== 'separate');
    updatePairSummary();
  }

  function installMediaPairPanel() {
    const fileWrap = $('#fileInputWrap');
    if (!fileWrap || $('#mediaPairPanel')) return;
    const panel = document.createElement('section');
    panel.id = 'mediaPairPanel';
    panel.className = 'media-pair-panel';
    panel.innerHTML = `
      <div class="pair-head">
        <div><b>เสียงต้นฉบับ</b><span>เลือกให้ตรงกับไฟล์ที่คุณมี</span></div>
      </div>
      <div class="pair-mode-row">
        <button type="button" data-pair-mode="embedded" class="pair-mode active"><b>เสียงอยู่ในวิดีโอ</b><span>ใช้ไฟล์เดียว</span></button>
        <button type="button" data-pair-mode="separate" class="pair-mode"><b>มีไฟล์เสียงแยก</b><span>ภาพหนึ่งไฟล์ + เสียงหนึ่งไฟล์</span></button>
      </div>
      <div id="pairAudioPicker" class="pair-audio-picker hidden">
        <input id="pairAudioInput" type="file" accept="audio/*,.m4a,.mp3,.aac,.wav,.ogg,.opus,.flac,.webm,.mp4" />
        <label for="pairAudioInput" class="pair-audio-select"><b>เลือกไฟล์เสียง</b><span>M4A, MP3, AAC, WAV, OGG, OPUS, FLAC, WEBM หรือ MP4</span></label>
        <div class="pair-audio-progress"><i><em id="pairAudioBar"></em></i><span id="pairAudioStatus" class="pair-audio-status">ยังไม่ได้เลือกไฟล์เสียง</span></div>
      </div>
      <div id="pairSummary" class="pair-summary"><b>ใช้เสียงจากวิดีโอ</b><span>เหมาะกับไฟล์ MP4 ที่เปิดแล้วมีเสียงตามปกติ</span></div>`;
    const progress = $('#uploadProgress');
    if (progress) progress.insertAdjacentElement('afterend', panel);
    else fileWrap.appendChild(panel);

    panel.querySelectorAll('[data-pair-mode]').forEach(button => button.addEventListener('click', () => setPairMode(button.dataset.pairMode)));
    $('#pairAudioInput')?.addEventListener('change', async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      try { await uploadAudio(file); }
      catch (err) {
        state.audioKey = null;
        setAudioProgress(0);
        setAudioStatus(err.message || 'อัปโหลดไฟล์เสียงไม่สำเร็จ', 'error');
        updatePairSummary();
      }
    });
  }

  function installJobPayloadBridge() {
    if (window.__WUXIA_MEDIA_PAIR_BRIDGE__) return;
    window.__WUXIA_MEDIA_PAIR_BRIDGE__ = true;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      const method = String(init.method || (typeof input !== 'string' ? input?.method : 'GET') || 'GET').toUpperCase();
      if (method === 'POST' && /\/api\/jobs(?:\?|$)/.test(url) && typeof init.body === 'string') {
        let body = null;
        try { body = JSON.parse(init.body); } catch {}
        if (body && body.jobType !== 'transcript' && body.sourceType === 'upload') {
          if (state.audioUploading) throw new Error('กรุณารอให้อัปโหลดไฟล์เสียงเสร็จก่อน');
          if (state.mode === 'separate') {
            if (!state.audioKey) throw new Error('เลือก “มีไฟล์เสียงแยก” แล้ว กรุณาเลือกไฟล์เสียงให้เสร็จก่อนเริ่มพากย์');
            body.sourceAudioKey = state.audioKey;
            body.sourceAudioName = state.audioName;
            body.mediaPairMode = 'separate-audio';
          } else {
            body.mediaPairMode = 'embedded-audio';
          }
          init = { ...init, body: JSON.stringify(body) };
        }
      }
      return originalFetch(input, init);
    };
  }

  function plainText(value) {
    return String(value || '')
      .replace(/[⚔⚡☁✓✔⚠↻▶⏸◆🔥✨🤖🧩]/gu, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function humanizeStaticUi() {
    const brand = $('.brand');
    if (brand) {
      const strong = brand.querySelector('strong');
      const sub = brand.querySelector('span');
      if (strong) strong.textContent = 'ยุทธภพ สตูดิโอ';
      if (sub) sub.textContent = 'งานพากย์วิดีโอภาษาไทย';
    }

    const eyebrow = $('.hero .eyebrow');
    const heroTitle = $('.hero h1');
    const heroText = $('.hero p');
    if (eyebrow) eyebrow.textContent = 'DUBBING STUDIO';
    if (heroTitle) heroTitle.textContent = 'พากย์ไทยจากวิดีโอของคุณ';
    if (heroText) heroText.textContent = 'เลือกวิดีโอ ตั้งค่าเสียง แล้วปล่อยให้ระบบจัดการการถอดคำ แปล พากย์ และรวมไฟล์ให้ครบในงานเดียว';

    const upload = $('#uploadCard');
    if (upload) {
      const title = upload.querySelector('b');
      const desc = upload.querySelector('small');
      if (title) title.textContent = 'อัปโหลดวิดีโอ';
      if (desc) desc.textContent = 'ทางหลักสำหรับงานจริง รองรับวิดีโอมีเสียงหรือเสียงแยก';
    }
    const link = $('#linkCard');
    if (link) {
      const title = link.querySelector('b');
      const desc = link.querySelector('small');
      if (title) title.textContent = 'ลิงก์ YouTube';
      if (desc) desc.textContent = 'ทางทดลอง อาจถูก YouTube ปฏิเสธจากฝั่งเซิร์ฟเวอร์';
    }

    const start = $('#startBtn');
    if (start) {
      const title = start.querySelector('b');
      const desc = start.querySelector('small');
      const uploadMode = !$('#fileInputWrap')?.classList.contains('hidden');
      const wanted = uploadMode ? 'เริ่มงานพากย์' : 'ลองพากย์จาก YouTube';
      if (title && title.textContent !== wanted) title.textContent = wanted;
      if (desc) desc.textContent = uploadMode
        ? 'ตรวจไฟล์ แปล พากย์ และรวมวิดีโออัตโนมัติ'
        : 'โหมดทดลอง หากดึงไม่ได้ให้กลับมาใช้อัปโหลดวิดีโอ';
    }

    const r3Title = $('#r3StudioPanel .r3-title b');
    const r3Sub = $('#r3StudioPanel .r3-title span');
    const r3Health = $('#r3Health');
    if (r3Title) r3Title.textContent = 'ตั้งค่างานพากย์';
    if (r3Sub) r3Sub.textContent = 'ชื่อเรื่อง ศัพท์ประจำเรื่อง และลำดับตอน';
    if (r3Health && /R3|กำลังตรวจ/.test(r3Health.textContent || '')) r3Health.textContent = r3Health.classList.contains('ready') ? 'ระบบพร้อม' : 'กำลังตรวจระบบ';

    const featureTexts = $$('#r3StudioPanel .r3-feature-grid span');
    const labels = ['แปลตามบริบท', 'ปรับจังหวะเสียง', 'ตรวจความครบก่อนส่งออก', 'ลดงานซ้ำ'];
    featureTexts.forEach((node, index) => { if (labels[index]) node.textContent = labels[index]; });

    $$('.nav-item, .mini-btn, .text-btn, .btn').forEach(node => {
      if (node === start || node.id === 'refreshBtn' || node.id === 'menuBtn') return;
      const ownText = [...node.childNodes].filter(x => x.nodeType === Node.TEXT_NODE).map(x => x.nodeValue).join('');
      if (ownText && plainText(ownText) !== ownText.trim()) {
        [...node.childNodes].filter(x => x.nodeType === Node.TEXT_NODE).forEach(x => { x.nodeValue = plainText(x.nodeValue); });
      }
    });

    const helper = $('#fullAutoDownloader .full-auto-helper-copy span');
    if (helper) helper.textContent = 'ถ้าดึง YouTube โดยตรงไม่ได้ ให้ดาวน์โหลดวิดีโอแล้วอัปโหลดที่นี่ หากได้ไฟล์เสียงแยกให้เลือกเพิ่มในช่อง “เสียงต้นฉบับ”';
    const chooser = $('#chooseDownloadedBtn');
    if (chooser) chooser.textContent = 'เลือกวิดีโอจากเครื่อง';
  }

  function installHumanUiObserver() {
    const observer = new MutationObserver(() => {
      if (state.observerBusy) return;
      state.observerBusy = true;
      requestAnimationFrame(() => {
        try { humanizeStaticUi(); } finally { state.observerBusy = false; }
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function init() {
    installJobPayloadBridge();
    installMediaPairPanel();
    humanizeStaticUi();
    installHumanUiObserver();
    document.documentElement.dataset.studioUi = 'human-v1';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();