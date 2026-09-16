(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const PROJECT_LAST = 'wuxia-r3-project-last-v1';
  const ACCESS_KEY_SESSION = 'wuxia-access-key-v2';
  const API_BASE = window.WUXIA_API_BASE || '';
  const PHASES = ['Upload', 'Prepare', 'Transcribe', 'Translate', 'Dub', 'Mix', 'Quality Check', 'Complete'];
  const state = { busy: false, lastToast: '', lastToastAt: 0, confirmResolve: null, telemetryBusy: false };

  function safeText(value) {
    return String(value || '')
      .replace(/[⚔⚡☁✓✔⚠↻▶⏸◆🔥✨🤖🧩]/gu, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>\"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[c] || c));
  }

  function fmtBytes(value) {
    let n = Number(value) || 0;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
  }

  function toast(message, kind = 'info', title = '') {
    const text = safeText(message);
    if (!text) return;
    const now = Date.now();
    if (state.lastToast === text && now - state.lastToastAt < 1600) return;
    state.lastToast = text;
    state.lastToastAt = now;
    const host = $('#toastHost');
    if (!host) return;
    const node = document.createElement('div');
    node.className = `toast ${kind}`;
    node.innerHTML = `<div><b>${esc(title || (kind === 'error' ? 'เกิดปัญหา' : kind === 'success' ? 'เรียบร้อย' : kind === 'warning' ? 'ตรวจสอบอีกครั้ง' : 'สถานะงาน'))}</b><span></span></div><button type="button" aria-label="ปิด">×</button>`;
    node.querySelector('span').textContent = text;
    node.querySelector('button').addEventListener('click', () => node.remove());
    host.appendChild(node);
    while (host.children.length > 4) host.firstElementChild?.remove();
    window.setTimeout(() => node.remove(), kind === 'error' ? 9000 : 5200);
  }

  function installMessageBridge() {
    const node = $('#message');
    if (!node) return;
    const publish = () => {
      const text = safeText(node.textContent);
      if (!text) return;
      const lower = text.toLowerCase();
      const kind = /ไม่สำเร็จ|ผิดพลาด|ไม่พบ|กรุณา|ไม่ได้|error|failed/.test(lower) ? 'error'
        : /เสร็จ|เริ่มประมวลผล|พร้อม|ทำต่อ|สร้างงานแล้ว/.test(lower) ? 'success'
          : 'info';
      toast(text, kind);
    };
    new MutationObserver(publish).observe(node, { childList: true, subtree: true, characterData: true });
  }

  function clearProjectIdentity({ preserveGlossary = true } = {}) {
    const series = $('#r3Series');
    const season = $('#r3Season');
    const episode = $('#r3Episode');
    if (series) series.value = '';
    if (season) season.value = '1';
    if (episode) episode.value = '1';
    try {
      const old = JSON.parse(localStorage.getItem(PROJECT_LAST) || 'null');
      const glossaryText = preserveGlossary ? String($('#r3Glossary')?.value || old?.glossaryText || '').slice(0, 12000) : '';
      localStorage.setItem(PROJECT_LAST, JSON.stringify({ glossaryText, updatedAt: new Date().toISOString() }));
    } catch {}
  }

  function relocateProjectPanel() {
    const slot = $('#projectSlot');
    const panel = $('#r3StudioPanel');
    if (!slot || !panel) return false;
    if (panel.parentElement !== slot) {
      slot.innerHTML = '';
      slot.appendChild(panel);
    }
    return true;
  }

  function setDefaultMode() {
    try {
      if (typeof window.setMode === 'function') window.setMode('upload');
      else $('#uploadCard')?.click();
    } catch { $('#uploadCard')?.click(); }
  }

  function mountDlbunnyHelper() {
    const sourceBox = $('.media-card .source-box');
    if (!sourceBox || $('#dlbunnyShortcut')) return Boolean(sourceBox);
    const shortcut = document.createElement('a');
    shortcut.id = 'dlbunnyShortcut';
    shortcut.className = 'source-card secondary-source';
    shortcut.href = 'https://dlbunny.com/en/youtube';
    shortcut.target = '_blank';
    shortcut.rel = 'noopener noreferrer';
    shortcut.innerHTML = '<div><b>DLBunny helper</b><small>ดาวน์โหลดวิดีโอ/เสียงจาก YouTube แล้วกลับมาอัปโหลดที่นี่</small></div>';
    sourceBox.insertAdjacentElement('afterend', shortcut);
    return true;
  }

  function phaseIndexFrom(stage, percent, status) {
    const text = safeText(stage).toLowerCase();
    if (status === 'completed' || percent >= 100) return 7;
    if (/quality|ตรวจคุณภาพ|qc/.test(text)) return 6;
    if (/mix|รวมวิดีโอ|final/.test(text)) return 5;
    if (/dub|voice|tts|พากย์/.test(text)) return 4;
    if (/translate|แปล/.test(text)) return 3;
    if (/transcribe|whisper|ถอด|คำบรรยาย/.test(text)) return 2;
    if (/prepare|เตรียม|แยกเสียง|ดาวน์โหลด/.test(text)) return 1;
    if (/upload|อัปโหลด|ส่งไฟล์/.test(text)) return 0;
    if (percent >= 92) return 6;
    if (percent >= 78) return 5;
    if (percent >= 58) return 4;
    if (percent >= 40) return 3;
    if (percent >= 22) return 2;
    if (percent >= 8) return 1;
    return 0;
  }

  function statusLabel(status) {
    const map = {
      queued: 'Queued', processing: 'Processing', paused: 'Paused', failed: 'Failed',
      completed: 'Completed', cancelled: 'Cancelled', canceled: 'Cancelled',
    };
    return map[String(status || '').toLowerCase()] || 'Processing';
  }

  function studioJobHtml(j) {
    const raw = Math.max(0, Math.min(100, Number(j?.progress) || 0));
    const status = String(j?.status || 'queued').toLowerCase();
    const stage = safeText(j?.stage || statusLabel(status));
    const current = phaseIndexFrom(stage, raw, status);
    const created = j?.createdAt ? new Date(j.createdAt).toLocaleString('th-TH') : '—';
    const updated = j?.updatedAt || j?.createdAt ? new Date(j.updatedAt || j.createdAt).toLocaleString('th-TH') : '—';
    const series = safeText(j?.series || '');
    const season = Math.max(1, Number(j?.season || 1) || 1);
    const episode = Math.max(1, Number(j?.episode || 1) || 1);
    const episodeText = `S${String(season).padStart(2, '0')} E${String(episode).padStart(2, '0')}`;
    const title = series || safeText(j?.title || 'งานพากย์');
    const mode = j?.processingMode === 'quality' ? 'คุณภาพสูง' : j?.processingMode === 'balanced' ? 'สมดุล' : 'เร็ว';
    const meta = j?.jobType === 'transcript'
      ? `คำบรรยาย · ${safeText(j?.sourceLang || 'auto')} → ${safeText(j?.targetLang || 'th')}`
      : `${safeText(j?.sourceLang || 'auto')} → ${safeText(j?.targetLang || 'th')} · ${mode}`;
    const err = safeText(j?.error || '');
    const control = status === 'failed'
      ? `<button class="mini-btn" data-job-action="retry" data-job-id="${esc(j.id)}">ลองใหม่</button>`
      : status === 'paused'
        ? `<button class="mini-btn" data-job-action="resume" data-job-id="${esc(j.id)}">ทำต่อ</button>`
        : (status === 'queued' || status === 'processing')
          ? `<button class="mini-btn" data-job-action="pause" data-job-id="${esc(j.id)}">พัก</button>` : '';
    return `<article class="job-card ${esc(status)}">
      <div class="job-main">
        <div class="job-copy">
          <div class="job-title-row"><div class="job-title">${esc(title)}</div><span class="job-episode">${esc(episodeText)}</span></div>
          <div class="job-meta">${esc(meta)}</div>
          <div class="job-timestamps"><span>สร้าง ${esc(created)}</span><span>อัปเดต ${esc(updated)}</span></div>
          <div class="job-state-row"><span class="job-status-chip ${esc(status)}">${esc(statusLabel(status))}</span><span class="job-phase-chip">${esc(PHASES[current])}</span></div>
          ${err ? `<div class="job-error">${esc(err)}</div>` : ''}
        </div>
        <div class="job-actions">${control}${j?.outputKey ? `<button class="mini-btn" data-file="${esc(j.outputKey)}">ดาวน์โหลด</button>` : ''}${j?.subtitleKey ? `<button class="mini-btn" data-file="${esc(j.subtitleKey)}">ซับ</button>` : ''}${j?.transcriptXmlKey ? `<button class="mini-btn" data-file="${esc(j.transcriptXmlKey)}">XML</button>` : ''}<button class="mini-btn danger" data-delete-job="${esc(j.id)}">ลบ</button></div>
      </div>
      <div class="job-progress"><i style="width:${raw}%"></i></div>
      <div class="job-progress-row"><b>${raw}%</b><span>${esc(stage || PHASES[current])}</span></div>
      <div class="phase-strip" aria-label="ขั้นตอนงาน">${PHASES.map((_, i) => `<i class="${i < current || status === 'completed' ? 'done' : ''}${i === current && status !== 'completed' ? ' current' : ''}"></i>`).join('')}</div>
      <div class="phase-labels">${PHASES.map((name, i) => `<span class="${i === current ? 'phase-current' : ''}">${esc(name)}</span>`).join('')}</div>
    </article>`;
  }

  function decorateJob(card) {
    if (!card) return;
    const legacy = $('.job-sword', card) || $('.sword-progress', card);
    if (legacy) {
      legacy.className = 'job-progress';
      legacy.querySelector('.sword-hilt')?.remove();
    }
    if (!$('.phase-strip', card)) {
      const pct = Math.max(0, Math.min(100, Number(($('.job-foot b', card)?.textContent || $('.job-progress-row b', card)?.textContent || '').replace('%', '')) || 0));
      const stage = safeText($('.job-stage', card)?.textContent || $('.job-progress-row span', card)?.textContent || '');
      const status = card.classList.contains('completed') ? 'completed' : card.classList.contains('failed') ? 'failed' : 'processing';
      const current = phaseIndexFrom(stage, pct, status);
      const strip = document.createElement('div');
      strip.className = 'phase-strip';
      strip.setAttribute('aria-label', 'ขั้นตอนงาน');
      strip.innerHTML = PHASES.map((_, i) => `<i class="${i < current || status === 'completed' ? 'done' : ''}${i === current && status !== 'completed' ? ' current' : ''}"></i>`).join('');
      const labels = document.createElement('div');
      labels.className = 'phase-labels';
      labels.innerHTML = PHASES.map((name, i) => `<span class="${i === current ? 'phase-current' : ''}">${esc(name)}</span>`).join('');
      const progressRow = $('.job-foot', card) || $('.job-progress-row', card);
      if (progressRow) progressRow.insertAdjacentElement('afterend', strip); else card.appendChild(strip);
      strip.insertAdjacentElement('afterend', labels);
    }
    $$('.mini-btn', card).forEach(button => { button.textContent = safeText(button.textContent); });
    const del = $('[data-delete-job]', card);
    if (del) del.textContent = 'ลบ';
    const repair = $('.r3-repair-btn', card);
    if (repair) repair.textContent = 'ซ่อมช่วง';
  }

  function decorateAllJobs() { $$('.job-card').forEach(decorateJob); }

  function projectTitleFromFields(body = {}) {
    const series = String($('#r3Series')?.value || '').trim();
    const season = Math.max(1, Number($('#r3Season')?.value || 1) || 1);
    const episode = Math.max(1, Number($('#r3Episode')?.value || 1) || 1);
    if (series) return `${series} · S${season} EP${episode}`;
    if (body?.sourceType === 'upload') return `งานพากย์ · S${season} EP${episode}`;
    return body?.title || `งานพากย์ · S${season} EP${episode}`;
  }

  async function verifySourceFiles(body, originalFetch) {
    if (body?.sourceType !== 'upload') return;
    const keys = [body.sourceKey, body.sourceAudioKey].filter(Boolean);
    if (!keys.length) throw new Error('ยังไม่พบไฟล์ต้นฉบับสำหรับเริ่มงาน');
    const accessKey = sessionStorage.getItem(ACCESS_KEY_SESSION) || '';
    if (!accessKey) throw new Error('กรุณากรอกรหัสเข้าใช้งานก่อนเริ่มงาน');
    const response = await originalFetch(`${API_BASE}/api/files`, { headers: { 'x-access-key': accessKey }, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'ตรวจไฟล์บนเซิร์ฟเวอร์ไม่สำเร็จ');
    const files = Array.isArray(data.files) ? data.files : [];
    for (const key of keys) {
      const found = files.find(file => file.key === key && Number(file.size || 0) > 0);
      if (!found) throw new Error(key === body.sourceAudioKey ? 'ไฟล์เสียงไม่อยู่บนเซิร์ฟเวอร์แล้ว กรุณาเลือกไฟล์เสียงเดิมเพื่อทำต่อ' : 'ไฟล์วิดีโอไม่อยู่บนเซิร์ฟเวอร์แล้ว กรุณาเลือกไฟล์เดิมเพื่อทำต่อ');
    }
  }

  function installFetchUxBridge() {
    if (window.__WUXIA_STUDIO_V2_FETCH__) return;
    window.__WUXIA_STUDIO_V2_FETCH__ = true;
    const original = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      const method = String(init.method || (typeof input !== 'string' ? input?.method : 'GET') || 'GET').toUpperCase();
      let createsDubbingJob = false;
      let body = null;
      if (method === 'POST' && /\/api\/jobs(?:\?|$)/.test(url) && typeof init.body === 'string') {
        try {
          body = JSON.parse(init.body);
          if (body && body.jobType !== 'transcript') {
            createsDubbingJob = true;
            body.title = projectTitleFromFields(body);
            await verifySourceFiles(body, original);
            init = { ...init, body: JSON.stringify(body) };
          }
        } catch (error) {
          if (createsDubbingJob || body) toast(error?.message || 'ตรวจไฟล์ก่อนเริ่มงานไม่สำเร็จ', 'error');
          throw error;
        }
      }
      let response;
      try { response = await original(input, init); }
      catch (error) {
        if (createsDubbingJob) toast(error?.message || 'ส่งงานไม่สำเร็จ', 'error');
        throw error;
      }
      if (createsDubbingJob && response.ok) {
        window.setTimeout(() => clearProjectIdentity({ preserveGlossary: true }), 0);
        toast('สร้างงานแล้ว ชื่องาน Season และ EP ถูกรีเซ็ตสำหรับงานถัดไป', 'success', 'เริ่มงานแล้ว');
      }
      if (method === 'DELETE' && /\/api\/jobs\//.test(url) && response.ok) toast('ลบงานและไฟล์ที่เกี่ยวข้องแล้ว', 'success', 'ลบงานแล้ว');
      return response;
    };
  }

  function syncUploadTelemetry() {
    if (state.telemetryBusy) return;
    state.telemetryBusy = true;
    requestAnimationFrame(() => {
      try {
        const statusNode = $('#uploadStatus');
        const text = safeText(statusNode?.textContent || '');
        const parts = text.split(' · ').map(x => x.trim()).filter(Boolean);
        const first = parts[0] || '';
        const match = first.match(/^อัปโหลด\s+(.+?)\s+จาก\s+(.+)$/i);
        if (match) {
          if ($('#uploadSent')) $('#uploadSent').textContent = match[1];
        }
        const speed = parts.find(x => /\/s$/i.test(x));
        const eta = parts.find(x => /^เหลือ\s+/i.test(x));
        const channels = parts.find(x => /ช่องทาง/.test(x));
        if (speed && $('#uploadSpeed')) $('#uploadSpeed').textContent = speed;
        if (eta && $('#uploadEta')) $('#uploadEta').textContent = eta.replace(/^เหลือ\s+/, '');
        if (channels && $('#uploadChannels')) $('#uploadChannels').textContent = channels.replace(/\s*ช่องทาง.*/, '');

        let uploadState = 'uploading';
        let label = 'กำลังอัปโหลด';
        if (/เสร็จ|พร้อมเริ่มงาน|พร้อมใช้/.test(text)) { uploadState = 'success'; label = 'สำเร็จ'; }
        else if (/ไม่สำเร็จ|ผิดพลาด|หาไฟล์.*ไม่เจอ/.test(text)) { uploadState = 'error'; label = 'ล้มเหลว'; }
        else if (/Android|เบื้องหลัง/.test(text)) { uploadState = 'background'; label = 'ทำงานเบื้องหลัง'; }
        else if (/เชื่อมต่อใหม่|ค้าง|ลองใหม่|สะดุด/.test(text)) { uploadState = 'reconnect'; label = 'กำลังเชื่อมต่อใหม่'; }
        else if (/กลับมา|ทำต่อ/.test(text)) { uploadState = 'resume'; label = 'กำลังทำต่อ'; }
        else if (/เตรียม/.test(text)) { uploadState = 'prepare'; label = 'กำลังเตรียม'; }
        const stateNode = $('#uploadState');
        if (stateNode) stateNode.dataset.state = uploadState;
        if ($('#uploadStateLabel')) $('#uploadStateLabel').textContent = label;

        const video = $('#videoReadyState');
        const pct = Number(String($('#uploadPct')?.textContent || '0').replace('%', '')) || 0;
        if (video) {
          video.className = '';
          if (pct >= 100 || uploadState === 'success') { video.textContent = 'พร้อม'; video.classList.add('ready'); }
          else if (!$('#uploadProgress')?.classList.contains('hidden')) { video.textContent = label; video.classList.add(uploadState === 'error' ? 'error' : 'busy'); }
          else video.textContent = 'ยังไม่ได้เลือก';
        }

        const audio = $('#audioReadyState');
        if (audio) {
          const separate = $('[data-pair-mode="separate"]')?.classList.contains('active');
          const audioStatus = safeText($('#pairAudioStatus')?.textContent || '');
          audio.className = '';
          if (!separate) audio.textContent = 'ใช้เสียงในวิดีโอ';
          else if (/พร้อมใช้|100%|เสร็จ/.test(audioStatus)) { audio.textContent = 'พร้อม'; audio.classList.add('ready'); }
          else if (/ไม่สำเร็จ|ผิดพลาด/.test(audioStatus)) { audio.textContent = 'ล้มเหลว'; audio.classList.add('error'); }
          else if (/อัปโหลด|กำลัง|ส่ง|เชื่อมต่อ/.test(audioStatus)) { audio.textContent = 'กำลังอัปโหลด'; audio.classList.add('busy'); }
          else audio.textContent = 'รอไฟล์เสียง';
        }
      } finally { state.telemetryBusy = false; }
    });
  }

  function installUiObserver() {
    const observer = new MutationObserver(() => {
      if (state.busy) return;
      state.busy = true;
      requestAnimationFrame(() => {
        try {
          relocateProjectPanel();
          mountDlbunnyHelper();
          decorateAllJobs();
          syncUploadTelemetry();
        } finally { state.busy = false; }
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function installProjectFreshStart() {
    const run = () => {
      if (!$('#r3Series')) return false;
      clearProjectIdentity({ preserveGlossary: true });
      return true;
    };
    if (run()) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (run() || tries > 30) clearInterval(timer);
    }, 100);
  }

  function showConfirm({ title = 'ยืนยันการทำรายการ', text = '', confirmLabel = 'ยืนยัน', danger = true } = {}) {
    const dialog = $('#confirmDialog');
    if (!dialog) return Promise.resolve(false);
    if (state.confirmResolve) state.confirmResolve(false);
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    const ok = $('#confirmOkBtn');
    ok.textContent = confirmLabel;
    ok.classList.toggle('danger', danger);
    dialog.classList.remove('hidden');
    return new Promise(resolve => { state.confirmResolve = resolve; });
  }

  function closeConfirm(value) {
    $('#confirmDialog')?.classList.add('hidden');
    const resolve = state.confirmResolve;
    state.confirmResolve = null;
    if (resolve) resolve(Boolean(value));
  }

  function getAccessKey() {
    const key = sessionStorage.getItem(ACCESS_KEY_SESSION) || '';
    if (!key) throw new Error('กรุณากรอกรหัสเข้าใช้งานก่อน');
    return key;
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}), 'x-access-key': getAccessKey() };
    if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
    const response = await fetch(API_BASE + path, { ...options, headers, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.detail || `เกิดข้อผิดพลาด ${response.status}`);
    return data;
  }

  async function refreshAll() {
    const work = [];
    if (typeof window.loadJobs === 'function') work.push(window.loadJobs());
    if (typeof window.loadFiles === 'function') work.push(window.loadFiles());
    if (typeof window.loadStorage === 'function') work.push(window.loadStorage());
    if (work.length) await Promise.allSettled(work);
    await hydrateStorageExtras().catch(() => {});
  }

  async function cleanupKind(kind, label) {
    if (typeof window.showLoader === 'function') window.showLoader(`กำลังลบ${label}`, 'กำลังคืนพื้นที่', 30);
    let totalFreed = 0;
    let result = { remaining: 1 };
    let round = 0;
    while (Number(result.remaining || 0) > 0 && round < 100) {
      result = await api(`/api/cleanup/${kind}`, { method: 'POST', body: '{}' });
      totalFreed += Number(result.freedBytes || 0);
      round += 1;
      if (typeof window.updateLoader === 'function' && Number(result.remaining || 0) > 0) {
        window.updateLoader(`กำลังลบ${label} เหลือ ${result.remaining} รายการ`, Math.min(92, 30 + round * 6));
      }
    }
    if (Number(result.remaining || 0) > 0) throw new Error('ยังลบไฟล์ไม่หมด กรุณากดลองอีกครั้ง');
    if (typeof window.updateLoader === 'function') window.updateLoader(`คืนพื้นที่ ${fmtBytes(totalFreed)}`, 100);
    await refreshAll();
    toast(`คืนพื้นที่ ${fmtBytes(totalFreed)}`, 'success', 'ล้างพื้นที่แล้ว');
    window.setTimeout(() => window.hideLoader?.(), 450);
  }

  function installConfirmActions() {
    $('#confirmCancelBtn')?.addEventListener('click', () => closeConfirm(false));
    $('#confirmOkBtn')?.addEventListener('click', () => closeConfirm(true));
    $('[data-confirm-cancel]')?.addEventListener('click', () => closeConfirm(false));
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#confirmDialog')?.classList.contains('hidden')) closeConfirm(false); });

    const cleanup = {
      cleanupUploadsBtn: ['uploads', 'ไฟล์ต้นฉบับ', 'ลบไฟล์ต้นฉบับทั้งหมดหรือไม่? งานที่ยังต้องใช้ต้นฉบับอาจทำต่อไม่ได้'],
      cleanupBtn: ['temp', 'ไฟล์ชั่วคราว', 'ลบไฟล์ชั่วคราวทั้งหมดหรือไม่? งานที่กำลังประมวลผลอาจได้รับผลกระทบ'],
      cleanupOutputsBtn: ['outputs', 'ไฟล์ผลลัพธ์', 'ลบไฟล์ผลลัพธ์ทั้งหมดหรือไม่? ไฟล์ที่ยังไม่ได้ดาวน์โหลดจะถูกลบ'],
      cleanupAllBtn: ['all', 'ไฟล์ทั้งหมด', 'ล้างไฟล์และประวัติงานทั้งหมดหรือไม่? การกระทำนี้ย้อนกลับไม่ได้'],
    };

    document.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (button && cleanup[button.id]) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const [kind, label, question] = cleanup[button.id];
        showConfirm({ title: `ลบ${label}`, text: question, confirmLabel: `ลบ${label}` }).then(async yes => {
          if (!yes) return;
          try { await cleanupKind(kind, label); }
          catch (error) { window.hideLoader?.(); toast(error.message || 'ลบไฟล์ไม่สำเร็จ', 'error'); }
        });
        return;
      }

      const job = event.target.closest('[data-delete-job]');
      if (job) {
        event.preventDefault();
        event.stopImmediatePropagation();
        showConfirm({ title: 'ลบงานพากย์', text: 'ลบงานนี้และไฟล์ที่เกี่ยวข้องหรือไม่? การลบช่วยคืนพื้นที่ทันที', confirmLabel: 'ลบงาน' }).then(async yes => {
          if (!yes) return;
          try {
            await api(`/api/jobs/${encodeURIComponent(job.dataset.deleteJob)}`, { method: 'DELETE' });
            await refreshAll();
            toast('ลบงานเรียบร้อย', 'success');
          } catch (error) { toast(error.message || 'ลบงานไม่สำเร็จ', 'error'); }
        });
        return;
      }

      const file = event.target.closest('[data-delete-file]');
      if (file) {
        event.preventDefault();
        event.stopImmediatePropagation();
        showConfirm({ title: 'ลบไฟล์', text: 'ลบไฟล์นี้ออกจาก workspace เพื่อคืนพื้นที่หรือไม่?', confirmLabel: 'ลบไฟล์' }).then(async yes => {
          if (!yes) return;
          try {
            await api(`/api/files?key=${encodeURIComponent(file.dataset.deleteFile)}`, { method: 'DELETE' });
            await refreshAll();
            toast('ลบไฟล์เรียบร้อย', 'success');
          } catch (error) { toast(error.message || 'ลบไฟล์ไม่สำเร็จ', 'error'); }
        });
      }
    }, true);
  }

  async function hydrateStorageExtras() {
    if (!$('#storageHeavyList') && !$('#stAvailable')) return;
    const storage = await api('/api/storage');
    const bytes = Number(storage.bytes || 0);
    const limitBytes = Number(storage.limitBytes || 8 * 1024 ** 3);
    const available = Math.max(0, limitBytes - bytes);
    const pct = limitBytes ? Math.min(100, bytes / limitBytes * 100) : 0;
    if ($('#stAvailable')) $('#stAvailable').textContent = fmtBytes(available);
    if ($('#stBudget')) $('#stBudget').textContent = `${pct.toFixed(1)}% of ${(limitBytes / 1024 ** 3).toFixed(0)} GB`;
    if ($('#storageUsageBar')) $('#storageUsageBar').style.width = `${pct}%`;

    const [filesData, jobsData] = await Promise.all([api('/api/files'), api('/api/jobs')]);
    const files = Array.isArray(filesData.files) ? filesData.files : [];
    const jobs = Array.isArray(jobsData.jobs) ? jobsData.jobs : [];
    const rows = jobs.map(job => {
      const related = files.filter(file => String(file.key || '').includes(String(job.id || '')));
      const size = related.reduce((sum, file) => sum + Number(file.size || 0), 0);
      return { job, size, count: related.length };
    }).filter(row => row.size > 0).sort((a, b) => b.size - a.size).slice(0, 8);
    const host = $('#storageHeavyList');
    if (!host) return;
    host.classList.toggle('empty-state', !rows.length);
    host.innerHTML = rows.length ? rows.map(({ job, size, count }) => `<div class="heavy-row"><div><b>${esc(job.series || job.title || 'งานพากย์')}</b><span>${esc(statusLabel(job.status))} · ${count} ไฟล์</span></div><strong>${esc(fmtBytes(size))}</strong></div>`).join('') : 'ยังไม่มี Job ที่มีไฟล์ผูกอยู่ใน workspace';
  }

  function installStorageHooks() {
    document.body.addEventListener('click', event => {
      const nav = event.target.closest('[data-page="storage"]');
      if (nav) window.setTimeout(() => hydrateStorageExtras().catch(() => {}), 50);
      if (event.target.closest('#refreshBtn')) window.setTimeout(() => hydrateStorageExtras().catch(() => {}), 100);
    });
  }

  function updateStaticWords() {
    const status = $('#r3Health');
    if (status && /R3/.test(status.textContent || '')) status.textContent = status.classList.contains('ready') ? 'ระบบพร้อม' : 'กำลังตรวจระบบ';
    $$('.r3-repair-btn').forEach(btn => { btn.textContent = 'ซ่อมช่วง'; });
  }

  function installJobRenderer() {
    try { window.jobHtml = studioJobHtml; } catch {}
  }

  function init() {
    installJobRenderer();
    installFetchUxBridge();
    installMessageBridge();
    installUiObserver();
    installProjectFreshStart();
    installConfirmActions();
    installStorageHooks();
    setDefaultMode();
    relocateProjectPanel();
    mountDlbunnyHelper();
    decorateAllJobs();
    syncUploadTelemetry();
    updateStaticWords();
    window.setTimeout(async () => {
      relocateProjectPanel();
      mountDlbunnyHelper();
      decorateAllJobs();
      syncUploadTelemetry();
      updateStaticWords();
      if ($('[data-page-panel="storage"].active')) await hydrateStorageExtras().catch(() => {});
    }, 400);
    document.documentElement.dataset.studio = 'production-v5';
    document.documentElement.dataset.studioDesignSystem = 'single-layer-v5';
    document.documentElement.dataset.serverSideSourceVerify = 'enabled';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
