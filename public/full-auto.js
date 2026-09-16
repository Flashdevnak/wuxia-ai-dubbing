(() => {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

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

  function isUploadMode() {
    return !$('#fileInputWrap')?.classList.contains('hidden');
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
      $('#message').textContent = 'คัดลอกลิงก์แล้ว ดาวน์โหลด MP4 แล้วกลับมากด “เลือก MP4 จากเครื่อง” วิธีนี้เสถียรที่สุด';
    } catch {
      $('#videoUrl')?.select();
      $('#message').textContent = 'เปิดหน้าดาวน์โหลดแล้ว หากไม่คัดลอกอัตโนมัติให้คัดลอกลิงก์จากช่องด้านบน';
    }
    window.open('https://dlbunny.com/th/youtube', '_blank', 'noopener,noreferrer');
  }

  function chooseDownloadedFile() {
    $('#uploadCard')?.click();
    window.setTimeout(() => $('#fileInput')?.click(), 40);
  }

  function updatePrimaryAction() {
    const start = $('#startBtn');
    if (!start) return;
    const main = start.querySelector('b');
    const sub = start.querySelector('small');
    if (isUploadMode()) {
      if (main) main.textContent = '⚔ เริ่มพากย์จากไฟล์';
      if (sub) sub.textContent = 'โหมดแนะนำ • ระบบถอดเสียงด้วย Whisper เอง ไม่ต้องพึ่ง YouTube';
      start.classList.add('recommended-action');
      start.classList.remove('best-effort-action');
    } else {
      if (main) main.textContent = '⚔ ลองพากย์จากลิงก์ YouTube';
      if (sub) sub.textContent = 'โหมดทดลอง • YouTube อาจบล็อกเซิร์ฟเวอร์ได้ แม้ลิงก์เปิดดูปกติ';
      start.classList.remove('recommended-action');
      start.classList.add('best-effort-action');
    }
  }

  function updateHybridHint() {
    const box = $('#fullAutoHybrid');
    if (!box) return;
    const hasUrl = validYoutube(youtubeUrl());
    if (isUploadMode()) {
      box.innerHTML = '<b>✓ วิธีแนะนำ: อัปโหลดไฟล์</b><span>ใช้ได้จริงและเสถียรกว่า ระบบจะถอดเสียง/จับเวลาด้วย Whisper เอง หากมีลิงก์ YouTube อยู่จะใช้เป็นข้อมูลเสริมเท่านั้น</span>';
      box.classList.add('ready');
    } else if (hasUrl) {
      box.innerHTML = '<b>⚠ ลิงก์ YouTube เป็นโหมดทดลอง</b><span>ระบบจะลองดึงซับ/วิดีโอจากเซิร์ฟเวอร์ แต่ YouTube อาจบล็อก IP ของ Cloudflare หรือ GitHub Actions ได้ หากขึ้นล้มเหลวให้ใช้ MP4 แทน ไม่ต้องลองซ่อมช่วง</span>';
      box.classList.remove('ready');
    } else {
      box.innerHTML = '<b>เลือกวิธีนำวิดีโอเข้า</b><span>แนะนำ “อัปโหลดไฟล์” สำหรับงานจริง ส่วนลิงก์ YouTube ใช้แบบ best-effort และอาจใช้งานไม่ได้เป็นบางช่วง</span>';
      box.classList.remove('ready');
    }
    updatePrimaryAction();
  }

  function installReliabilityBoard() {
    const panel = $('.create-panel');
    const sourceBox = $('.source-box');
    if (!panel || !sourceBox || $('#sourceReliability')) return;
    const board = document.createElement('section');
    board.id = 'sourceReliability';
    board.className = 'source-reliability';
    board.innerHTML = `
      <div class="source-reliability-title"><b>เลือกทางที่ใช้จริง</b><span>ระบบมี 2 ทาง แต่ความเสถียรไม่เท่ากัน</span></div>
      <div class="source-reliability-grid">
        <button type="button" class="source-method stable" data-source-method="upload">
          <em>แนะนำ • ใช้งานจริง</em><b>อัปโหลด MP4 / วิดีโอจากเครื่อง</b><span>เสถียรที่สุด • Whisper ถอดเสียงเอง • ไม่ต้องมีซับ YouTube</span>
        </button>
        <button type="button" class="source-method experimental" data-source-method="link">
          <em>ทดลอง • ไม่การันตี</em><b>วางลิงก์ YouTube โดยตรง</b><span>YouTube อาจบล็อกเซิร์ฟเวอร์ แม้วิดีโอจะเปิดดูได้ตามปกติ</span>
        </button>
      </div>`;
    panel.insertBefore(board, sourceBox);
    board.querySelector('[data-source-method="upload"]')?.addEventListener('click', () => $('#uploadCard')?.click());
    board.querySelector('[data-source-method="link"]')?.addEventListener('click', () => $('#linkCard')?.click());
  }

  function simplifySourceCards() {
    const grid = $('.source-grid');
    const upload = $('#uploadCard');
    const link = $('#linkCard');
    if (grid && upload && link && grid.firstElementChild !== upload) grid.insertBefore(upload, link);
    if (upload) {
      upload.classList.add('recommended-source');
      const b = upload.querySelector('b');
      const small = upload.querySelector('small');
      if (b) b.textContent = 'อัปโหลดไฟล์ — แนะนำ';
      if (small) small.textContent = 'เสถียร ใช้งานจริง ระบบถอดเสียงเอง';
    }
    if (link) {
      link.classList.add('best-effort-source');
      const b = link.querySelector('b');
      const small = link.querySelector('small');
      if (b) b.textContent = 'YouTube โดยตรง — ทดลอง';
      if (small) small.textContent = 'อาจถูก YouTube บล็อกฝั่งเซิร์ฟเวอร์';
    }
    const analyze = $('#analyzeLinkBtn');
    if (analyze) analyze.textContent = 'ลองดึงซับ (ทดลอง)';
  }

  function installAdvancedHarToggle() {
    const har = $('#harImport');
    if (!har || $('#harAdvancedToggle')) return;
    har.classList.add('advanced-hidden');
    const copy = har.querySelector('.har-copy');
    if (copy) copy.innerHTML = '<b>HAR / ซับจาก Browser (ขั้นสูง)</b><small>ไม่จำเป็นสำหรับโหมดอัปโหลดไฟล์ ใช้เฉพาะเมื่อต้องการดึง timestamp/ซับจาก YouTube โดยตรง</small>';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'harAdvancedToggle';
    btn.className = 'advanced-toggle';
    btn.textContent = 'ตัวเลือกขั้นสูง: HAR / ซับ YouTube';
    har.parentElement?.insertBefore(btn, har);
    btn.addEventListener('click', () => {
      const hidden = har.classList.toggle('advanced-hidden');
      btn.textContent = hidden ? 'ตัวเลือกขั้นสูง: HAR / ซับ YouTube' : 'ซ่อนตัวเลือกขั้นสูง';
    });
  }

  function installDownloaderHelper() {
    const sourceBox = $('.source-box');
    if (!sourceBox || $('#fullAutoDownloader')) return;
    const wrap = document.createElement('div');
    wrap.id = 'fullAutoDownloader';
    wrap.className = 'full-auto-helper';
    wrap.innerHTML = `
      <div class="full-auto-helper-copy">
        <b>ถ้า YouTube ดึงตรงไม่ได้</b>
        <span>ไม่ใช่วิดีโอเสีย และไม่ต้องกดซ่อมช่วง ให้ดาวน์โหลด MP4 แล้วอัปโหลด ระบบจะถอดเสียงและพากย์ต่อเอง</span>
      </div>
      <div class="full-auto-helper-actions">
        <button type="button" class="btn ghost" id="openDlbunnyBtn">คัดลอกลิงก์ + เปิดหน้าดาวน์โหลด</button>
        <button type="button" class="btn ghost recommended-helper" id="chooseDownloadedBtn">เลือก MP4 จากเครื่อง</button>
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

  function decorateJobs() {
    $$('.job-card').forEach(card => {
      const meta = String(card.querySelector('.job-meta')?.textContent || '');
      const error = card.querySelector('.job-error');
      const errorText = String(error?.textContent || '');
      const isTranscript = /คำบรรยาย YouTube/i.test(meta);
      const youtubeBlocked = /YouTube.*(?:ปฏิเสธ|บล็อก|เข้าไม่ได้|ดึงคำบรรยาย)|ยังดึงคำบรรยายจาก YouTube ไม่ได้/i.test(errorText);

      if (isTranscript) card.classList.add('transcript-job');
      if (!youtubeBlocked || card.dataset.youtubeFallbackDecorated === '1') return;
      card.dataset.youtubeFallbackDecorated = '1';
      if (error) {
        error.innerHTML = '<b>YouTube บล็อกเซิร์ฟเวอร์ของระบบ</b><span>ลิงก์ไม่ได้เสีย วิธีที่ใช้จริงคือดาวน์โหลด MP4 แล้วอัปโหลด ระบบจะใช้ Whisper ถอดเสียงเอง</span>';
        error.classList.add('youtube-blocked-error');
      }
      const stage = card.querySelector('.job-stage');
      if (stage) stage.innerHTML = '<span></span>YouTube โดยตรงใช้งานไม่ได้ในรอบนี้';
      const retry = card.querySelector('[data-job-action="retry"]');
      if (retry) retry.textContent = '↻ ลอง YouTube อีกครั้ง';
      const actions = card.querySelector('.job-actions');
      if (actions && !actions.querySelector('[data-use-upload]')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mini-btn upload-fallback-btn';
        btn.dataset.useUpload = '1';
        btn.textContent = '✓ ใช้วิธีแนะนำ: เลือก MP4';
        actions.insertBefore(btn, actions.firstChild);
      }
    });
  }

  function installJobGuidance() {
    const observer = new MutationObserver(() => setTimeout(decorateJobs, 0));
    observer.observe(document.body, { childList: true, subtree: true });
    document.body.addEventListener('click', event => {
      const btn = event.target.closest('[data-use-upload]');
      if (!btn) return;
      event.preventDefault();
      $('#uploadCard')?.click();
      document.querySelector('.create-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => $('#fileInput')?.click(), 250);
    });
    decorateJobs();
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
      if (text) text.textContent = select.value === 'auto-cast'
        ? 'ระบบสลับโปรไฟล์เสียงไทยตามช่วงบทสนทนา และรักษาโทนในช่วงเดียวกันอัตโนมัติ'
        : 'ใช้โปรไฟล์เสียงที่เลือกกับบทพูดทั้งหมด พร้อมปรับความเร็วและระดับเสียงให้เหมาะกับช่วงวัย';
    });

    const optionGrid = $('.option-grid');
    if (optionGrid && !$('#voiceProfileHint')) {
      const hint = document.createElement('div');
      hint.id = 'voiceProfileHint';
      hint.className = 'voice-profile-hint';
      hint.textContent = 'ระบบสลับโปรไฟล์เสียงไทยตามช่วงบทสนทนา และรักษาโทนในช่วงเดียวกันอัตโนมัติ';
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

  function replaceLegacyStorageCopy() {
    document.querySelectorAll('.hero-tags span').forEach(node => {
      if (/Google Drive/i.test(node.textContent || '')) node.textContent = '☁ พื้นที่ชั่วคราวอัตโนมัติ';
    });
    const storagePanelText = $('.storage-panel p');
    if (storagePanelText) storagePanelText.innerHTML = '<b id="ringText">0.00 GB</b> พื้นที่ชั่วคราวของงานพากย์';
    const cleanupLabel = $('#autoCleanup')?.closest('label')?.querySelector('b');
    if (cleanupLabel) cleanupLabel.textContent = 'ลบไฟล์ทำงานชั่วคราวอัตโนมัติ';
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
    replaceLegacyStorageCopy();
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
    simplifySourceCards();
    installReliabilityBoard();
    installAdvancedHarToggle();
    installDownloaderHelper();
    installVoiceLibrary();
    installTemporaryStorageCopy();
    installFullAutoDefaults();
    installJobGuidance();
    if (!validYoutube(youtubeUrl())) $('#uploadCard')?.click();
    updatePrimaryAction();
    updateHybridHint();
    document.documentElement.dataset.fullAutoDubbing = 'v2';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();