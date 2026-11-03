#!/usr/bin/env node
'use strict';
// 합성 메뉴표 PNG, 데모 데이터, 아이콘을 만든다.  실행: npm run fixtures
// (Electron 오프스크린 렌더링을 쓰므로 node가 아니라 electron으로 다시 실행된다)
const path = require('path');
const fs = require('fs');

if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const electron = require('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electron, [__filename], { stdio: 'inherit', env });
  process.exit(r.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
const { WEEK } = require('../fixtures/synthetic-menu');
const root = path.join(__dirname, '..');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function cellHtml(sections) {
  if (!sections) return '<div class="ns">미제공</div>';
  return sections
    .map(([title, items]) => {
      const lines = [];
      if (title) lines.push(`-${esc(title)}-`);
      const tagged = items.filter(([t]) => t);
      const plain = items.filter(([t]) => !t);
      tagged.forEach(([t, n]) => lines.push(`(${t})${esc(n)}`));
      if (plain.length) lines.push(plain.map(([, n]) => esc(n)).join('/'));
      return `<div class="sec">${lines.join('<br>')}</div>`;
    })
    .join('');
}

function menuHtml() {
  const rows = [
    ['아침', 'breakfast'],
    ['점심', 'lunch'],
    ['건강존', 'health'],
    ['저녁', 'dinner'],
  ];
  const head = WEEK.headers.map(([w, d]) => `<th><div>${w}</div><div class="d">${d}</div></th>`).join('');
  const body = rows
    .map(([label, key]) => {
      const cells = WEEK.days
        .map((d) => {
          const secs = d[key];
          if (!secs) return `<td>${cellHtml(null)}</td>`;
          // 첫 섹션 묶음과 나머지를 가로선으로 나눈 2단 칸(실제 메뉴표처럼)
          const [first, rest] = key === 'breakfast' ? [secs, []] : [secs.slice(0, 1), secs.slice(1)];
          return rest.length
            ? `<td class="split"><div class="top">${cellHtml(first)}</div><div class="bot">${cellHtml(rest)}</div></td>`
            : `<td>${cellHtml(first)}</td>`;
        })
        .join('');
      return `<tr><th class="lab">${label}</th>${cells}</tr>`;
    })
    .join('');
  const floorBlock = (name, list) =>
    `<div class="fl"><div class="fh">[${name} - 시간별 층수 안내]</div>${list.map((f) => `<div>${f.time} = ${f.places.join(', ')}</div>`).join('')}</div>`;
  const hm = (t) => {
    const [h, m] = t.split(':').map(Number);
    return m ? `${h}시 ${m}분` : `${h}시`;
  };
  const s = WEEK.serving;
  const serving = `※ 식사시간 = 조식: ${hm(s.breakfast.start)}~${hm(s.breakfast.end)} (${hm(s.breakfast.lastServe)} 배식완료), 중식: ${hm(s.lunch.start)}~${hm(s.lunch.end)} (${hm(s.lunch.lastServe)} 배식완료), 석식: ${hm(s.dinner.start)}~${hm(s.dinner.end)} (${hm(s.dinner.lastServe)} 배식완료)`;
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#fff;font-family:"Apple SD Gothic Neo","Malgun Gothic","Noto Sans CJK KR",sans-serif;color:#333;width:1200px}
    h1{text-align:center;font-size:44px;margin:30px 0 20px}
    .floors{display:flex;gap:80px;padding:0 70px 30px;font-size:26px;line-height:1.6}
    .fh{margin-bottom:4px}
    table{border-collapse:collapse;margin:0 40px;width:1120px;table-layout:fixed;background:#fbfaf1}
    th,td{border:2px solid #4f8fd0;text-align:center;vertical-align:middle;font-size:19px;line-height:1.55;padding:0}
    thead th{background:#fff;font-size:22px;padding:10px 0}
    thead .d{font-size:20px;margin-top:6px}
    th.lab{width:110px;font-size:22px;font-weight:600}
    td .sec{padding:6px 8px}
    td.split{padding:0}
    td.split .top{padding:14px 0;border-bottom:2px solid #4f8fd0}
    td.split .bot{padding:14px 0}
    td>.sec:first-child{padding-top:16px} td>.sec:last-child{padding-bottom:16px}
    .ns{padding:60px 0}
    .foot{padding:24px 40px 40px;font-size:19px;line-height:1.8}
  </style>
  <h1>3월 주간메뉴표</h1>
  <div class="floors">${floorBlock('중식', WEEK.floors.lunch)}${floorBlock('석식', WEEK.floors.dinner)}</div>
  <table><thead><tr><th class="lab">구분</th>${head}</tr></thead><tbody>${body}</tbody></table>
  <div class="foot">※ 이 표는 테스트용 합성 데이터입니다.<br>${serving}</div>`;
}

const TRAY_SVG = (color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <path d="M4 15h24a12 12 0 0 1-24 0z" fill="${color}"/>
  <rect x="11" y="28" width="10" height="2.4" rx="1.2" fill="${color}"/>
  <path d="M10 11c0-2 2-2 2-4s-2-2-2-4M16 11c0-2 2-2 2-4s-2-2-2-4M22 11c0-2 2-2 2-4s-2-2-2-4" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round"/>
</svg>`;
const APP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect x="64" y="64" width="896" height="896" rx="200" fill="#d9622b"/>
  <g transform="translate(192 176) scale(20)">${TRAY_SVG('#fff').replace(/<\/?svg[^>]*>/g, '')}</g>
</svg>`;

// 오프스크린 창 하나를 재사용한다(창을 여러 개 만들면 일부 환경에서 두 번째 로드가 실패)
let shared = null;
function sharedWindow() {
  if (!shared) shared = new BrowserWindow({ show: false, width: 1200, height: 2000, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  return shared;
}

async function capture(html, width, height, file) {
  const w = sharedWindow();
  w.setContentSize(width, height);
  const tmp = path.join(require('os').tmpdir(), `fixture-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(tmp, html);
  await w.loadFile(tmp);
  fs.rmSync(tmp, { force: true });
  const size = await w.webContents.executeJavaScript('[document.documentElement.scrollWidth, document.documentElement.scrollHeight]');
  w.setContentSize(size[0], size[1]);
  await new Promise((r) => setTimeout(r, 400));
  const img = await w.webContents.capturePage();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, img.toPNG());
  console.log('작성:', path.relative(root, file), img.getSize());
}

// SVG를 캔버스로 그려 투명 배경 PNG로 만든다(투명 오프스크린 창은 일부 환경에서 로드 실패)
async function rasterize(svg, px, file) {
  const w = sharedWindow();
  const dataUrl = await w.webContents.executeJavaScript(`new Promise((ok, bad) => {
    const img = new Image();
    img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = ${px};
      c.getContext('2d').drawImage(img, 0, 0, ${px}, ${px}); ok(c.toDataURL('image/png')); };
    img.onerror = () => bad(new Error('svg load failed'));
    img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
  })`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('작성:', path.relative(root, file), px);
}

function demoWeek() {
  const toMeal = (secs) =>
    secs ? { status: 'served', sections: secs.map(([title, items]) => ({ title, items: items.map(([tag, name]) => ({ name, tag })) })) } : { status: 'not_served', sections: [] };
  const wd = ['월', '화', '수', '목', '금'];
  const addDays = (d, n) => new Date(Date.UTC(...d.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0))) + n * 86400000).toISOString().slice(0, 10);
  return {
    schemaVersion: 1,
    weekStart: WEEK.weekStart,
    rangeStart: WEEK.rangeStart,
    rangeEnd: WEEK.rangeEnd,
    metaEngine: 'demo',
    days: WEEK.days.map((d, i) => ({
      date: addDays(WEEK.weekStart, i),
      weekday: wd[i],
      headerText: WEEK.headers[i][1],
      dateCheck: 'verified',
      engine: 'demo',
      agreement: null,
      meals: { breakfast: toMeal(d.breakfast), lunch: toMeal(d.lunch), health: toMeal(d.health), dinner: toMeal(d.dinner) },
    })),
    servingTimes: WEEK.serving,
    floorSchedules: { breakfast: [], lunch: WEEK.floors.lunch, dinner: WEEK.floors.dinner },
    warnings: [],
    details: [],
  };
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  await capture(menuHtml(), 1200, 2000, path.join(root, 'fixtures', 'synthetic-week.png'));
  fs.writeFileSync(path.join(root, 'fixtures', 'demo-week.json'), JSON.stringify(demoWeek(), null, 2) + '\n');
  console.log('작성: fixtures/demo-week.json');
  for (const [name, px, color] of [['trayTemplate.png', 16, '#000'], ['trayTemplate@2x.png', 32, '#000'], ['tray.png', 32, '#d9622b']]) {
    await rasterize(TRAY_SVG(color), px, path.join(root, 'assets', name));
  }
  await rasterize(APP_SVG, 1024, path.join(root, 'assets', 'icon.png'));
  app.quit();
});
