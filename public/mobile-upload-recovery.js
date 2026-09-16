(() => {
  const CHUNK_PATH = '/api/uploads/chunk';
  const active = new Map();
  let hiddenAt = 0;
  let recoveryTimer = null;
  let returnSeq = 0;
  let backgroundProgressSeen = false;

  const FIRST_PROBE_MS = 700;
  const PROBE_INTERVAL_MS = 1500;
  const STALE_FOREGROUND_MS = 6500;
  const MAX_PROBES = 8;

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
      if (/อัปโหลด|กำลังส่ง|ช่องทาง|ทำต่อ|หยุดชั่วคราว|กลับมาทำต่อ|เบื้องหลัง|Android|เชื่อมต่อ/.test(current)) {
        node.textContent = text;
      }
    }
  }

  function markBackgroundProgress() {
    if (!document.hidden) return;
    backgroundProgressSeen = true;
    updateStatus('กำลังอัปโหลดเบื้องหลัง · ส่งข้อมูลต่อได้ในขณะนี้');
  }

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__wuxiaUrl = String(url || '');
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function(body) {
    if (!isUpload(this)) return originalSend.call(this, body);

    const xhr = this;
    const id = Symbol('upload-xhr');
    const meta = {
      xhr,
      id,
      startedAt: now(),
      lastProgressAt: now(),
      settled: false,
      hiddenProgress: false,
    };
    active.set(id, meta);

    const settle = () => {
      meta.settled = true;
      active.delete(id);
    };

    xhr.addEventListener('loadend', settle, { once: true });
    xhr.upload?.addEventListener('progress', () => {
      meta.lastProgressAt = now();
      if (document.hidden) {
        meta.hiddenProgress = true;
        markBackgroundProgress();
      }
    });

    // Do not intentionally pause when hidden. Android may suspend the process,
    // but every multipart part already confirmed by R2 remains resumable.
    originalSend.call(xhr, body);
  };

  function recoverAfterForeground() {
    const seq = ++returnSeq;
    const returnedAt = now();
    clearTimeout(recoveryTimer);

    if (active.size) {
      updateStatus('กลับมาหน้าเว็บแล้ว · กำลังตรวจการเชื่อมต่ออัปโหลด');
    }

    let probeCount = 0;
    const probe = () => {
      if (seq !== returnSeq || document.hidden) return;
      probeCount += 1;

      let aborted = 0;
      let progressedAfterReturn = 0;
      let pending = 0;

      for (const meta of active.values()) {
        if (meta.settled) continue;
        pending += 1;
        if (meta.lastProgressAt >= returnedAt) {
          progressedAfterReturn += 1;
          continue;
        }
        if (now() - meta.lastProgressAt < STALE_FOREGROUND_MS) continue;
        try {
          meta.xhr.abort();
          aborted += 1;
        } catch {}
      }

      hiddenAt = 0;
      if (aborted) {
        updateStatus('พบช่องอัปโหลดที่ค้าง · เชื่อมต่อใหม่เฉพาะส่วนที่ค้างทันที');
      } else if (progressedAfterReturn) {
        updateStatus('กลับมาหน้าเว็บแล้ว · อัปโหลดเดินต่อแล้ว');
      } else if (pending) {
        updateStatus('กลับมาหน้าเว็บแล้ว · กำลังรอข้อมูลเดินต่อ ถ้ายังค้างระบบจะเชื่อมต่อใหม่อัตโนมัติ');
      } else if (backgroundProgressSeen) {
        updateStatus('กลับมาหน้าเว็บแล้ว · ข้อมูลเบื้องหลังถูกส่งต่อเรียบร้อย');
      }

      backgroundProgressSeen = false;
      if (pending && probeCount < MAX_PROBES) {
        recoveryTimer = setTimeout(probe, PROBE_INTERVAL_MS);
      }
    };

    recoveryTimer = setTimeout(probe, FIRST_PROBE_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = now();
      backgroundProgressSeen = false;
      updateStatus('กำลังพยายามอัปโหลดเบื้องหลัง · Android อาจพักเครือข่ายชั่วคราว แต่ส่วนที่ส่งสำเร็จจะไม่หาย');
      return;
    }
    recoverAfterForeground();
  });

  window.addEventListener('pageshow', recoverAfterForeground);
  window.addEventListener('focus', () => {
    if (!document.hidden) recoverAfterForeground();
  });
  window.addEventListener('online', () => {
    if (!document.hidden) recoverAfterForeground();
  });

  try {
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  } catch {}

  document.documentElement.dataset.mobileUploadRecovery = 'foreground-watchdog-v3';
  document.documentElement.dataset.mobileBackgroundUpload = 'best-effort-v3';
})();