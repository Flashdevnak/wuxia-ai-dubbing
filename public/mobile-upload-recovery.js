(() => {
  const CHUNK_PATH = '/api/uploads/chunk';
  const active = new Map();
  let hiddenAt = 0;
  let recoveryTimer = null;
  let returnSeq = 0;

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  function isUpload(xhr) {
    return String(xhr.__wuxiaUrl || '').includes(CHUNK_PATH);
  }

  function now() { return Date.now(); }

  function updateStatus(text) {
    const video = document.querySelector('#uploadStatus');
    const audio = document.querySelector('#pairAudioStatus');
    for (const node of [video, audio]) {
      if (!node) continue;
      const current = String(node.textContent || '');
      if (/อัปโหลด|กำลังส่ง|ช่องทาง|ทำต่อ|หยุดชั่วคราว|กลับมาทำต่อ/.test(current)) node.textContent = text;
    }
  }

  function waitUntilVisible(send) {
    if (!document.hidden) { send(); return; }
    const run = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', run);
      window.removeEventListener('pageshow', run);
      window.removeEventListener('focus', run);
      send();
    };
    document.addEventListener('visibilitychange', run);
    window.addEventListener('pageshow', run);
    window.addEventListener('focus', run);
  }

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__wuxiaUrl = String(url || '');
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function(body) {
    if (!isUpload(this)) return originalSend.call(this, body);

    const xhr = this;
    const id = Symbol('upload-xhr');
    const meta = { xhr, id, startedAt: 0, lastProgressAt: now(), settled: false, delayed: false };
    active.set(id, meta);

    const settle = () => {
      meta.settled = true;
      active.delete(id);
    };
    xhr.addEventListener('loadend', settle, { once: true });
    xhr.upload?.addEventListener('progress', () => { meta.lastProgressAt = now(); });

    const actualSend = () => {
      if (meta.settled) return;
      meta.delayed = false;
      meta.startedAt = now();
      meta.lastProgressAt = now();
      originalSend.call(xhr, body);
    };

    if (document.hidden) {
      meta.delayed = true;
      updateStatus('พักการส่งชั่วคราว เพราะหน้าเว็บอยู่เบื้องหลัง · จะทำต่ออัตโนมัติเมื่อกลับมา');
      waitUntilVisible(actualSend);
      return;
    }
    actualSend();
  };

  function recoverForeground() {
    const seq = ++returnSeq;
    clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(() => {
      if (seq !== returnSeq || document.hidden) return;
      const cutoff = now() - 1800;
      let aborted = 0;
      for (const meta of active.values()) {
        if (meta.settled || meta.delayed) continue;
        if (meta.lastProgressAt <= cutoff || (hiddenAt && meta.startedAt && meta.startedAt <= hiddenAt)) {
          try {
            meta.xhr.abort();
            aborted += 1;
          } catch {}
        }
      }
      hiddenAt = 0;
      if (aborted) updateStatus('กลับมาหน้าเว็บแล้ว · กำลังเชื่อมต่อและทำต่อจากส่วนที่อัปโหลดไว้');
    }, 2200);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = now();
      updateStatus('ออกจากหน้าเว็บชั่วคราว · ระบบจะจำส่วนที่ส่งแล้วและทำต่อเมื่อกลับมา');
      return;
    }
    recoverForeground();
  });

  window.addEventListener('pageshow', recoverForeground);
  window.addEventListener('focus', () => { if (!document.hidden) recoverForeground(); });

  document.documentElement.dataset.mobileUploadRecovery = 'foreground-resume-v1';
})();
