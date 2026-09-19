import worker from '../src/worker.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function callTranslate(ai, body) {
  const request = new Request('https://unit.test/api/internal/translate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-worker-token': 'unit-token',
    },
    body: JSON.stringify(body),
  });
  const response = await worker.fetch(request, {
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
