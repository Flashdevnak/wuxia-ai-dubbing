(() => {
  const $ = s => document.querySelector(s);

  const VOICES = [
    ['auto-cast', 'อัตโนมัติหลายตัวละคร'],
    ['child-boy', 'เด็กผู้ชาย'],
    ['child-girl', 'เด็กผู้หญิง'],
    ['teen-boy', 'วัยรุ่นผู้ชาย'],
    ['teen-girl', 'วัยรุ่นผู้หญิง'],
    ['adult-male', 'ผู้ชายผู้ใหญ่'],
    ['adult-female', 'ผู้หญิงผู้ใหญ่'],
    ['mature-male', 'ชายวัยกลางคน'],
    ['mature-female', 'หญิงวัยกลางคน'],
    ['elder-male', 'ชายสูงวัย'],
    ['elder-female', 'หญิงสูงวัย'],
    ['narrator', 'ผู้บรรยายโทนสุขุม'],
    ['male', 'ผู้ชายทั่วไป'],
    ['female', 'ผู้หญิงทั่วไป'],
  ];

  function youtubeUrl() {
    return String($('#videoUrl')?.value || '').trim();
  }

  function validYoutube(value) {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && (u.hostname === 'youtu.be' || u.hostname.endsWith('youtube.com'));
    } catch {
      return false;
    }
  }

  async function copyAndOpenDownloader() {
    const value = youtubeUrl();
    if (!validYoutube(value)) {
      $('#message').textContent = 'กรุณาวางลิงก์ YouTube ก่อน';
      $('#videoUrl')?.focus();
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      $('#message').textContent = 'คัดลอกลิงก์แล้ว เปิด DLBunny เพื่อดาวน์โหลด MP4 จากนั้นกลับมาเลือกไฟล์';
    } catch {
      $('#videoUrl')?.select();
      $('#message').textContent = 'เปิด DLBunny แล้ว หากระบบไม่คัดลอกอัตโนมัติให้คัดลอกลิงก์จากช่องด้านบน';
    }
    window.open('https://dlbunny.com/th/youtube', '_blank', 'noopener,noreferrer');
  }

  function chooseDownloadedFile() {
    $('#uploadCard')?.click();
    window.setTimeout(() => $('#fileInput')?.click(), 40);
  }

  function updateHybridHint() {
    const box = $('#fullAutoHybrid');
    if (!box) return;
    const hasUrl = validYoutube(youtubeUrl());
    const uploadVisible = !$('#fileInputWrap')?.classList.contains('hidden');
    if (hasUrl && uploadVisible) {
      box.innerHTML = '<b>โหมดผสมอัตโนมัติพร้อม</b><span>ระบบจะลองใช้ CC/Timestamp จาก YouTube ก่อน และใช้ไฟล์จากเครื่องเป็นวิดีโอต้นฉบับ หาก YouTube อ่านไม่ได้จะใช้ Whisper จับเวลาแทนเอง</span>';
      box.classList.add('ready');
    } else if (hasUrl) {
      box.innerHTML = '<b>พบลิงก์ YouTube</b><span>ถ้าดึงวิดีโอโดยตรงถูกบล็อก ให้กดเปิด DLBunny ดาวน์โหลด MP4 แล้วกลับมาเลือกไฟล์ ระบบจะทำต่ออัตโนมัติ</span>';
      box.classList.remove('ready');
    } else {
      box.innerHTML = '<b>พร้อมรับวิดีโอ</b><span>วางลิงก์ YouTube เพื่อใช้ CC/Timestamp หรือเลือกไฟล์จากเครื่องเพื่อให้ระบบถอดเสียงและจับเวลาเอง</span>';
      box.classList.remove('ready');
    }
  }

  function installDownloaderHelper() {
    const sourceBox = $('.source-box');
    if (!sourceBox || $('#fullAutoDownloader')) return;
    const wrap = document.createElement('div');
    wrap.id = 'fullAutoDownloader';
    wrap.className = 'full-auto-helper';
    wrap.innerHTML = `
      <div class="full-auto-helper-copy">
        <b>นำวิดีโอเข้าระบบ</b>
        <span>ลิงก์ YouTube ใช้ช่วยหา CC/Timestamp ส่วนไฟล์ MP4 ใช้เป็นต้นฉบับที่เสถียรที่สุด</span>
      </div>
      <div class="full-auto-helper-actions">
        <button type="button" class="btn ghost" id="openDlbunnyBtn">คัดลอกลิงก์ + เปิด DLBunny</button>
        <button type="button" class="btn ghost" id="chooseDownloadedBtn">เลือก MP4 จากเครื่อง</button>
      </div>
      <div id="fullAutoHybrid" class="full-auto-hybrid"></div>`;
    sourceBox.appendChild(wrap);
    $('#openDlbunnyBtn')?.addEventListener('click', copyAndOpenDownloader);
    $('#chooseDownloadedBtn')?.addEventListener('click', chooseDownloadedFile);
    $('#videoUrl')?.addEventListener('input', updateHybridHint);
    $('#linkCard')?.addEventListener('click', () => setTimeout(updateHybridHint, 0));
    $('#uploadCard')?.addEventListener('click', () => setTimeout(updateHybridHint, 0));
    updateHybridHint();
  }

  function installVoiceLibrary() {
    const select = $('#voiceMode');
    if (!select) return;
    select.innerHTML = '';
    for (const [value, label] of VOICES) select.add(new Option(label, value));
    select.value = 'auto-cast';

    const speaker = $('#speakerSep');
    if (speaker) speaker.checked = true;
    select.addEventListener('change', () => {
      if (speaker && select.value === 'auto-cast') speaker.checked = true;
      const text = $('#voiceProfileHint');
      if (text) {
        text.textContent = select.value === 'auto-cast'
          ? 'ระบบสลับโปรไฟล์เสียงไทยตามช่วงบทสนทนา และล็อกโทนในช่วงเดียวกันอัตโนมัติ'
          : 'ใช้โปรไฟล์เสียงที่เลือกกับบทพูดทั้งหมด พร้อมปรับความเร็วและระดับเสียงให้เหมาะกับช่วงวัย';
      }
    });

    const optionGrid = $('.option-grid');
    if (optionGrid && !$('#voiceProfileHint')) {
      const hint = document.createElement('div');
      hint.id = 'voiceProfileHint';
      hint.className = 'voice-profile-hint';
      hint.textContent = 'ระบบสลับโปรไฟล์เสียงไทยตามช่วงบทสนทนา และล็อกโทนในช่วงเดียวกันอัตโนมัติ';
      optionGrid.insertAdjacentElement('afterend', hint);
    }

    const voicePage = document.querySelector('[data-page-panel="voices"] .voice-grid');
    if (voicePage) {
      voicePage.innerHTML = VOICES.map(([value, label], i) => `
        <button class="voice-card${i === 0 ? ' active' : ''}" data-full-voice="${value}">
          ${label}<small>${value === 'auto-cast' ? 'เหมาะกับการ์ตูนและหลายตัวละคร' : 'เลือกใช้ทั้งวิดีโอ'}</small>
        </button>`).join('');
      voicePage.querySelectorAll('[data-full-voice]').forEach(btn => btn.addEventListener('click', () => {
        voicePage.querySelectorAll('.voice-card').forEach(x => x.classList.remove('active'));
        btn.classList.add('active');
        select.value = btn.dataset.fullVoice;
        select.dispatchEvent(new Event('change'));
        document.querySelector('[data-page="home"]')?.click();
      }));
    }
  }

  function installTemporaryStorageCopy() {
    const side = $('.side-footer .rank-card');
    if (side) side.innerHTML = '<span>ระบบพร้อมใช้งาน</span><b>ไฟล์ชั่วคราว แยกจากโปรเจกต์อื่น</b><small>ลบอัตโนมัติหลังใช้งาน</small>';
    const storageNav = document.querySelector('[data-page="storage"]');
    if (storageNav) storageNav.innerHTML = '<span>库</span>พื้นที่ชั่วคราว';
    const storagePage = document.querySelector('[data-page-panel="storage"] .page-head');
    if (storagePage) storagePage.innerHTML = '<h1>พื้นที่ชั่วคราว</h1><p>ใช้เฉพาะงานพากย์นี้ ระบบเก็บผลลัพธ์สูงสุดประมาณ 30 นาที และเข้าคิวลบประมาณ 10 นาทีหลังเริ่มดาวน์โหลด</p>';
    const mini = $('.storage-mini span');
    if (mini) mini.textContent = 'ชั่วคราว';

    const panel = $('.create-panel');
    if (panel && !$('#temporaryPolicy')) {
      const policy = document.createElement('div');
      policy.id = 'temporaryPolicy';
      policy.className = 'temporary-policy';
      policy.innerHTML = '<b>Temporary Processing</b><span>ไม่มีคลังวิดีโอถาวร • งานเสร็จเก็บสูงสุด 30 นาที • หลังเริ่มดาวน์โหลดจะเข้าคิวลบใน 10 นาที • งานที่กำลังประมวลผลจะไม่ถูกลบ</span>';
      panel.insertBefore(policy, panel.querySelector('.source-box'));
    }
  }

  function installFullAutoDefaults() {
    const subtitles = $('#subtitles');
    const keepMusic = $('#keepMusic');
    const cleanup = $('#autoCleanup');
    if (subtitles) subtitles.checked = true;
    if (keepMusic) keepMusic.checked = true;
    if (cleanup) cleanup.checked = true;
  }

  function init() {
    installDownloaderHelper();
    installVoiceLibrary();
    installTemporaryStorageCopy();
    installFullAutoDefaults();
    document.documentElement.dataset.fullAutoDubbing = 'v1';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
