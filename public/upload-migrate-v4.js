(() => {
  'use strict';

  const PREFIX_MAP = [
    ['wuxia-upload-v2:', 'wuxia-upload-v4:'],
    ['wuxia-audio-upload-v1:', 'wuxia-audio-upload-v4:'],
  ];

  function migratePrefix(from, to) {
    const copies = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(from)) continue;
      const suffix = key.slice(from.length);
      const target = to + suffix;
      if (localStorage.getItem(target)) continue;
      const value = localStorage.getItem(key);
      if (!value) continue;
      try {
        const parsed = JSON.parse(value);
        if (!parsed?.key || !parsed?.uploadId || !parsed?.partSize) continue;
        copies.push([target, value]);
      } catch {}
    }
    for (const [target, value] of copies) {
      try { localStorage.setItem(target, value); } catch {}
    }
    return copies.length;
  }

  let migrated = 0;
  try {
    for (const [from, to] of PREFIX_MAP) migrated += migratePrefix(from, to);
  } catch {}

  if (migrated > 0) {
    try {
      sessionStorage.setItem('wuxia-upload-v4-migrated', String(migrated));
    } catch {}
  }

  document.documentElement.dataset.uploadMigration = 'v2-v3-to-v4';
})();
