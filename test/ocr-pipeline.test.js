'use strict';
// 인식 파이프라인(격자 분할 → Claude → 기본 OCR 대체 → 날짜 검증). Claude와 기본 OCR은 가짜로 대체한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { recognizeWeek } = require('../src/main/ocr');
const { WEEK } = require('../fixtures/synthetic-menu');

const png = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'synthetic-week.png'));
const images = [{ buf: png, type: 'image/png' }];
const range = { start: '2030-03-04', end: '2030-03-08', weekStart: '2030-03-04' };
const KEYS = ['breakfast', 'lunch', 'health', 'dinner'];

// 합성 데이터에서 Claude가 돌려줄 법한 응답을 만든다(헤더 이미지 순서로 날짜를 맞춤)
function fakeClaude({ failDays = [], dateOverride = {} } = {}) {
  const seen = new Map(); // 머리글 이미지 → 날짜 열 번호(처음 요청된 순서 = 열 순서)
  const calls = [];
  return {
    calls,
    readMeta: async ({ labels }) => {
      calls.push({ kind: 'meta', images: labels.length });
      return {
        data: {
          rowLabels: ['아침', '점심', '건강존', '저녁'],
          floorSchedules: [...WEEK.floors.lunch.map((f) => ({ meal: '점심', ...f })), ...WEEK.floors.dinner.map((f) => ({ meal: '저녁', ...f }))],
          servingTimes: [['아침', 'breakfast'], ['점심', 'lunch'], ['저녁', 'dinner']].map(([meal, k]) => ({ meal, ...WEEK.serving[k] })),
        },
      };
    },
    readDay: async ({ header, bands, bandLabels }) => {
      const key = header.toString('base64');
      if (!seen.has(key)) seen.set(key, seen.size);
      const i = seen.get(key);
      calls.push({ kind: 'day', i, header: header.length, bands: bands.length, bandLabels });
      if (failDays.includes(i)) throw Object.assign(new Error('fake fail'), { code: 'cli_error' });
      const d = WEEK.days[i];
      return {
        data: {
          weekdayText: WEEK.headers[i][0],
          dateText: dateOverride[i] ?? WEEK.headers[i][1],
          cells: KEYS.map((k, bi) => ({
            index: bi + 1,
            notServed: !d[k],
            sections: (d[k] || []).map(([title, items]) => ({ title, items: items.map(([tag, name]) => ({ name, tag })) })),
          })),
        },
      };
    },
  };
}

// 셀 이미지 수만큼 빈 OCR 결과(또는 고정 글자)를 돌려주는 가짜 기본 OCR
const fakeNative = (text = '') => async (bufs) => bufs.map(() => ({ width: 300, height: 300, lines: text ? [{ text, x: 10, y: 10, w: 100, h: 20 }] : [] }));

test('Claude 경로: 날짜 열마다 머리글 1장 + 식사 칸 4장을 보내고 날짜를 검증', async () => {
  const cl = fakeClaude();
  const week = await recognizeWeek(images, range, { claudePath: '/fake/claude', claude: cl, nativeOcr: fakeNative() });
  const dayCalls = cl.calls.filter((c) => c.kind === 'day');
  assert.equal(dayCalls.length, 5);
  for (const c of dayCalls) {
    assert.equal(c.bands, 4);
    assert.deepEqual(c.bandLabels, ['아침', '점심', '건강존', '저녁']);
  }
  assert.deepEqual(week.days.map((d) => [d.date, d.dateCheck, d.engine]), [
    ['2030-03-04', 'verified', 'claude'],
    ['2030-03-05', 'verified', 'claude'],
    ['2030-03-06', 'verified', 'claude'],
    ['2030-03-07', 'verified', 'claude'],
    ['2030-03-08', 'verified', 'claude'],
  ]);
  assert.equal(week.days[4].meals.dinner.status, 'not_served');
  assert.deepEqual(week.servingTimes.lunch, { start: '11:30', end: '13:00', lastServe: '12:50' });
  assert.deepEqual(week.floorSchedules.lunch, WEEK.floors.lunch);
});

test('Claude가 특정 날짜만 실패하면 그 날짜만 기본 OCR로 대체', async () => {
  const cl = fakeClaude({ failDays: [2] });
  const week = await recognizeWeek(images, range, { claudePath: '/fake/claude', claude: cl, nativeOcr: fakeNative('3.6') });
  assert.deepEqual(week.days.map((d) => d.engine), ['claude', 'claude', 'vision', 'claude', 'claude'].map((e) => (e === 'vision' ? require('../src/main/ocr/native').engineName() : e)));
  assert.equal(week.days[2].date, '2030-03-06');
});

test('머리글 날짜가 게시 기간과 다르면 그 열은 날짜 없음(mismatch)으로 제외', async () => {
  const cl = fakeClaude({ dateOverride: { 1: '3.12' } });
  const week = await recognizeWeek(images, range, { claudePath: '/fake/claude', claude: cl, nativeOcr: fakeNative() });
  assert.equal(week.days[1].date, null);
  assert.equal(week.days[1].dateCheck, 'mismatch');
  assert.ok(week.warnings.some((w) => w.includes('맞지 않아')));
});

test('Claude와 기본 OCR이 모두 실패하면 RecognitionError', async () => {
  const cl = fakeClaude({ failDays: [0, 1, 2, 3, 4] });
  await assert.rejects(
    recognizeWeek(images, range, { claudePath: '/fake/claude', claude: cl, nativeOcr: async () => { throw new Error('ocr down'); } }),
    (e) => e.code === 'recognition_failed' && e.details.some((d) => d.includes('ocr down')),
  );
});

test('대조 일치율이 낮으면 경고', async () => {
  const cl = fakeClaude();
  const week = await recognizeWeek(images, range, { claudePath: '/fake/claude', claude: cl, nativeOcr: fakeNative('전혀 다른 글자'), crossCheck: true });
  assert.ok(week.days.every((d) => d.agreement === 0));
  assert.ok(week.warnings.some((w) => w.includes('일치율')));
});

test('격자가 없는 이미지는 recognition_failed', async () => {
  const blank = require('pngjs').PNG.sync.write(Object.assign(new (require('pngjs').PNG)({ width: 50, height: 50 }), {}));
  await assert.rejects(recognizeWeek([{ buf: blank, type: 'image/png' }], range, { useClaude: false, nativeOcr: fakeNative() }), { code: 'recognition_failed' });
});
