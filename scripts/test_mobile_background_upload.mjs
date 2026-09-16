import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const listeners = new Map();
const statusVideo = { textContent: 'กำลังอัปโหลด 10%', className: '' };
const statusAudio = { textContent: 'กำลังอัปโหลดเสียง 10%', className: '' };

class FakeUploadTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  emit(name, event = {}) { this.listeners.get(name)?.(event); }
}

class FakeXHR {
  constructor() {
    this.upload = new FakeUploadTarget();
    this.listeners = new Map();
    this.sent = false;
    this.aborted = false;
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  send(body) {
    this.body = body;
    this.sent = true;
  }
  abort() {
    this.aborted = true;
    this.listeners.get('loadend')?.();
  }
  addEventListener(name, fn) {
    this.listeners.set(name, fn);
  }
}

globalThis.XMLHttpRequest = FakeXHR;
globalThis.document = {
  hidden: true,
  documentElement: { dataset: {} },
  querySelector(selector) {
    if (selector === '#uploadStatus') return statusVideo;
    if (selector === '#pairAudioStatus') return statusAudio;
    return null;
  },
  addEventListener(name, fn) { listeners.set(`document:${name}`, fn); },
};
globalThis.window = {
  addEventListener(name, fn) { listeners.set(`window:${name}`, fn); },
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { storage: { persist: async () => true } },
});

await import('../public/mobile-upload-recovery.js');

const xhr = new XMLHttpRequest();
xhr.open('POST', '/api/uploads/chunk');
xhr.send(new Uint8Array([1, 2, 3]));

assert.equal(xhr.sent, true, 'hidden tab must not intentionally delay multipart upload');
assert.equal(document.documentElement.dataset.mobileBackgroundUpload, 'best-effort-v3');
assert.equal(document.documentElement.dataset.mobileUploadRecovery, 'foreground-watchdog-v3');

xhr.upload.emit('progress', { loaded: 3, total: 3, lengthComputable: true });
assert.match(statusVideo.textContent, /อัปโหลดเบื้องหลัง/);
assert.match(statusAudio.textContent, /อัปโหลดเบื้องหลัง/);

assert.ok(listeners.has('document:visibilitychange'));
assert.ok(listeners.has('window:pageshow'));
assert.ok(listeners.has('window:focus'));
assert.ok(listeners.has('window:online'));

const recoverySource = readFileSync(new URL('../public/mobile-upload-recovery.js', import.meta.url), 'utf8');
const uploadSource = readFileSync(new URL('../public/upload-fast.js', import.meta.url), 'utf8');

assert.match(recoverySource, /STALE_FOREGROUND_MS = 6500/);
assert.match(recoverySource, /MAX_PROBES = 8/);
assert.match(recoverySource, /เชื่อมต่อใหม่เฉพาะส่วนที่ค้างทันที/);
assert.match(uploadSource, /FOREGROUND_STALL_MS = 8000/);
assert.match(uploadSource, /HARD_XHR_TIMEOUT_MS = 120000/);
assert.match(uploadSource, /foreground-stall-watchdog-v3/);
assert.doesNotMatch(uploadSource, /xhr\.timeout = 300000/);

console.log('MOBILE_BACKGROUND_UPLOAD_V3_PASS');
