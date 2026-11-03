'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { decodePng, detectGrid, sliceWeek, GridError } = require('../src/main/ocr/grid');

const synthetic = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'synthetic-week.png'));

test('합성 메뉴표에서 구분 열 + 5일, 머리글 + 4개 식사 행을 찾는다', () => {
  const g = detectGrid(decodePng(synthetic));
  assert.equal(g.columns.length, 6);
  assert.equal(g.bands.length, 4);
  // 열 폭이 거의 같아야 한다
  const widths = g.columns.slice(1).map((c) => c.x1 - c.x0);
  assert.ok(Math.max(...widths) - Math.min(...widths) < 6, `열 폭 ${widths}`);
  // 점심(1)·저녁(3) 행은 하위 칸으로 나뉘고, 금요일 저녁(미제공 병합 칸)은 나뉘지 않는다
  assert.equal(g.splits[0][1].length, 1);
  assert.equal(g.splits[0][3].length, 1);
  assert.equal(g.splits[4][3].length, 0);
  assert.equal(g.splits[0][0].length, 0);
});

test('셀 이미지 분할 결과는 PNG이며 표 위/아래 안내 영역을 포함한다', () => {
  const s = sliceWeek(synthetic);
  assert.equal(s.days.length, 5);
  for (const d of s.days) {
    assert.equal(d.bands.length, 4);
    for (const b of [d.header, ...d.bands]) assert.equal(b.readUInt32BE(0), 0x89504e47);
  }
  assert.ok(s.top && s.bottom);
  assert.equal(s.labels.length, 4);
});

test('격자선이 흔들려도(몇 픽셀 어긋남) 하나의 선으로 묶는다', () => {
  const W = 600, H = 400;
  const png = new PNG({ width: W, height: H });
  png.data.fill(255);
  const blue = (x, y) => {
    const i = (y * W + x) * 4;
    png.data[i] = 60; png.data[i + 1] = 110; png.data[i + 2] = 200; png.data[i + 3] = 255;
  };
  const xs = [20, 120, 210, 300, 390, 480, 580];
  const ys = [20, 80, 160, 240, 320, 380];
  for (const y of ys) for (let x = 20; x <= 580; x++) blue(x, y);
  xs.forEach((x, i) => {
    for (let y = 20; y <= 380; y++) blue(x + (i === 2 && y > 200 ? 3 : 0), y); // 한 세로선은 중간에서 3px 어긋남
  });
  const g = detectGrid(png);
  assert.equal(g.columns.length, 6);
  assert.equal(g.bands.length, 4);
});

test('격자가 없는 이미지는 GridError', () => {
  const png = new PNG({ width: 200, height: 200 });
  png.data.fill(255);
  assert.throws(() => detectGrid(png), GridError);
});
