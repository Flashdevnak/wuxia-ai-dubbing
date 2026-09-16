import assert from 'node:assert/strict';
import fs from 'node:fs';

const ui = fs.readFileSync('public/pair-recovery.js', 'utf8');
const worker = fs.readFileSync('src/worker-pairfix.js', 'utf8');
const wrangler = fs.readFileSync('wrangler.jsonc', 'utf8');

assert.match(ui, /recoverPair/);
assert.match(ui, /sourceAudioKey/);
assert.match(ui, /data-job-action=\"retry\"/);
assert.match(ui, /api\/pair\/jobs/);
assert.match(ui, /stopImmediatePropagation/);
assert.match(ui, /api\('\/api\/files'\)/);
assert.match(worker, /attach-audio/);
assert.match(worker, /sourceAudioKey/);
assert.match(worker, /pairRecoveredAt/);
assert.match(worker, /failedJobAudioAttach/);
assert.match(wrangler, /src\/worker-pairfix\.js/);

console.log('SEPARATE_AUDIO_PAIR_RECOVERY_PASS');
