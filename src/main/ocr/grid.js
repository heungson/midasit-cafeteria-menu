'use strict';
// 주간 메뉴표 PNG에서 표의 격자선을 찾아 (날짜 열 × 식사 행) 셀로 자른다.
// 격자선은 파란 계열의 얇은 선이고 손으로 그린 듯 몇 픽셀씩 흔들리므로,
// 파란색 마스크 → 긴 연속 구간만 집계 → 근접 좌표 군집화 순서로 찾는다.
const { PNG } = require('pngjs');

const MIN_RUN = 30; // 글자 획과 격자선을 구분하는 최소 연속 길이(px)
const CLUSTER_GAP = 8; // 흔들리는 선을 하나로 묶는 허용 오차(px)

function decodePng(buf) {
  return PNG.sync.read(buf);
}

function isLinePixel(data, i) {
  const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
  return a > 128 && b > 120 && b - r > 60 && b - g > 20;
}

function lineMask(png) {
  const { width: W, height: H, data } = png;
  const mask = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) if (isLinePixel(data, p * 4)) mask[p] = 1;
  return mask;
}

// 각 좌표마다 MIN_RUN 이상인 연속 구간을 표시한 마스크(긴 선만 남김)
function longRuns(mask, W, H, vertical) {
  const out = new Uint8Array(W * H);
  const outer = vertical ? W : H;
  const inner = vertical ? H : W;
  const idx = vertical ? (o, i) => i * W + o : (o, i) => o * W + i;
  for (let o = 0; o < outer; o++) {
    let start = -1;
    for (let i = 0; i <= inner; i++) {
      const on = i < inner && mask[idx(o, i)];
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        if (i - start >= MIN_RUN) for (let k = start; k < i; k++) out[idx(o, k)] = 1;
        start = -1;
      }
    }
  }
  return out;
}

// 근접한 선 좌표들을 하나의 선으로 묶고, 선이 실제로 덮는 구간(coverage)을 계산
function clusterLines(runs, W, H, vertical) {
  const outer = vertical ? W : H;
  const inner = vertical ? H : W;
  const idx = vertical ? (o, i) => i * W + o : (o, i) => o * W + i;
  const counts = new Array(outer).fill(0);
  for (let o = 0; o < outer; o++) for (let i = 0; i < inner; i++) counts[o] += runs[idx(o, i)];
  const clusters = [];
  let cur = null;
  for (let o = 0; o < outer; o++) {
    if (counts[o] === 0) continue;
    if (cur && o - cur.end <= CLUSTER_GAP) cur.end = o;
    else clusters.push((cur = { start: o, end: o }));
  }
  return clusters.map((c) => {
    const covered = new Uint8Array(inner);
    let weighted = 0, total = 0;
    for (let o = c.start; o <= c.end; o++) {
      for (let i = 0; i < inner; i++) if (runs[idx(o, i)]) covered[i] = 1;
      weighted += o * counts[o];
      total += counts[o];
    }
    return { pos: Math.round(weighted / total), start: c.start, end: c.end, covered };
  });
}

function coverage(line, from, to) {
  let n = 0;
  for (let i = from; i < to; i++) n += line.covered[i];
  return n / Math.max(1, to - from);
}

/**
 * 표 구조를 찾는다.
 * @returns {{width:number,height:number,table:{x0,y0,x1,y1},columns:{x0,x1}[],bands:{y0,y1}[],headerBands:{y0,y1}[]}}
 *   columns[0]은 '구분' 열, columns[1..]은 날짜 열. bands는 식사 행(위→아래).
 */
function detectGrid(png, { expectedDays = 5 } = {}) {
  const { width: W, height: H } = png;
  const mask = lineMask(png);
  const vRuns = longRuns(mask, W, H, true);
  const hRuns = longRuns(mask, W, H, false);
  const vLines = clusterLines(vRuns, W, H, true);
  const hLines = clusterLines(hRuns, W, H, false);
  if (!vLines.length || !hLines.length) throw new GridError('격자선을 찾지 못했습니다');

  // 표 외곽: 가장 긴 가로선/세로선
  const hTotal = (l) => l.covered.reduce((a, b) => a + b, 0);
  const longestH = Math.max(...hLines.map(hTotal));
  const tableH = hLines.filter((l) => hTotal(l) >= longestH * 0.6);
  const x0 = Math.min(...tableH.map((l) => l.covered.indexOf(1)));
  const x1 = Math.max(...tableH.map((l) => l.covered.lastIndexOf(1)));
  const y0 = tableH[0].pos;
  const y1 = tableH[tableH.length - 1].pos;

  const cols = vLines.filter((l) => l.pos >= x0 - CLUSTER_GAP && l.pos <= x1 + CLUSTER_GAP && coverage(l, y0, y1) >= 0.35);
  if (cols.length < 3) throw new GridError(`세로선이 부족합니다(${cols.length})`);
  const columns = [];
  for (let i = 0; i + 1 < cols.length; i++) columns.push({ x0: cols[i].end + 1, x1: cols[i + 1].start - 1 });
  if (columns.length !== expectedDays + 1) {
    throw new GridError(`열 개수가 예상과 다릅니다(구분+${columns.length - 1}일, 예상 ${expectedDays}일)`);
  }

  // '구분' 열까지 가로지르는 가로선만 식사 행 경계로 본다(식사 내부 하위 칸 구분선 제외)
  const label = columns[0];
  const rows = hLines.filter((l) => l.pos >= y0 - CLUSTER_GAP && l.pos <= y1 + CLUSTER_GAP && coverage(l, label.x0, label.x1) >= 0.7);
  if (rows.length < 3) throw new GridError(`가로선이 부족합니다(${rows.length})`);
  const allBands = [];
  for (let i = 0; i + 1 < rows.length; i++) allBands.push({ y0: rows[i].end + 1, y1: rows[i + 1].start - 1 });
  // 첫 행은 요일·날짜 머리글
  const [header, ...bands] = allBands;
  // 날짜 열마다 식사 행 안의 하위 칸 구분선(셀 기준 상대 y)
  const splits = columns.slice(1).map((c) =>
    bands.map((b) =>
      hLines
        .filter((l) => l.pos > b.y0 + CLUSTER_GAP && l.pos < b.y1 - CLUSTER_GAP && coverage(l, c.x0, c.x1) >= 0.7)
        .map((l) => l.pos - b.y0),
    ),
  );
  return { width: W, height: H, table: { x0, y0, x1, y1 }, columns, header, bands, splits };
}

class GridError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'GridError';
  }
}

function crop(png, { x0, y0, x1, y1 }, pad = 0) {
  const X0 = Math.max(0, x0 - pad), Y0 = Math.max(0, y0 - pad);
  const X1 = Math.min(png.width - 1, x1 + pad), Y1 = Math.min(png.height - 1, y1 + pad);
  const w = X1 - X0 + 1, h = Y1 - Y0 + 1;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    png.data.copy(out.data, y * w * 4, ((Y0 + y) * png.width + X0) * 4, ((Y0 + y) * png.width + X0 + w) * 4);
  }
  // 투명 배경은 흰색으로 합성(OCR 엔진 대부분이 알파를 무시)
  for (let p = 0; p < w * h; p++) {
    const a = out.data[p * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) out.data[p * 4 + c] = Math.round(out.data[p * 4 + c] * a + 255 * (1 - a));
    out.data[p * 4 + 3] = 255;
  }
  return PNG.sync.write(out);
}

/**
 * 작은 셀 이미지를 OCR하기 좋게 키우고 흰 여백을 둔다(작은 이미지는 기본 OCR이 글자를 놓치기 쉬움).
 * 좌표 비율이 유지되도록 정수배로만 키운다.
 */
function prepareForOcr(buf, minSide = 240) {
  const png = decodePng(buf);
  const factor = Math.max(1, Math.ceil(minSide / Math.min(png.width, png.height)));
  if (factor === 1) return buf;
  const pad = 16 * factor;
  const W = png.width * factor + pad * 2, H = png.height * factor + pad * 2;
  const out = new PNG({ width: W, height: H });
  out.data.fill(255);
  for (let y = 0; y < png.height * factor; y++) {
    for (let x = 0; x < png.width * factor; x++) {
      // 쌍선형 보간
      const fx = (x + 0.5) / factor - 0.5, fy = (y + 0.5) / factor - 0.5;
      const x0 = Math.max(0, Math.floor(fx)), y0 = Math.max(0, Math.floor(fy));
      const x1 = Math.min(png.width - 1, x0 + 1), y1 = Math.min(png.height - 1, y0 + 1);
      const ax = Math.min(1, Math.max(0, fx - x0)), ay = Math.min(1, Math.max(0, fy - y0));
      const o = ((y + pad) * W + x + pad) * 4;
      for (let c = 0; c < 3; c++) {
        const v = (i) => png.data[i + c];
        const p00 = v((y0 * png.width + x0) * 4), p10 = v((y0 * png.width + x1) * 4);
        const p01 = v((y1 * png.width + x0) * 4), p11 = v((y1 * png.width + x1) * 4);
        out.data[o + c] = Math.round((p00 * (1 - ax) + p10 * ax) * (1 - ay) + (p01 * (1 - ax) + p11 * ax) * ay);
      }
      out.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(out);
}

/** 글자가 있는 부분만 남기고 여백을 잘라낸다(작은 글자가 넓은 빈 칸에 있으면 OCR이 놓치기 쉬움) */
function trimInk(png, box, pad = 24) {
  let X0 = Infinity, Y0 = Infinity, X1 = -1, Y1 = -1;
  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const i = (y * png.width + x) * 4;
      if (png.data[i + 3] > 128 && (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3 < 160) {
        if (x < X0) X0 = x;
        if (x > X1) X1 = x;
        if (y < Y0) Y0 = y;
        if (y > Y1) Y1 = y;
      }
    }
  }
  if (X1 < 0) return crop(png, box);
  return crop(png, {
    x0: Math.max(box.x0, X0 - pad), y0: Math.max(box.y0, Y0 - pad),
    x1: Math.min(box.x1, X1 + pad), y1: Math.min(box.y1, Y1 + pad),
  });
}

/**
 * 셀 단위로 자른 이미지 묶음을 만든다.
 * days[d] = { header: Buffer, bands: Buffer[] }, labels = Buffer[], top/bottom = 표 밖 안내 영역
 */
function sliceWeek(buf, opts) {
  const png = decodePng(buf);
  const grid = detectGrid(png, opts);
  const days = grid.columns.slice(1).map((c) => ({
    header: trimInk(png, { x0: c.x0, x1: c.x1, y0: grid.header.y0, y1: grid.header.y1 }),
    bands: grid.bands.map((b) => crop(png, { x0: c.x0, x1: c.x1, y0: b.y0, y1: b.y1 })),
  }));
  const label = grid.columns[0];
  const labels = grid.bands.map((b) => trimInk(png, { x0: label.x0, x1: label.x1, y0: b.y0, y1: b.y1 }));
  const top = grid.table.y0 > 20 ? crop(png, { x0: 0, x1: png.width - 1, y0: 0, y1: grid.table.y0 - 1 }) : null;
  const bottom = grid.table.y1 < png.height - 20 ? crop(png, { x0: 0, x1: png.width - 1, y0: grid.table.y1 + 1, y1: png.height - 1 }) : null;
  return { grid, days, labels, top, bottom };
}

module.exports = { decodePng, detectGrid, sliceWeek, crop, trimInk, prepareForOcr, GridError };
