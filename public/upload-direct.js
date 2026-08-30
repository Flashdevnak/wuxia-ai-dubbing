// Browser upload v3: Cloudflare only creates/authenticates the Drive session.
// Video bytes go Browser -> Google Drive directly, so Android uploads no longer
// depend on a long binary POST through workers.dev.

function parseDriveRange(value) {
  const m = String(value || '').match(/bytes\s*=\s*0-(\d+)/i);
  return m ? Number(m[1]) + 1 : null;
}

function driveXhr(sessionUrl, { body = null, contentRange, overallStart = 0, totalBytes = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', sessionUrl, true);
    xhr.timeout = 180000;
    xhr.responseType = 'text';
    if (contentRange) xhr.setRequestHeader('Content-Range', contentRange);

    if (body && xhr.upload) {
      xhr.upload.onprogress = e => {
        if (!e.lengthComputable) return;
        const sent = Math.min(totalBytes, overallStart + e.loaded);
        const pct = totalBytes ? (sent / totalBytes) * 100 : 0;
        $('#uploadPct').textContent = Math.floor(pct) + '%';
        $('#uploadBar').style.width = pct + '%';
        $('#uploadStatus').textContent = `ส่งตรงไป Google Drive · ${fmtBytes(sent)} / ${fmtBytes(totalBytes)}`;
      };
    }

    xhr.onload = () => {
      const status = xhr.status;
      if (status === 308 || (status >= 200 && status < 300)) {
        let data = {};
        try { data = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch {}
        resolve({ status, range: xhr.getResponseHeader('Range'), data });
        return;
      }
      reject(new Error(`Google Drive ตอบ HTTP ${status || 0}${xhr.responseText ? ': ' + xhr.responseText.slice(0, 240) : ''}`));
    };
    xhr.onerror = () => reject(new Error('เชื่อมต่อ Google Drive โดยตรงไม่สำเร็จ'));
    xhr.ontimeout = () => reject(new Error('ส่งข้อมูลไป Google Drive เกิน 180 วินาที'));
    xhr.onabort = () => reject(new Error('การอัปโหลดถูกยกเลิก'));
    xhr.send(body);
  });
}

async function queryDriveOffset(sessionUrl, totalBytes) {
  const r = await driveXhr(sessionUrl, {
    body: null,
    contentRange: `bytes */${totalBytes}`,
    totalBytes,
  });
  if (r.status >= 200 && r.status < 300 && r.status !== 308) {
    return { complete: true, offset: totalBytes };
  }
  return { complete: false, offset: parseDriveRange(r.range) ?? 0 };
}

uploadFile = async function uploadFileDirectToDrive(file) {
  $('#uploadProgress').classList.remove('hidden');
  $('#uploadName').textContent = file.name;
  $('#uploadPct').textContent = '0%';
  $('#uploadBar').style.width = '0%';
  $('#uploadStatus').textContent = 'กำลังขอช่องอัปโหลดจาก Google Drive...';

  let init;
  try {
    init = await api('/api/uploads/start', {
      method: 'POST',
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
      }),
    });
  } catch (e) {
    throw new Error(`เปิดการอัปโหลดไม่สำเร็จ: ${e.message}`);
  }

  const { key, uploadId, directSession, directUpload } = init;
  if (!directUpload || !directSession) {
    throw new Error('เซิร์ฟเวอร์ยังไม่ได้เปิดโหมดอัปโหลดตรงไป Google Drive');
  }

  const partSize = Math.max(256 * 1024, Number(init.partSize) || 4 * 1024 * 1024);
  let offset = 0;
  let consecutiveFailures = 0;
  $('#uploadStatus').textContent = `เชื่อม Google Drive แล้ว · ส่งตรงโดยไม่ผ่าน Cloudflare (${fmtBytes(partSize)}/ช่วง)`;

  while (offset < file.size) {
    const start = offset;
    const end = Math.min(file.size, start + partSize);
    const chunk = file.slice(start, end, file.type || 'application/octet-stream');
    const range = `bytes ${start}-${end - 1}/${file.size}`;

    try {
      const r = await driveXhr(directSession, {
        body: chunk,
        contentRange: range,
        overallStart: start,
        totalBytes: file.size,
      });

      if (r.status === 308) {
        const confirmed = parseDriveRange(r.range);
        offset = confirmed != null && confirmed > start ? confirmed : end;
      } else {
        offset = file.size;
      }
      consecutiveFailures = 0;
    } catch (uploadErr) {
      consecutiveFailures++;
      $('#uploadStatus').textContent = `การเชื่อมต่อสะดุด · กำลังตรวจตำแหน่ง Resume (${consecutiveFailures}/5)`;

      try {
        const status = await queryDriveOffset(directSession, file.size);
        if (status.complete) {
          offset = file.size;
          break;
        }
        if (status.offset > offset) {
          offset = status.offset;
          consecutiveFailures = 0;
          continue;
        }
      } catch {}

      if (consecutiveFailures >= 5) {
        await api('/api/uploads/abort', {
          method: 'POST',
          body: JSON.stringify({ key, uploadId }),
        }).catch(() => {});
        throw new Error(`${uploadErr.message} (ลองใหม่ 5 ครั้งแล้ว)`);
      }
      await sleep(1000 * consecutiveFailures);
      continue;
    }

    const pct = file.size ? (offset / file.size) * 100 : 100;
    $('#uploadPct').textContent = Math.min(100, Math.floor(pct)) + '%';
    $('#uploadBar').style.width = Math.min(100, pct) + '%';
    $('#uploadStatus').textContent = `Google Drive รับแล้ว ${fmtBytes(offset)} / ${fmtBytes(file.size)} · Resume ได้`;
  }

  $('#uploadStatus').textContent = 'ส่งไฟล์ครบแล้ว · กำลังตรวจสอบขนาดบน Google Drive';
  const done = await api('/api/uploads/complete', {
    method: 'POST',
    body: JSON.stringify({ key, uploadId, parts: [] }),
  });

  if (Number(done.size) !== Number(file.size)) {
    throw new Error(`ขนาดไฟล์บน Drive ไม่ตรง: ${done.size}/${file.size} bytes`);
  }

  state.sourceKey = key;
  $('#uploadPct').textContent = '100%';
  $('#uploadBar').style.width = '100%';
  $('#uploadStatus').textContent = 'อัปโหลดเสร็จแล้ว · ไฟล์อยู่ใน Google Drive พร้อมสร้างงาน';
  await loadStorage();
  return key;
};
