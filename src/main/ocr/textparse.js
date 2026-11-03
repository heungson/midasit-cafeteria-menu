'use strict';
// 기본 OCR이 돌려준 줄 단위 글자(좌표 포함)를 Claude 결과와 같은 구조로 바꾼다.

const TAG_RE = /^\s*\(+\s*([MSEBHN])\s*\)\s*/i;
const TITLE_RE = /^\s*-\s*([^-]{1,12}?)\s*-\s*$/;
const FULL_WIDTH = 0.85; // 칸 너비 대비 이 비율 이상이면 줄바꿈으로 잘린 줄로 본다

function sortLines(lines) {
  return [...lines].sort((a, b) => (Math.abs(a.y - b.y) < a.h * 0.5 ? a.x - b.x : a.y - b.y));
}

function splitItem(raw) {
  const m = TAG_RE.exec(raw);
  const name = (m ? raw.slice(m[0].length) : raw).trim();
  return name ? { name, tag: m ? m[1].toUpperCase() : '' } : null;
}

/**
 * 한 섹션의 줄들을 항목으로.
 * '/'로 항목을 나열한 섹션에서는 칸을 거의 채운 줄을 다음 줄과 이어 붙인다(단어 중간 줄바꿈).
 * '/'가 없는 섹션은 한 줄이 한 항목이다. 이 경우 긴 이름이 줄바꿈되면 두 항목으로 보일 수 있지만,
 * 서로 다른 두 메뉴를 하나로 합치는 것보다 덜 해롭다.
 */
function linesToItems(lines, cellWidth) {
  const slashMode = lines.some((l) => l.text.includes('/'));
  let text = '';
  lines.forEach((l, i) => {
    text += l.text.trim();
    const next = lines[i + 1];
    const wrapped = slashMode && l.w >= cellWidth * FULL_WIDTH && !/\/\s*$/.test(l.text) && next && !TAG_RE.test(next.text);
    if (next && !wrapped) text += '/';
  });
  return text.split('/').map((s) => splitItem(s)).filter(Boolean);
}

/**
 * 셀 하나(식사 행 × 날짜)를 섹션 목록으로.
 * @param lines OCR 줄(셀 기준 좌표)
 * @param cellWidth 셀 이미지 너비
 * @param splits 셀 안 가로 구분선의 y(셀 기준)
 */
function parseCell(lines, cellWidth, splits = []) {
  const all = sortLines(lines.filter((l) => l.text && l.text.trim()));
  if (all.length === 1 && /^미\s*제\s*공$/.test(all[0].text.trim())) return { notServed: true, sections: [] };
  const bounds = [-Infinity, ...splits, Infinity];
  const sections = [];
  for (let s = 0; s + 1 < bounds.length; s++) {
    const part = all.filter((l) => l.y + l.h / 2 > bounds[s] && l.y + l.h / 2 <= bounds[s + 1]);
    let cur = { title: '', lines: [] };
    const flush = () => {
      if (cur.lines.length || cur.title) sections.push({ title: cur.title, items: linesToItems(cur.lines, cellWidth) });
    };
    for (const l of part) {
      const t = TITLE_RE.exec(l.text.trim());
      if (t) {
        flush();
        cur = { title: t[1].trim(), lines: [] };
      } else cur.lines.push(l);
    }
    flush();
  }
  return { notServed: false, sections: sections.filter((s) => s.items.length || s.title) };
}

function rowLabel(text) {
  const t = (text || '').replace(/\s+/g, '');
  if (/아침|조식/.test(t)) return '아침';
  if (/건강/.test(t)) return '건강존';
  if (/점심|중식/.test(t)) return '점심';
  if (/저녁|석식/.test(t)) return '저녁';
  return '기타';
}

function mealOf(text) {
  if (/조식|아침/.test(text)) return '아침';
  if (/중식|점심/.test(text)) return '점심';
  if (/석식|저녁/.test(text)) return '저녁';
  return null;
}

const hhmm = (h, m) => `${String(Number(h)).padStart(2, '0')}:${String(Number(m || 0)).padStart(2, '0')}`;

// 층 표기(숫자+F)에서 OCR이 숫자를 비슷한 글자로 읽는 경우만 바로잡는다
const DIGIT_LOOKALIKE = { 가: '7', 기: '7', l: '1', I: '1', '|': '1', O: '0', o: '0', S: '5', B: '8', Z: '2' };
function fixPlace(s) {
  const t = s.trim();
  const m = /^(\S{1,2})F$/.exec(t);
  if (!m || /^\d+$/.test(m[1])) return t;
  const digits = [...m[1]].map((c) => (/\d/.test(c) ? c : DIGIT_LOOKALIKE[c])).join('');
  return /^\d+$/.test(digits) && digits.length === m[1].length ? `${digits}F` : t;
}

/** "[중식 - 시간별 층수 안내]" 제목과 "12:00 = 9F, 7F" 줄을 위치로 짝지어 읽는다 */
function parseFloorSchedules(lines) {
  const sorted = sortLines(lines);
  const heads = sorted.filter((l) => /층/.test(l.text) && mealOf(l.text)).map((l) => ({ ...l, meal: mealOf(l.text) }));
  const out = [];
  for (const l of sorted) {
    const m = /(\d{1,2})\s*[:：]\s*(\d{2})\s*=\s*(.+)$/.exec(l.text);
    if (!m) continue;
    const head = heads
      .filter((h) => h.y < l.y)
      .sort((a, b) => Math.abs(a.x - l.x) - Math.abs(b.x - l.x) || b.y - a.y)[0];
    if (!head) continue;
    out.push({ meal: head.meal, time: hhmm(m[1], m[2]), places: m[3].split(/[,，]/).map(fixPlace).filter(Boolean) });
  }
  return out;
}

/** "조식: 8시~9시 (8시 50분 배식완료)" 형식의 식사시간 안내 */
function parseServingTimes(text) {
  const out = [];
  const t = '(\\d{1,2})\\s*시(?:\\s*(\\d{1,2})\\s*분)?';
  const re = new RegExp(`(조식|중식|석식)\\s*[:：]\\s*${t}\\s*~\\s*${t}(?:\\s*\\(\\s*${t}\\s*배\\s*식\\s*완\\s*료\\s*\\))?`, 'g');
  let m;
  while ((m = re.exec(text))) {
    out.push({ meal: mealOf(m[1]), start: hhmm(m[2], m[3]), end: hhmm(m[4], m[5]), lastServe: m[6] ? hhmm(m[6], m[7]) : '' });
  }
  return out;
}

module.exports = { parseCell, linesToItems, rowLabel, parseFloorSchedules, parseServingTimes, sortLines, fixPlace };
