import worker from '../src/worker.js';
import integrityWorker from '../src/worker-translation-integrity.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function callTranslate(ai, body, selectedWorker = worker) {
  const request = new Request('https://unit.test/api/internal/translate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-worker-token': 'unit-token',
    },
    body: JSON.stringify(body),
  });
  const response = await selectedWorker.fetch(request, {
    WORKER_SHARED_TOKEN: 'unit-token',
    AI: ai,
  });
  const payload = await response.json();
  return { response, payload };
}

let calls = 0;
const salvageAI = {
  async run() {
    calls += 1;
    return {
      response:
        '{"translations":["ถ้าใช้พลังของเทวดา"]}\n\n' +
        '{"sourceLanguage":"zh","targetLanguage":"th","texts":["施展天魔真身"],"durationsSeconds":[1.2]}',
    };
  },
};

const salvaged = await callTranslate(salvageAI, {
  texts: ['施展天魔真身'],
  sourceLang: 'zh',
  targetLang: 'th',
  durations: [1.2],
});
assert(salvaged.response.status === 200, 'concatenated JSON response should be salvaged');
assert(
  JSON.stringify(salvaged.payload.translations) === JSON.stringify(['ถ้าใช้พลังของเทวดา']),
  'must keep only the valid translations JSON object',
);
assert(calls === 1, 'valid first JSON object should avoid unnecessary single-line retry');

let mixedCalls = 0;
const mixedAI = {
  async run() {
    mixedCalls += 1;
    if (mixedCalls === 1) {
      return { response: '{"translations":["แต่只能ใช้ในด้านกฎหมายเท่านั้น"]}' };
    }
    return { response: 'ใช้ได้เฉพาะด้านกฎหมายเท่านั้น' };
  },
};

const repaired = await callTranslate(mixedAI, {
  texts: ['但只能用于法律方面'],
  sourceLang: 'zh',
  targetLang: 'th',
  durations: [1.6],
});
assert(repaired.response.status === 200, 'mixed CJK output should be repairable');
assert(
  JSON.stringify(repaired.payload.translations) === JSON.stringify(['ใช้ได้เฉพาะด้านกฎหมายเท่านั้น']),
  'unsafe Thai/CJK mix must be replaced by the single-line repair',
);
assert(mixedCalls === 2, 'mixed output should trigger exactly one single-line repair');

console.log('TRANSLATION_RUNTIME_RESILIENCE_PASS');

let partialCalls = 0;
const partialAI = {
  async run(_model, payload) {
    partialCalls += 1;
    const messages = payload?.messages || [];
    const user = String(messages[messages.length - 1]?.content || '');

    if (partialCalls === 1) {
      return {
        response: JSON.stringify({
          translations: [
            'หนึ่ง','สอง','สาม','สี่','ห้า','หก',
            '七',
            'แปด','เก้า','สิบ','สิบเอ็ด','สิบสอง',
          ],
        }),
      };
    }

    // Keep the seventh subtitle unresolved through all worker strategies.
    if (user.includes('七') || user.includes('Meaning: 七')) {
      return { response: '七' };
    }
    return { response: 'ข้อความไทย' };
  },
};

const partialBody = {
  texts: ['一','二','三','四','五','六','七','八','九','十','十一','十二'],
  sourceLang: 'zh',
  targetLang: 'th',
  durations: new Array(12).fill(1.2),
};

const partial = await callTranslate(partialAI, partialBody);
assert(partial.response.status === 200, 'one unresolved subtitle must not fail the whole batch');
assert(
  JSON.stringify(partial.payload.unresolvedIndexes) === JSON.stringify([6]),
  'must identify only the unresolved subtitle index',
);
assert(partial.payload.translations[0] === 'หนึ่ง', 'must preserve valid batch translation 1');
assert(partial.payload.translations[5] === 'หก', 'must preserve valid batch translation 6');
assert(partial.payload.translations[6] === '七', 'unresolved slot should carry source text for runner repair');
assert(partial.payload.translations[11] === 'สิบสอง', 'must preserve valid batch translation 12');

const guardedPartial = await callTranslate(partialAI, partialBody, integrityWorker);
assert(guardedPartial.response.status === 200, 'integrity wrapper must allow declared unresolved slots');
assert(
  JSON.stringify(guardedPartial.payload.unresolvedIndexes) === JSON.stringify([6]),
  'integrity wrapper must preserve unresolvedIndexes',
);

console.log('TRANSLATION_PARTIAL_REPAIR_PASS');

