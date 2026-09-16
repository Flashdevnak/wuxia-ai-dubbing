(() => {
  const CHUNK_PATH = '/api/uploads/chunk';
  const active = new Map();
  let hiddenAt = 0;
  let recoveryTimer = null;
  let returnSeq = 0;
  let backgroundProgressSeen = false;

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
      if (/อัปโหลด|กำลังส่ง|ช่องทาง|ทำต่อ|หยุดชั่วคราว|กลับมาทำต่อ|เบื้องหลัง|Android/.test(current)) {
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

    // Background Upload V2: do not intentionally pause new multipart requests
    // when the tab is hidden. Android/Chrome may still freeze the process at OS level,
    // but while the browser grants network time the upload continues normally.
    originalSend.call(xhr, body);
  };

  function recoverAfterForeground() {
    const seq = ++returnSeq;
    clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(() => {
      if (seq !== returnSeq || document.hidden) return;

      const staleBefore = now() - 8000;
      let aborted = 0;
      let healthy = 0;

      for (const meta of active.values()) {
        if (meta.settled) continue;
        if (meta.lastProgressAt <= staleBefore) {
          try {
            meta.xhr.abort();
            aborted += 1;
          } catch {}
        } else {
          healthy += 1;
        }
      }

      hiddenAt = 0;
      if (aborted) {
        updateStatus('กลับมาหน้าเว็บแล้ว · กำลังเชื่อมต่อใหม่เฉพาะส่วนที่ Android พักไว้');
      } else if (healthy || backgroundProgressSeen) {
        updateStatus('กลับมาหน้าเว็บแล้ว · การอัปโหลดยังทำงานต่อเนื่อง');
      }
      backgroundProgressSeen = false;
    }, 2500);
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

  // Ask the browser to keep site storage durable when supported. This protects
  // multipart resume metadata from normal storage eviction; it does not bypass
  // Android process suspension.
  try {
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  } catch {}

  document.documentElement.dataset.mobileUploadRecovery = 'background-best-effort-v2';
  document.documentElement.dataset.mobileBackgroundUpload = 'best-effort-v2';
})();
