'use strict';
// 실제 운영체제 OCR로 합성 메뉴표를 읽는다(macOS: Vision 도우미 빌드 필요, Windows: 한국어 OCR 언어 팩 필요).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const native = require('../src/main/ocr/native');
const { recognizeWeek } = require('../src/main/ocr');
const { WEEK } = require('../fixtures/synthetic-menu');

const png = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'synthetic-week.png'));
const range = { start: '2030-03-04', end: '2030-03-08', weekStart: '2030-03-04' };
const tool = native.locate();
const skip = !tool ? '기본 OCR 도구 없음(macOS는 npm run build:native 필요)' : false;

test('기본 OCR만으로 합성 주간 메뉴 인식: 날짜·시간·층·메뉴', { skip, timeout: 120000 }, async (t) => {
  let week;
  try {
    week = await recognizeWeek([{ buf: png, type: 'image/png' }], range, { useClaude: false });
  } catch (e) {
    if (/korean_unsupported|한국어 OCR/.test(`${e.message} ${(e.details || []).join(' ')}`)) return t.skip('한국어 OCR 언어 팩 미설치');
    throw e;
  }
  assert.deepEqual(week.days.map((d) => d.date), ['2030-03-04', '2030-03-05', '2030-03-06', '2030-03-07', '2030-03-08']);
  assert.ok(week.days.filter((d) => d.dateCheck === 'verified').length >= 4, week.days.map((d) => d.headerText).join(','));
  assert.deepEqual(week.servingTimes, {
    breakfast: { ...WEEK.serving.breakfast },
    lunch: { ...WEEK.serving.lunch },
    dinner: { ...WEEK.serving.dinner },
  });
  assert.deepEqual(week.floorSchedules.lunch, WEEK.floors.lunch);
  assert.equal(week.days[4].meals.dinner.status, 'not_served');
  // 메뉴 이름 재현율
  const KEYS = ['breakfast', 'lunch', 'health', 'dinner'];
  let total = 0;
  let found = 0;
  const missing = [];
  WEEK.days.forEach((d, i) => {
    for (const k of KEYS) {
      if (!d[k]) continue;
      const got = week.days[i].meals[k].sections.flatMap((s) => s.items.map((it) => it.name.replace(/\s/g, '')));
      for (const [, , name] of d[k].flatMap(([, items]) => items.map(([tag, n]) => [tag, k, n]))) {
        total++;
        if (got.includes(name)) found++;
        else missing.push(`${i}/${k}/${name}`);
      }
    }
  });
  assert.ok(found / total >= 0.9, `재현율 ${found}/${total}, 누락: ${missing.join(', ')}`);
});
