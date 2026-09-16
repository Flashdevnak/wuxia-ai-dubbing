(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const ACCESS_KEY_SESSION = 'wuxia-access-key-v2';
  const PROJECT_LAST = 'wuxia-r3-project-last-v1';
  const state = { health: null, saveTimer: 0 };

  function esc(value) {
    return String(value ?? '').replace(/[&<>\"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[c] || c));
  }

  function glossaryObject() {
    const text = String($('#r3Glossary')?.value || '').trim();
    const out = {};
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const match = line.match(/^(.+?)(?:=>|=|→)(.+)$/);
      if (!match) continue;
      const from = match[1].trim().slice(0, 80);
      const to = match[2].trim().slice(0, 120);
      if (from && to) out[from] = to;
      if (Object.keys(out).length >= 120) break;
    }
    return out;
  }

  function r3Payload() {
    return {
      r3Enabled: true,
      r3ContextTranslation: true,
      r3TimingRescue: true,
      r3QualityGate: true,
      r3Cache: true,
      series: String($('#r3Series')?.value || '').trim().slice(0, 120),
      season: Math.max(1, Number($('#r3Season')?.value || 1) || 1),
      episode: Math.max(1, Number($('#r3Episode')?.value || 1) || 1),
      glossary: glossaryObject(),
    };
  }

  function projectSnapshot() {
    return {
      series: String($('#r3Series')?.value || '').trim().slice(0, 120),
      season: Math.max(1, Number($('#r3Season')?.value || 1) || 1),
      episode: Math.max(1, Number($('#r3Episode')?.value || 1) || 1),
      glossaryText: String($('#r3Glossary')?.value || '').slice(0, 12000),
      updatedAt: new Date().toISOString(),
    };
  }

  function saveProjectNow() {
    try { localStorage.setItem(PROJECT_LAST, JSON.stringify(projectSnapshot())); } catch {}
  }

  function queueProjectSave() {
    window.clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(saveProjectNow, 180);
  }

  function restoreProject() {
    try {
      const saved = JSON.parse(localStorage.getItem(PROJECT_LAST) || 'null');
      if (!saved || typeof saved !== 'object') return;
      if ($('#r3Series') && saved.series) $('#r3Series').value = String(saved.series).slice(0, 120);
      if ($('#r3Season')) $('#r3Season').value = Math.max(1, Number(saved.season || 1) || 1);
      if ($('#r3Episode')) $('#r3Episode').value = Math.max(1, Number(saved.episode || 1) || 1);
      if ($('#r3Glossary') && saved.glossaryText) $('#r3Glossary').value = String(saved.glossaryText).slice(0, 12000);
    } catch {}
  }

  function advanceEpisode(expectedEpisode) {
    const field = $('#r3Episode');
    if (!field) return;
    const current = Math.max(1, Number(field.value || 1) || 1);
    if (!Number.isFinite(Number(expectedEpisode)) || current === Number(expectedEpisode)) field.value = current + 1;
    saveProjectNow();
  }

  function installFetchBridge() {
    if (window.__WUXIA_R3_FETCH__) return;
    window.__WUXIA_R3_FETCH__ = true;
    const original = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      let r3Job = false;
      let submittedEpisode = null;
      try {
        const url = typeof input === 'string' ? input : String(input?.url || '');
        const method = String(init?.method || (typeof input !== 'string' ? input?.method : 'GET') || 'GET').toUpperCase();
        if (method === 'POST' && /\/api\/jobs(?:\?|$)/.test(url) && typeof init.body === 'string') {
          const body = JSON.parse(init.body);
          if (body && body.jobType !== 'transcript') {
            const extra = r3Payload();
            submittedEpisode = extra.episode;
            init = { ...init, body: JSON.stringify({ ...body, ...extra }) };
            r3Job = true;
            saveProjectNow();
          }
        }
      } catch (err) {
        console.warn('R3 payload bridge skipped', err);
      }
      const response = await original(input, init);
      if (r3Job && response.ok) {
        try {
          const data = await response.clone().json();
          if (data?.job?.id) advanceEpisode(submittedEpisode);
        } catch {}
      }
      return response;
    };
  }

  function installStudioPanel() {
    const createPanel = $('.create-panel');
    const optionGrid = $('.option-grid');
    if (!createPanel || !optionGrid || $('#r3StudioPanel')) return;
    const panel = document.createElement('section');
    panel.id = 'r3StudioPanel';
    panel.className = 'r3-studio-panel';
    panel.innerHTML = `
      <div class="r3-title"><div><b>Smart Dubbing Studio R3</b><span>จำศัพท์ของเรื่อง • รักษาเสียงตัวละคร • ซ่อมเฉพาะช่วง • ไม่ทำงานซ้ำโดยไม่จำเป็น</span></div><em id="r3Health">กำลังตรวจระบบ</em></div>
      <div class="r3-fields">
        <label><span>ชื่อเรื่อง / โปรเจกต์</span><input id="r3Series" maxlength="120" placeholder="เช่น เจ้าสำนักแห่งยุค" /></label>
        <label><span>Season</span><input id="r3Season" type="number" min="1" max="9999" value="1" /></label>
        <label><span>EP ถัดไป</span><input id="r3Episode" type="number" min="1" max="9999" value="1" /></label>
      </div>
      <label class="r3-glossary"><span>พจนานุกรมประจำเรื่อง <small>หนึ่งบรรทัดต่อหนึ่งคำ เช่น 宗主 = เจ้าสำนัก</small></span><textarea id="r3Glossary" rows="3" placeholder="宗主 = เจ้าสำนัก\n师尊 = ท่านอาจารย์"></textarea></label>
      <div class="r3-feature-grid">
        <span>แปลตามบริบททั้งฉาก</span><span>Timing Rescue</span><span>Quality Gate ก่อนจบงาน</span><span>Cache ลดการทำซ้ำ</span>
      </div>
      <details class="r3-batch"><summary>สร้างหลาย EP ต่อเนื่อง</summary>
        <p>วาง YouTube URL หนึ่งรายการต่อบรรทัด ระบบสร้างงานจริงแยก EP และติดตามได้ในหน้างานพากย์</p>
        <textarea id="r3BatchUrls" rows="4" placeholder="https://www.youtube.com/watch?v=...\nhttps://www.youtube.com/watch?v=..."></textarea>
        <div class="r3-batch-actions"><button type="button" id="r3BatchBtn" class="btn ghost">สร้าง Batch</button><span id="r3BatchStatus"></span></div>
      </details>`;
    optionGrid.insertAdjacentElement('afterend', panel);
    restoreProject();
    ['#r3Series', '#r3Season', '#r3Episode', '#r3Glossary'].forEach(selector => {
      $(selector)?.addEventListener('input', queueProjectSave);
      $(selector)?.addEventListener('change', queueProjectSave);
    });
    $('#r3BatchBtn')?.addEventListener('click', createBatch);
  }

  async function authedFetch(path, options = {}) {
    const key = sessionStorage.getItem(ACCESS_KEY_SESSION) || '';
    if (!key) throw new Error('กรุณาเริ่มใช้งานระบบหรือกรอกรหัสเข้าใช้งานก่อน');
    const headers = { ...(options.headers || {}), 'x-access-key': key };
    if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
    const r = await fetch(path, { ...options, headers, cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || data.detail || `HTTP ${r.status}`);
    return data;
  }

  async function createBatch() {
    const status = $('#r3BatchStatus');
    try {
      const urls = String($('#r3BatchUrls')?.value || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      if (!urls.length) throw new Error('กรุณาวาง URL อย่างน้อย 1 รายการ');
      if (urls.length > 10) throw new Error('ต่อหนึ่ง Batch รองรับสูงสุด 10 งาน');
      const base = r3Payload();
      const startEp = Number(base.episode || 1);
      const common = {
        sourceLang: $('#sourceLang')?.value || 'auto',
        targetLang: $('#targetLang')?.value || 'th',
        voiceMode: $('#voiceMode')?.value || 'auto-cast',
        processingMode: $('#processingMode')?.value || 'fast',
        subtitles: $('#subtitles')?.checked !== false,
        keepMusic: $('#keepMusic')?.checked !== false,
        speakerSeparation: $('#speakerSep')?.checked === true,
        autoCleanup: $('#autoCleanup')?.checked !== false,
      };
      const items = urls.map((sourceUrl, i) => ({
        ...common, ...base,
        sourceType: 'link', sourceUrl,
        episode: startEp + i,
        title: `${base.series || 'งานพากย์'} EP ${startEp + i}`,
      }));
      if (status) status.textContent = 'กำลังสร้างงาน...';
      const data = await authedFetch('/api/r3/batch', { method: 'POST', body: JSON.stringify({ items }) });
      if (status) status.textContent = `สร้างแล้ว ${data.count || items.length} งาน`;
      if ($('#r3Episode')) $('#r3Episode').value = startEp + (data.count || items.length);
      saveProjectNow();
      $('#refreshBtn')?.click();
    } catch (err) {
      if (status) status.textContent = err.message;
    }
  }

  function installRepairButtons() {
    const patch = () => {
      $$('.job-card').forEach(card => {
        const actionBar = $('.job-actions', card);
        if (!actionBar || $('.r3-repair-btn', card)) return;
        const idNode = $('[data-job-id]', card) || $('[data-delete-job]', card);
        const id = idNode?.dataset?.jobId || idNode?.dataset?.deleteJob;
        if (!id) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mini-btn r3-repair-btn';
        btn.dataset.r3RepairJob = id;
        btn.textContent = 'ซ่อมเฉพาะช่วง';
        actionBar.insertBefore(btn, actionBar.lastElementChild || null);
      });
    };
    const observer = new MutationObserver(patch);
    observer.observe(document.body, { childList: true, subtree: true });
    patch();

    document.body.addEventListener('click', async event => {
      const btn = event.target.closest('[data-r3-repair-job]');
      if (!btn) return;
      event.preventDefault();
      const id = btn.dataset.r3RepairJob;
      const chunkText = prompt('ช่วงที่ต้องซ่อม (เริ่มจาก 1) เช่น 1 หรือ 2,3', '1');
      if (!chunkText) return;
      const chunks = chunkText.split(',').map(x => Number(x.trim()) - 1).filter(x => Number.isInteger(x) && x >= 0);
      if (!chunks.length) return alert('หมายเลขช่วงไม่ถูกต้อง');
      const choice = prompt('เลือกวิธี: retranslate / change_voice / slower / faster / edit_text', 'retranslate');
      if (!choice) return;
      let value = null;
      if (choice === 'change_voice') value = prompt('โปรไฟล์เสียง เช่น adult-male, adult-female, narrator', 'adult-male');
      if (choice === 'edit_text') value = prompt('ข้อความไทยใหม่สำหรับประโยคแรกของช่วงนี้', '');
      try {
        btn.disabled = true;
        btn.textContent = 'กำลังส่งซ่อม';
        await authedFetch(`/api/r3/jobs/${encodeURIComponent(id)}/repair`, {
          method: 'POST',
          body: JSON.stringify({ chunks, action: choice, value }),
        });
        btn.textContent = 'ส่งซ่อมแล้ว';
        $('#refreshBtn')?.click();
      } catch (err) {
        btn.textContent = 'ซ่อมเฉพาะช่วง';
        alert(err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function loadHealth() {
    const node = $('#r3Health');
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      const data = await r.json();
      state.health = data;
      if (!data.r3SmartStudio || !data.finalQualityGate) throw new Error('R3 runtime ยังไม่พร้อมครบทุก gate');
      if (node) { node.textContent = 'R3 พร้อมใช้งาน'; node.classList.add('ready'); }
      document.documentElement.dataset.r3SmartStudio = 'ready';
    } catch (err) {
      if (node) { node.textContent = 'R3 ไม่พร้อม'; node.title = err.message; }
    }
  }

  function init() {
    installFetchBridge();
    installStudioPanel();
    installRepairButtons();
    loadHealth();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
