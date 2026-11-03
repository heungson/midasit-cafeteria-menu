#!/usr/bin/env node
'use strict';
// 실제 주간 메뉴 이미지로 인식 결과를 검증한다(로컬 전용).
// 이미지 경로와 기대값은 git에 올리지 않는 local/acceptance.json에서 읽는다.
//
//   node scripts/verify-real.js [--config local/acceptance.json] [--engine claude|native|both] [--out local/result.json]
//
// local/acceptance.json 예:
// { "png": "/절대/경로/menu.png", "title": "(M/D~ M/D) 제목", "today": "YYYY-MM-DD",
//   "checks": [ { "date": "YYYY-MM-DD", "meal": "breakfast", "contains": ["메뉴 이름"] },
//               { "date": "YYYY-MM-DD", "meal": "dinner", "status": "not_served" } ],
//   "servingTimes": { "lunch": { "start": "HH:MM", "end": "HH:MM", "lastServe": "HH:MM" } },
//   "floorSchedules": { "lunch": [ { "time": "HH:MM", "places": ["..."] } ] } }
const fs = require('fs');
const path = require('path');
const { recognizeWeek } = require('../src/main/ocr');
const { findClaude } = require('../src/main/ocr/claude');
const { parseTitleRange } = require('../src/main/menu/week');
const { selectDay } = require('../src/main/menu/select');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc), []),
);
const root = path.join(__dirname, '..');
const cfgPath = path.resolve(root, args.config || 'local/acceptance.json');
if (!fs.existsSync(cfgPath)) {
  console.error(`설정 파일이 없습니다: ${path.relative(root, cfgPath)} (README의 '실제 이미지 검증' 참고)`);
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const engine = args.engine || 'both';

function mealText(meal) {
  return meal.sections.flatMap((s) => s.items.map((i) => i.name)).join(' / ');
}

function check(week, label) {
  let fail = 0;
  const ok = (cond, msg) => {
    console.log(`  ${cond ? '✔' : '✘'} ${msg}`);
    if (!cond) fail++;
  };
  for (const c of cfg.checks || []) {
    const day = week.days.find((d) => d.date === c.date);
    if (!day) {
      ok(false, `${c.date} 날짜 열 없음`);
      continue;
    }
    const meal = day.meals[c.meal];
    if (c.status) ok(meal.status === c.status, `${c.date} ${c.meal} 상태 = ${c.status} (실제 ${meal.status})`);
    for (const want of c.contains || []) {
      ok(mealText(meal).replace(/\s/g, '').includes(want.replace(/\s/g, '')), `${c.date} ${c.meal} 에 '${want}' 포함`);
    }
  }
  for (const [meal, want] of Object.entries(cfg.servingTimes || {})) {
    const got = week.servingTimes[meal];
    ok(got && got.start === want.start && got.end === want.end && (!want.lastServe || got.lastServe === want.lastServe),
      `${meal} 배식 시간 ${want.start}~${want.end}${want.lastServe ? ` (완료 ${want.lastServe})` : ''} → ${got ? `${got.start}~${got.end} (${got.lastServe})` : '없음'}`);
  }
  for (const [meal, want] of Object.entries(cfg.floorSchedules || {})) {
    const got = week.floorSchedules[meal] || [];
    ok(JSON.stringify(got) === JSON.stringify(want), `${meal} 층별 시간 ${want.length}줄 일치 (실제 ${got.length}줄)`);
  }
  // 날짜 안전성: 오늘로 고른 날짜가 정확히 오늘이어야 한다
  if (cfg.today) {
    const sel = selectDay(week, cfg.today);
    ok(sel.status !== 'ok' || sel.day.date === cfg.today, `오늘(${cfg.today}) 선택 → ${sel.status} ${sel.day ? sel.day.date : ''}`);
    const other = selectDay(week, '2000-01-03');
    ok(other.status === 'other_week', '다른 주 날짜에는 이 주 메뉴를 보여주지 않음');
  }
  const dates = week.days.map((d) => `${d.date || '?'}(${d.dateCheck}${d.agreement != null ? `, 대조 ${Math.round(d.agreement * 100)}%` : ''})`).join(', ');
  console.log(`  날짜 열: ${dates}`);
  if (week.warnings.length) console.log(`  경고: ${week.warnings.join(' | ')}`);
  console.log(`  → ${label}: ${fail ? `${fail}개 실패` : '모두 통과'}`);
  return fail;
}

(async () => {
  const buf = fs.readFileSync(cfg.png);
  const range = parseTitleRange(cfg.title, cfg.today);
  if (!range) throw new Error('title에서 기간을 읽지 못했습니다');
  const images = [{ buf, type: 'image/png' }];
  const runs = [];
  if (engine === 'claude' || engine === 'both') runs.push(['claude', { claudePath: findClaude(), claudeModel: args.model || cfg.model, crossCheck: true }]);
  if (engine === 'native' || engine === 'both') runs.push(['native', { useClaude: false }]);
  let failures = 0;
  const results = {};
  for (const [name, opts] of runs) {
    const t = Date.now();
    console.log(`\n[${name}] 인식 시작`);
    try {
      const week = await recognizeWeek(images, range, { ...opts, onProgress: (m) => console.log(`  … ${m}`) });
      console.log(`  (${((Date.now() - t) / 1000).toFixed(1)}초, 날짜별 엔진: ${week.days.map((d) => d.engine).join(',')})`);
      results[name] = week;
      failures += check(week, name);
    } catch (e) {
      console.log(`  ✘ 인식 실패: ${e.message} ${(e.details || []).join(' | ')}`);
      failures++;
    }
  }
  if (args.out) {
    const out = path.resolve(root, args.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    console.log(`\n결과 저장: ${path.relative(root, out)}`);
  }
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
