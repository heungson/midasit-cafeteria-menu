#!/usr/bin/env node
'use strict';
// 로컬 종단 간 확인: 가짜 그룹웨어(로그인 → 목록 → 래퍼 → 본문 프레임 → 에디터 이미지)에 메뉴 이미지를 올리고
// 앱과 같은 MenuService(실제 인식 엔진, 캐시, 오늘 선택)로 끝까지 돌린다. 실제 계정은 쓰지 않는다.
//
//   node scripts/e2e-local.js [--config local/acceptance.json] [--engine claude|native]
// 설정이 없으면 합성 메뉴표와 2030-03-05를 쓴다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startFakeGw } = require('../test/helpers/fake-gw');
const { MenuService } = require('../src/main/menu/service');
const { WeekCache } = require('../src/main/menu/cache');
const { validateProfile } = require('../src/main/profile');
const { findClaude } = require('../src/main/ocr/claude');
const W = require('../src/main/menu/week');

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const root = path.join(__dirname, '..');
const cfgPath = path.resolve(root, arg('config', 'local/acceptance.json'));
const cfg = fs.existsSync(cfgPath)
  ? JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  : { png: path.join(root, 'fixtures', 'synthetic-week.png'), title: '(3/4~ 3/8) 주간 식단표', today: '2030-03-05', checks: [] };
const engine = arg('engine', 'claude');

(async () => {
  const range = W.parseTitleRange(cfg.title, cfg.today);
  const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
  const title = `(${md(range.start)}~ ${md(range.end)}) 주간 식단표`;
  const gw = await startFakeGw({ image: fs.readFileSync(cfg.png), posts: [{ no: '41', title: `(${md(W.addDays(range.start, -7))}~ ${md(W.addDays(range.end, -7))}) 주간 식단표` }, { no: '42', title }] });
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cafeteria-e2e-'));
  const clock = () => new Date(`${cfg.today}T11:50:00+09:00`);
  const svc = new MenuService({
    getProfile: () => validateProfile(gw.profile),
    credentials: { get: () => ({ username: 'kim', password: 'pw' }) },
    cache: new WeekCache(cacheDir),
    settings: () => ({ claudeEnabled: engine === 'claude', claudeModel: cfg.model || 'sonnet', crossCheck: true, refreshMinutes: 30 }),
    claudePath: () => findClaude(),
    clock,
    onChange: (v) => v.progress && console.log(`  … ${v.progress}`),
  });
  const t = Date.now();
  await svc.refresh({ force: true });
  const v = svc.compose();
  console.log(`\n상태: ${v.status} ${v.message} (${((Date.now() - t) / 1000).toFixed(1)}초, 엔진 ${v.source && v.source.engine})`);
  console.log(`그룹웨어 요청: ${gw.state.log.join(' → ')}`);
  let fail = v.status === 'ok' ? 0 : 1;
  if (v.todayDay) {
    console.log(`\n오늘 ${v.today}(${v.weekday})`);
    for (const k of ['breakfast', 'lunch', 'health', 'dinner']) {
      const m = v.todayDay.meals[k];
      console.log(`  ${k}: ${m.status === 'served' ? m.sections.map((s) => s.items.map((i) => i.name).join(', ')).join(' | ') : m.status}`);
    }
  }
  for (const c of cfg.checks || []) {
    const day = v.week && v.week.days.find((d) => d.date === c.date);
    const text = day ? day.meals[c.meal].sections.flatMap((s) => s.items.map((i) => i.name)).join('/') : '';
    const good = day && (!c.status || day.meals[c.meal].status === c.status) && (c.contains || []).every((w) => text.replace(/\s/g, '').includes(w.replace(/\s/g, '')));
    console.log(`${good ? '✔' : '✘'} ${c.date} ${c.meal}`);
    if (!good) fail++;
  }
  // 두 번째 조회는 같은 이미지 해시이므로 다시 인식하지 않아야 한다
  const t2 = Date.now();
  await svc.refresh({ force: true });
  const quick = Date.now() - t2 < 3000;
  console.log(`${quick ? '✔' : '✘'} 같은 이미지 재조회 시 재인식 없음 (${Date.now() - t2}ms)`);
  if (!quick) fail++;
  await gw.close();
  fs.rmSync(cacheDir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
