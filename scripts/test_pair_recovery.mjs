import assert from 'node:assert/strict';
import fs from 'node:fs';

const ui = fs.readFileSync('public/pair-recovery.js', 'utf8');
const retryV2 = fs.readFileSync('public/pair-retry-v2.js', 'utf8');
const worker = fs.readFileSync('src/worker-pairfix.js', 'utf8');
const stability = fs.existsSync('src/worker-stability.js') ? fs.readFileSync('src/worker-stability.js', 'utf8') : '';
const dispatchGuard = fs.existsSync('src/worker-separate-audio-dispatch.js')
  ? fs.readFileSync('src/worker-separate-audio-dispatch.js', 'utf8')
  : '';
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
assert.match(retryV2, /recoverAndRetry/);
assert.match(retryV2, /attach-audio/);
assert.match(retryV2, /sourceAudioKey/);
assert.match(dispatchGuard, /separateAudioPersistBeforeDispatch/);
assert.match(dispatchGuard, /sourceAudioKey/);

const directPair = /src\/worker-pairfix\.js/.test(wrangler);
const stabilityPair = /src\/worker-stability\.js/.test(wrangler)
  && /import pairWorker from '\.\/worker-pairfix\.js'/.test(stability);
const guardedPair = /src\/worker-separate-audio-dispatch\.js/.test(wrangler)
  && /import stabilityWorker from '\.\/worker-stability\.js'/.test(dispatchGuard)
  && /import pairWorker from '\.\/worker-pairfix\.js'/.test(stability);
assert.ok(directPair || stabilityPair || guardedPair, 'pair recovery worker must be reachable from Wrangler entrypoint');

console.log('SEPARATE_AUDIO_PAIR_RECOVERY_PASS');
