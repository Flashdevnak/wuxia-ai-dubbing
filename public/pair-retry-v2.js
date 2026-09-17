(() => {
  const ACCESS_KEY_SESSION = 'wuxia-access-key-v2';
  const PAIR_STATE_KEY = 'wuxia-media-pair-v2';
  const AUDIO_EXCLUSIVE = new Set(['m4a', 'mp3', 'aac', 'wav', 'ogg', 'opus', 'flac']);

  function getAccessKey() {
    const key = sessionStorage.getItem(ACCESS_KEY_SESSION) || '';
    if (!key) throw new Error('กรุณาใส่รหัสเข้าใช้งานก่อน');
    return key;
  }

  function loadState() {
    try { return JSON.parse(localStorage.getItem(PAIR_STATE_KEY) || 'null') || {}; } catch { return {}; }
  }

  function saveState(patch) {
    const next = { ...loadState(), ...patch, updatedAt: new Date().toISOString() };
    try { localStorage.setItem(PAIR_STATE_KEY, JSON.stringify(next)); } catch {}
    return next;
  }

  function extOf(value) {
    return String(value || '').split('/').pop()?.split('.').pop()?.toLowerCase() || '';
  }

  function displayName(key) {
    return String(key || '').split('/').pop() || String(key || '');
  }

  function setMessage(text) {
    const node = document.querySelector('#message');
    if (node) node.textContent = text;
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}), 'x-access-key': getAccessKey() };
    if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
    const response = await fetch(path, { ...options, headers, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.detail || `HTTP ${response.status}`);
    return data;
  }

  function looksLikeSeparateAudioFailure(card) {
    const text = String(card?.textContent || '').toLowerCase();
    return /video chunk has no audio stream|ไม่มีเสียง|ไฟล์เสียงแยก|เสียงต้นฉบับ|ประมวลผลเสียงพากย์ไม่สำเร็จ/.test(text);
  }

  async function chooseAudioForJob(job) {
    const listing = await api('/api/files');
    const files = (listing.files || []).filter(file => String(file.key || '').startsWith('uploads/') && Number(file.size || 0) > 0);
    const saved = loadState();

    let audio = null;
    if (saved.audioKey) audio = files.find(file => file.key === saved.audioKey) || null;
    if (!audio && saved.audioName && saved.audioSize) {
      audio = files.find(file => displayName(file.key).endsWith(saved.audioName) && Number(file.size || 0) === Number(saved.audioSize)) || null;
    }

    const candidates = files
      .filter(file => file.key !== job.sourceKey && AUDIO_EXCLUSIVE.has(extOf(file.key)))
      .sort((a, b) => new Date(b.modified || b.uploaded || 0) - new Date(a.modified || a.uploaded || 0));

    if (!audio && candidates.length === 1) audio = candidates[0];
    if (!audio && candidates.length > 1) {
      const recent = candidates.filter(file => Date.now() - new Date(file.modified || file.uploaded || 0).getTime() < 12 * 60 * 60 * 1000);
      if (recent.length === 1) audio = recent[0];
    }

    if (!audio) {
      throw new Error('พบว่างานนี้ไม่มีไฟล์เสียงผูกอยู่ กรุณาเลือกไฟล์เสียงเดิมอีกครั้ง ระบบจะใช้ไฟล์ที่อัปโหลดไว้และไม่อัปโหลดซ้ำถ้าตรงกัน');
    }

    saveState({
      pairMode: 'separate',
      videoKey: job.sourceKey || saved.videoKey || null,
      audioKey: audio.key,
      audioName: saved.audioName || displayName(audio.key),
      audioSize: Number(audio.size || 0),
    });
    return audio;
  }

  async function recoverAndRetry(jobId) {
    setMessage('กำลังตรวจไฟล์เสียงแยกเดิมก่อนลองใหม่');
    const jobData = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    const job = jobData.job || {};
    if (job.sourceAudioKey) {
      await api(`/api/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST', body: '{}' });
      setMessage('เริ่มลองใหม่ด้วยไฟล์เสียงที่ผูกอยู่แล้ว');
      document.querySelector('#refreshBtn')?.click();
      return;
    }

    const audio = await chooseAudioForJob(job);
    const result = await api(`/api/pair/jobs/${encodeURIComponent(jobId)}/attach-audio`, {
      method: 'POST',
      body: JSON.stringify({
        sourceAudioKey: audio.key,
        sourceAudioName: displayName(audio.key),
        retry: true,
      }),
    });
    setMessage(result.dispatch?.triggered === false
      ? 'ผูกไฟล์เสียงแล้ว แต่ระบบประมวลผลยังไม่เริ่ม'
      : 'ผูกไฟล์เสียงเดิมให้กับงานแล้ว และเริ่มลองใหม่ให้แล้ว');
    document.querySelector('#refreshBtn')?.click();
  }

  document.addEventListener('click', event => {
    const retry = event.target.closest?.('[data-job-action="retry"]');
    if (!retry) return;
    const card = retry.closest('.job-card');
    const saved = loadState();
    const separateSelected = document.querySelector('[data-pair-mode="separate"].active') || saved.pairMode === 'separate';
    if (!separateSelected && !looksLikeSeparateAudioFailure(card)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    retry.disabled = true;
    recoverAndRetry(retry.dataset.jobId)
      .catch(error => setMessage(error.message || 'ลองใหม่ไม่สำเร็จ'))
      .finally(() => { retry.disabled = false; });
  }, true);

  document.documentElement.dataset.pairRetryRecovery = 'v2';
})();
