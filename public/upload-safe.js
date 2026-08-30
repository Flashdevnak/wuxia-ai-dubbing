// Mobile safe upload: avoids both cross-origin Google PUT and raw binary POST
// from Android browsers. Each 1 MiB slice becomes Base64 JSON to the same-origin
// Worker, which decodes it and forwards bytes to the existing Drive resumable session.

function isMobileUploadClient() {
  return /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '');
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('อ่านส่วนไฟล์จากมือถือไม่สำเร็จ'));
    reader.onload = () => {
      const value = String(reader.result || '');
      const comma = value.indexOf(',');
      if (comma < 0) return reject(new Error('แปลงส่วนไฟล์เป็น Base64 ไม่สำเร็จ'));
      resolve(value.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

if (isMobileUploadClient()) {
  uploadFile = async function uploadFileSafeMobile(file) {
    $('#uploadProgress').classList.remove('hidden');
    $('#uploadName').textContent = file.name;
    $('#uploadPct').textContent = '0%';
    $('#uploadBar').style.width = '0%';
    $('#uploadStatus').textContent = 'กำลังเปิดโหมดอัปโหลดมือถือแบบเสถียร...';

    let init;
    try {
      init = await api('/api/uploads/start-safe', {
        method: 'POST',
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          type: file.type || 'application/octet-stream',
        }),
      });
    } catch (e) {
      throw new Error(`เปิดการอัปโหลดมือถือไม่สำเร็จ: ${e.message}`);
    }

    if (!init.safeUpload || !init.key || !init.uploadId) {
      throw new Error('เซิร์ฟเวอร์ยังไม่ได้เปิดโหมดอัปโหลดมือถือแบบเสถียร');
    }

    const { key, uploadId } = init;
    const partSize = Number(init.partSize) || 1024 * 1024;
    const total = Math.ceil(file.size / partSize);
    const parts = [];

    $('#uploadStatus').textContent = `โหมดมือถือเสถียร · ${total} ส่วน · ไม่ใช้ CORS ไป Google โดยตรง`;

    for (let i = 0; i < total; i++) {
      const start = i * partSize;
      const end = Math.min(file.size, start + partSize);
      const chunk = file.slice(start, end, file.type || 'application/octet-stream');
      let attempt = 0;
      let done = false;
      let lastError;

      while (attempt < 5 && !done) {
        attempt++;
        $('#uploadStatus').textContent = `กำลังส่งส่วน ${i + 1}/${total}${attempt > 1 ? ` · ลองใหม่ ${attempt}/5` : ''}`;
        try {
          const dataB64 = await blobToBase64(chunk);
          const d = await api('/api/uploads/base64-part', {
            method: 'POST',
            body: JSON.stringify({
              key,
              uploadId,
              partNumber: i + 1,
              mimeType: file.type || 'application/octet-stream',
              data: dataB64,
            }),
          });
          if (!d || Number(d.partNumber) !== i + 1) {
            throw new Error('เซิร์ฟเวอร์ไม่ยืนยันส่วนไฟล์');
          }
          parts.push({ partNumber: d.partNumber, etag: d.etag });
          done = true;
        } catch (e) {
          lastError = e;
          if (attempt < 5) await sleep(800 * attempt);
        }
      }

      if (!done) {
        await api('/api/uploads/abort', {
          method: 'POST',
          body: JSON.stringify({ key, uploadId }),
        }).catch(() => {});
        throw new Error(`ส่วน ${i + 1}/${total} ไม่สำเร็จ: ${lastError?.message || 'network error'}`);
      }

      const pct = ((i + 1) / total) * 100;
      $('#uploadPct').textContent = Math.floor(pct) + '%';
      $('#uploadBar').style.width = pct + '%';
      $('#uploadStatus').textContent = `Google Drive รับแล้ว ${fmtBytes(end)} / ${fmtBytes(file.size)} · ส่วน ${i + 1}/${total}`;
    }

    $('#uploadStatus').textContent = 'ส่งครบแล้ว · กำลังตรวจขนาดไฟล์บน Google Drive';
    const done = await api('/api/uploads/complete', {
      method: 'POST',
      body: JSON.stringify({ key, uploadId, parts }),
    });

    if (Number(done.size) !== Number(file.size)) {
      throw new Error(`ขนาดไฟล์บน Drive ไม่ตรง: ${done.size}/${file.size} bytes`);
    }

    state.sourceKey = key;
    $('#uploadPct').textContent = '100%';
    $('#uploadBar').style.width = '100%';
    $('#uploadStatus').textContent = 'อัปโหลดเสร็จแล้ว · พร้อมสร้างงานพากย์';
    await loadStorage();
    return key;
  };
}
