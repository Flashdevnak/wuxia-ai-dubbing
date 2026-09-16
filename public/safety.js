(() => {
  const qs = s => document.querySelector(s);
  const apiBase = window.WUXIA_API_BASE || '';

  function loadFullAutoEnhancements() {
    if (!document.querySelector('link[data-full-auto]')) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = './full-auto.css?v=full1';
      css.dataset.fullAuto = '1';
      document.head.appendChild(css);
    }
    if (!document.querySelector('script[data-full-auto]')) {
      const script = document.createElement('script');
      script.src = './full-auto.js?v=full1';
      script.defer = true;
      script.dataset.fullAuto = '1';
      document.head.appendChild(script);
    }
  }

  async function health() {
    const badge = qs('#deployMode');
    const start = qs('#startBtn');
    try {
      const response = await fetch(apiBase + '/api/health', { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      const storageReady = data.storageReady === true || data.driveReady === true;
      const ready = response.ok && data.ok === true && storageReady;
      if (badge) badge.textContent = ready ? 'ระบบพร้อมพากย์' : 'พื้นที่ชั่วคราวมีปัญหา';
      if (start) start.disabled = !ready;
      if (!ready && qs('#message')) {
        qs('#message').textContent = data.detail || 'พื้นที่ชั่วคราวยังไม่พร้อม ระบบปิดปุ่มเริ่มงานชั่วคราว';
      }
      return ready;
    } catch (err) {
      if (badge) badge.textContent = 'เชื่อมต่อระบบไม่ได้';
      if (start) start.disabled = true;
      if (qs('#message')) qs('#message').textContent = err?.message || 'เชื่อมต่อระบบไม่ได้';
      return false;
    }
  }

  async function secureDownload(key) {
    try {
      const data = await api('/api/files/download-ticket', {
        method: 'POST',
        body: JSON.stringify({ key }),
      });
      if (!data?.ticket) throw new Error('สร้างลิงก์ดาวน์โหลดชั่วคราวไม่สำเร็จ');
      const url = `${apiBase}/api/files/download?key=${encodeURIComponent(key)}&ticket=${encodeURIComponent(data.ticket)}`;
      window.location.assign(url);
    } catch (err) {
      const message = qs('#message');
      if (message) message.textContent = err?.message || 'ดาวน์โหลดไม่สำเร็จ';
      else window.alert(err?.message || 'ดาวน์โหลดไม่สำเร็จ');
    }
  }

  try {
    window.downloadFile = secureDownload;
    downloadFile = secureDownload;
  } catch {}

  document.addEventListener('click', async event => {
    const button = event.target.closest?.('[data-delete-job]');
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!window.confirm('ลบงานนี้และไฟล์ที่เกี่ยวข้องหรือไม่?')) return;
    try {
      await api('/api/jobs/' + encodeURIComponent(button.dataset.deleteJob), { method: 'DELETE' });
      try { delete state.progressFloor[button.dataset.deleteJob]; } catch {}
      await Promise.all([loadJobs(), loadFiles(), loadStorage()]);
    } catch (err) {
      const message = qs('#message');
      if (message) message.textContent = err?.message || 'ลบงานไม่สำเร็จ';
      else window.alert(err?.message || 'ลบงานไม่สำเร็จ');
      await loadJobs().catch(() => {});
    }
  }, true);

  const keepMusicLabel = qs('#keepMusic')?.closest('label')?.querySelector('b');
  if (keepMusicLabel) {
    keepMusicLabel.textContent = 'เก็บเพลง/เสียงประกอบ (ลดเสียงต้นฉบับขณะพากย์)';
    keepMusicLabel.title = 'ระบบลดเสียงต้นฉบับขณะมีเสียงไทย ไม่ใช่การแยกเพลงออกจากบทพูดแบบสมบูรณ์';
  }

  const speakerLabel = qs('#speakerSep')?.closest('label')?.querySelector('b');
  if (speakerLabel) {
    speakerLabel.textContent = 'Auto Cast หลายเสียงตามช่วงบทสนทนา';
    speakerLabel.title = 'ระบบเลือกโปรไฟล์เสียงตามช่วงบทสนทนาแบบอัตโนมัติ เป็น heuristic ไม่ใช่การพิสูจน์ตัวตนผู้พูด';
  }

  loadFullAutoEnhancements();
  health();
  window.setInterval(() => {
    if (!document.hidden) health();
  }, 60_000);
})();
