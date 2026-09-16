(() => {
  const DLBUNNY_URL = 'https://dlbunny.com/en/youtube';

  function mount() {
    const panel = document.querySelector('.advanced-source');
    if (!panel || document.getElementById('dlbunnyHelper')) return Boolean(panel);

    const helper = document.createElement('div');
    helper.id = 'dlbunnyHelper';
    helper.className = 'har-import';
    helper.innerHTML = `
      <div class="har-copy">
        <b>ดาวน์โหลดวิดีโอ/เสียงจาก YouTube</b>
        <small>ถ้าไฟล์วิดีโอที่ได้ไม่มีเสียง ให้ดาวน์โหลดทั้งวิดีโอและไฟล์เสียง แล้วกลับมาอัปโหลดสองไฟล์ในหน้านี้</small>
      </div>
      <div class="har-actions">
        <a class="btn ghost har-btn" href="${DLBUNNY_URL}" target="_blank" rel="noopener noreferrer">เปิด DLBunny</a>
        <span class="har-status">เปิดเป็นเว็บภายนอก</span>
      </div>`;

    const linkInput = document.getElementById('linkInputWrap');
    if (linkInput?.parentElement === panel) linkInput.insertAdjacentElement('afterend', helper);
    else panel.appendChild(helper);
    return true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }

  let tries = 0;
  const timer = window.setInterval(() => {
    tries += 1;
    if (mount() || tries >= 20) window.clearInterval(timer);
  }, 150);
})();
