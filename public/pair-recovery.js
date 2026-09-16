(() => {
  const ACCESS_KEY_SESSION = 'wuxia-access-key-v2';
  const PAIR_STATE_KEY = 'wuxia-media-pair-v2';
  const VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v']);
  const AUDIO_EXTS = new Set(['m4a', 'mp3', 'aac', 'wav', 'ogg', 'opus', 'flac', 'webm', 'mp4']);
  const AUDIO_EXCLUSIVE = new Set(['m4a', 'mp3', 'aac', 'wav', 'ogg', 'opus', 'flac']);
  const API_BASE = window.WUXIA_API_BASE || '';

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
    if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
    const response = await window.fetch(API_BASE + path, { ...options, headers, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.detail || `HTTP ${response.status}`);
    return data;
  }

  function loadState() {
    try { return JSON.parse(localStorage.getItem(PAIR_STATE_KEY) || 'null') || {}; } catch { return {}; }
  }

  function saveState(patch) {
    const next = { ...loadState(), ...patch, updatedAt: new Date().toISOString() };
    try { localStorage.setItem(PAIR_STATE_KEY, JSON.stringify(next)); } catch {}
    return next;
  }

  function clearState() {
    try { localStorage.removeItem(PAIR_STATE_KEY); } catch {}
  }

  function extOf(name) {
    return String(name || '').split('.').pop()?.toLowerCase() || '';
  }

  function safeName(name = '') {
    return String(name).replace(/[^a-zA-Z0-9._\-ก-๙一-龥ぁ-んァ-ヶ가-힣]+/g, '_').slice(0, 180);
  }

  function baseName(key) {
    return String(key || '').split('/').filter(Boolean).pop() || String(key || '');
  }

  function displayName(key) {
    return baseName(key).replace(/^\d{4}-\d{2}-\d{2}T[^-]+(?:-[^-]+){0,5}-[0-9a-f-]{36}-/i, '') || baseName(key);
  }

  function setMessage(text) {
    const node = document.querySelector('#message');
    if (node) node.textContent = text;
  }

  function fmtBytes(value) {
    let n = Number(value) || 0;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
  }

  function isSeparateSelected() {
    if (document.querySelector('[data-pair-mode="separate"].active')) return true;
    if (document.querySelector('#pairAudioInput')?.files?.[0]) return true;
    return loadState().pairMode === 'separate';
  }

  function setSeparateUi(pair = null) {
    document.querySelectorAll('[data-pair-mode]').forEach(button => {
      button.classList.toggle('active', button.dataset.pairMode === 'separate');
    });
    document.querySelector('#pairAudioPicker')?.classList.remove('hidden');
    const summary = document.querySelector('#pairSummary');
    if (summary && pair?.audioKey) {
      summary.innerHTML = `<b>ใช้ภาพจากวิดีโอ + เสียงแยก</b><span>${pair.audioName || displayName(pair.audioKey)} · ${fmtBytes(pair.audioSize)}</span>`;
    }
  }

  function exactFileMatch(files, selected) {
    if (!selected?.name) return null;
    const suffix = `-${safeName(selected.name)}`;
    return files.find(file => String(file.key || '').endsWith(suffix) && Number(file.size || 0) === Number(selected.size || 0)) || null;
  }

  function newest(files) {
    return [...files].sort((a, b) => new Date(b.modified || b.uploaded || 0) - new Date(a.modified || a.uploaded || 0));
  }

  function recentEnough(file, hours = 8) {
    const t = new Date(file?.modified || file?.uploaded || 0).getTime();
    return Number.isFinite(t) && Date.now() - t <= hours * 60 * 60 * 1000;
  }

  async function recoverPair({ requireAudio = true } = {}) {
    const listing = await api('/api/files');
    const uploads = newest((listing.files || []).filter(file => String(file.key || '').startsWith('uploads/') && Number(file.size || 0) > 0));
    if (!uploads.length) throw new Error('ไม่พบไฟล์ที่อัปโหลดไว้');

    const saved = loadState();
    const selectedVideo = document.querySelector('#fileInput')?.files?.[0] || null;
    const selectedAudio = document.querySelector('#pairAudioInput')?.files?.[0] || null;

    let video = exactFileMatch(uploads, selectedVideo);
    let audio = exactFileMatch(uploads, selectedAudio);

    if (!video && saved.videoKey) video = uploads.find(file => file.key === saved.videoKey) || null;
    if (!audio && saved.audioKey) audio = uploads.find(file => file.key === saved.audioKey) || null;

    if (!video) {
      video = uploads.find(file => VIDEO_EXTS.has(extOf(baseName(file.key))) && recentEnough(file))
        || uploads.find(file => VIDEO_EXTS.has(extOf(baseName(file.key))))
        || null;
    }

    if (!audio) {
      audio = uploads.find(file => file.key !== video?.key && AUDIO_EXCLUSIVE.has(extOf(baseName(file.key))) && recentEnough(file))
        || uploads.find(file => file.key !== video?.key && AUDIO_EXCLUSIVE.has(extOf(baseName(file.key))))
        || null;
    }

    if (!audio && video) {
      const ambiguous = uploads
        .filter(file => file.key !== video.key && AUDIO_EXTS.has(extOf(baseName(file.key))) && recentEnough(file))
        .sort((a, b) => Number(a.size || 0) - Number(b.size || 0));
      if (ambiguous.length) audio = ambiguous[0];
    }

    if (video && audio && Number(audio.size || 0) > Number(video.size || 0)) {
      const tmp = video;
      video = audio;
      audio = tmp;
    }

    if (!video) throw new Error('หาไฟล์วิดีโอที่อัปโหลดไว้ไม่เจอ');
    if (requireAudio && !audio) throw new Error('หาไฟล์เสียงที่อัปโหลดไว้ไม่เจอ กรุณาเลือกไฟล์เสียงเดิมอีกครั้ง ระบบจะตรวจไฟล์ที่มีอยู่ก่อนและไม่อัปโหลดซ้ำถ้าพบไฟล์ครบ');
    if (audio && audio.key === video.key) throw new Error('ไฟล์วิดีโอและไฟล์เสียงอ้างถึงไฟล์เดียวกัน กรุณาเลือกไฟล์เสียงเดิมอีกครั้ง');

    const pair = saveState({
      pairMode: audio ? 'separate' : saved.pairMode || 'embedded',
      videoKey: video.key,
      videoName: selectedVideo?.name || saved.videoName || displayName(video.key),
      videoSize: Number(video.size || selectedVideo?.size || 0),
      audioKey: audio?.key || null,
      audioName: selectedAudio?.name || saved.audioName || (audio ? displayName(audio.key) : ''),
      audioSize: Number(audio?.size || selectedAudio?.size || 0),
    });
    if (audio) setSeparateUi(pair);
    return pair;
  }

  function payloadFromPair(pair) {
    return {
      title: 'งานพากย์ ' + new Date().toLocaleString('th-TH'),
      sourceType: 'upload',
      sourceKey: pair.videoKey,
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
      mediaPairMode: 'separate-audio',
      sourceAudioKey: pair.audioKey,
      sourceAudioName: pair.audioName || displayName(pair.audioKey),
    };
  }

  async function startPairedJob() {
    setMessage('กำลังตรวจวิดีโอและไฟล์เสียงที่อัปโหลดไว้');
    const pair = await recoverPair({ requireAudio: true });
    setMessage(`พบไฟล์ครบแล้ว · วิดีโอ ${fmtBytes(pair.videoSize)} + เสียง ${fmtBytes(pair.audioSize)} · กำลังเริ่มงาน`);
    const data = await api('/api/jobs', { method: 'POST', body: JSON.stringify(payloadFromPair(pair)) });
    setMessage(data.dispatch?.triggered ? 'เริ่มประมวลผลแล้ว ใช้วิดีโอและไฟล์เสียงแยกที่อัปโหลดไว้' : 'สร้างงานแล้ว แต่ระบบประมวลผลยังไม่เริ่ม');
    document.querySelector('#refreshBtn')?.click();
    return data;
  }

  async function retryWithRecoveredAudio(jobId) {
    setMessage('กำลังหาไฟล์เสียงเดิมที่อัปโหลดไว้ ไม่ต้องอัปโหลดใหม่');
    const pair = await recoverPair({ requireAudio: true });
    const data = await api(`/api/pair/jobs/${encodeURIComponent(jobId)}/attach-audio`, {
      method: 'POST',
      body: JSON.stringify({
        sourceAudioKey: pair.audioKey,
        sourceAudioName: pair.audioName || displayName(pair.audioKey),
        retry: true,
      }),
    });
    setMessage(data.dispatch?.triggered === false ? 'ผูกไฟล์เสียงแล้ว แต่ยังเริ่มงานซ้ำไม่ได้' : 'ผูกไฟล์เสียงเดิมให้กับงานแล้ว และเริ่มลองใหม่ให้แล้ว');
    document.querySelector('#refreshBtn')?.click();
  }

  function install() {
    document.addEventListener('click', event => {
      const mode = event.target.closest?.('[data-pair-mode]');
      if (mode) saveState({ pairMode: mode.dataset.pairMode === 'separate' ? 'separate' : 'embedded' });

      const cleanupId = event.target.closest?.('button')?.id || '';
      if (cleanupId === 'cleanupUploadsBtn' || cleanupId === 'cleanupAllBtn') clearState();

      const start = event.target.closest?.('#startBtn');
      if (start && isSeparateSelected()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        startPairedJob().catch(error => setMessage(error.message || 'เริ่มงานไม่สำเร็จ'));
        return;
      }

      const retry = event.target.closest?.('[data-job-action="retry"]');
      if (retry) {
        const card = retry.closest('.job-card');
        const errorText = String(card?.querySelector('.job-error')?.textContent || '');
        if (/ไม่มีเสียงต้นฉบับ|ไฟล์เสียงแยก|อัปโหลดไฟล์เสียง|วิดีโอไม่มีเสียง/i.test(errorText)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          retryWithRecoveredAudio(retry.dataset.jobId).catch(error => setMessage(error.message || 'ลองใหม่ไม่สำเร็จ'));
        }
      }
    }, true);

    document.addEventListener('change', event => {
      if (event.target?.id === 'fileInput') {
        const file = event.target.files?.[0];
        if (file) saveState({ videoName: file.name, videoSize: file.size });
      }
      if (event.target?.id === 'pairAudioInput') {
        const file = event.target.files?.[0];
        if (file) saveState({ pairMode: 'separate', audioName: file.name, audioSize: file.size });
      }
    }, true);

    const saved = loadState();
    if (saved.pairMode === 'separate' && saved.audioKey) setSeparateUi(saved);
    document.documentElement.dataset.separateAudioPairRecovery = 'pairfix-v1';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
