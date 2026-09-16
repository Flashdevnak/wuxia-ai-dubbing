(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const PROJECT_LAST = 'wuxia-r3-project-last-v1';
  const ACCESS_KEY_SESSION = 'wuxia-access-key-v2';
  const state = { busy: false, lastToast: '', lastToastAt: 0 };

  function safeText(value) {
    return String(value || '')
      .replace(/[⚔⚡☁✓✔⚠↻▶⏸◆🔥✨🤖🧩]/gu, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
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
    node.innerHTML = `<div><b>${title || (kind === 'error' ? 'เกิดปัญหา' : kind === 'success' ? 'เรียบร้อย' : kind === 'warning' ? 'ตรวจสอบอีกครั้ง' : 'สถานะงาน')}</b><span></span></div><button type="button" aria-label="ปิด">×</button>`;
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
        : /เสร็จ|เริ่มประมวลผล|พร้อม|ทำต่อ/.test(lower) ? 'success'
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
    } catch {
      $('#uploadCard')?.click();
    }
  }

  function phaseIndex(percent, card) {
    if (card.classList.contains('completed') || percent >= 100) return 6;
    const stage = safeText($('.job-stage', card)?.textContent).toLowerCase();
    if (/ตรวจ|quality/.test(stage)) return 5;
    if (/รวม|mix|final/.test(stage)) return 4;
    if (/พากย์|voice|tts/.test(stage)) return 3;
    if (/แปล|translate/.test(stage)) return 2;
    if (/ถอด|whisper|subtitle|คำบรรยาย/.test(stage)) return 1;
    if (/เตรียม|ดาวน์โหลด|แยกเสียง|prepare/.test(stage)) return 0;
    if (percent >= 92) return 5;
    if (percent >= 76) return 4;
    if (percent >= 52) return 3;
    if (percent >= 34) return 2;
    if (percent >= 16) return 1;
    return 0;
  }

  const PHASES = ['เตรียมไฟล์', 'ถอดคำ', 'แปล', 'พากย์', 'รวมวิดีโอ', 'ตรวจคุณภาพ', 'เสร็จ'];

  function decorateJob(card) {
    if (!card) return;
    const pct = Math.max(0, Math.min(100, Number(($('.job-foot b', card)?.textContent || '').replace('%', '')) || 0));
    const current = phaseIndex(pct, card);
    let strip = $('.phase-strip', card);
    if (!strip) {
      strip = document.createElement('div');
      strip.className = 'phase-strip';
      strip.innerHTML = PHASES.map(() => '<i></i>').join('');
      const sword = $('.job-sword', card);
      if (sword) sword.insertAdjacentElement('beforebegin', strip);
      const labels = document.createElement('div');
      labels.className = 'phase-labels';
      labels.innerHTML = PHASES.map(name => `<span>${name}</span>`).join('');
      strip.insertAdjacentElement('afterend', labels);
    }
    $$('.phase-strip i', card).forEach((node, index) => {
      node.classList.toggle('done', index < current || card.classList.contains('completed'));
      node.classList.toggle('current', index === current && !card.classList.contains('completed'));
    });
    $$('.phase-labels span', card).forEach((node, index) => node.classList.toggle('phase-current', index === current));

    $$('.mini-btn', card).forEach(button => {
      button.textContent = safeText(button.textContent)
        .replace(/^หยุดชั่วคราว$/, 'พักงาน')
        .replace(/^ทำต่อ$/, 'ทำต่อ')
        .replace(/^ลองใหม่$/, 'ลองใหม่');
    });
    const del = $('[data-delete-job]', card);
    if (del) del.textContent = 'ลบงาน';
    const repair = $('.r3-repair-btn', card);
    const isTranscript = /คำบรรยาย youtube/i.test($('.job-meta', card)?.textContent || '');
    if (repair && isTranscript) repair.remove();
  }

  function decorateAllJobs() {
    $$('.job-card').forEach(decorateJob);
  }

  function installUiObserver() {
    const observer = new MutationObserver(() => {
      if (state.busy) return;
      state.busy = true;
      requestAnimationFrame(() => {
        try {
          relocateProjectPanel();
          decorateAllJobs();
        } finally { state.busy = false; }
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function projectTitleFromFields(body = {}) {
    const series = String($('#r3Series')?.value || '').trim();
    const season = Math.max(1, Number($('#r3Season')?.value || 1) || 1);
    const episode = Math.max(1, Number($('#r3Episode')?.value || 1) || 1);
    if (series) return `${series} · S${season} EP${episode}`;
    if (body?.sourceType === 'upload') return `งานพากย์ · S${season} EP${episode}`;
    return body?.title || `งานพากย์ · S${season} EP${episode}`;
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
            init = { ...init, body: JSON.stringify(body) };
          }
        } catch {}
      }
      let response;
      try {
        response = await original(input, init);
      } catch (err) {
        if (createsDubbingJob) toast(err?.message || 'ส่งงานไม่สำเร็จ', 'error');
        throw err;
      }
      if (createsDubbingJob && response.ok) {
        window.setTimeout(() => clearProjectIdentity({ preserveGlossary: true }), 0);
        toast('สร้างงานแล้ว ชื่อเรื่อง Season และ EP ถูกล้างเพื่อพร้อมสำหรับงานใหม่', 'success', 'เริ่มงานแล้ว');
      }
      if (method === 'DELETE' && /\/api\/jobs\//.test(url) && response.ok) toast('ลบงานและไฟล์ที่เกี่ยวข้องแล้ว', 'success', 'ลบงานแล้ว');
      return response;
    };
  }

  function installActionFeedback() {
    document.body.addEventListener('click', event => {
      const deleteJob = event.target.closest('[data-delete-job]');
      if (deleteJob) window.setTimeout(() => toast('ถ้ายืนยันการลบ ระบบจะนำงานออกจากรายการและคืนพื้นที่ที่เกี่ยวข้อง', 'warning', 'กำลังลบงาน'), 0);
      const deleteFile = event.target.closest('[data-delete-file]');
      if (deleteFile) window.setTimeout(() => toast('ถ้ายืนยันการลบ ไฟล์นี้จะถูกนำออกจากพื้นที่ใช้งาน', 'warning', 'กำลังลบไฟล์'), 0);
    });
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
      if (run() || tries > 20) clearInterval(timer);
    }, 100);
  }

  function updateStaticWords() {
    const status = $('#r3Health');
    if (status && /R3/.test(status.textContent || '')) status.textContent = status.classList.contains('ready') ? 'ระบบพร้อม' : 'กำลังตรวจระบบ';
    const repair = $$('.r3-repair-btn');
    repair.forEach(btn => { btn.textContent = 'ซ่อมช่วง'; });
  }

  function init() {
    installFetchUxBridge();
    installMessageBridge();
    installUiObserver();
    installActionFeedback();
    installProjectFreshStart();
    setDefaultMode();
    relocateProjectPanel();
    decorateAllJobs();
    updateStaticWords();
    window.setTimeout(() => { relocateProjectPanel(); decorateAllJobs(); updateStaticWords(); }, 400);
    document.documentElement.dataset.studio = 'v2';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
