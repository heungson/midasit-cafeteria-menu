'use strict';
// 한국 시간(Asia/Seoul, UTC+9, 서머타임 없음) 기준 날짜 계산.
// 날짜는 항상 'YYYY-MM-DD' 문자열로 다뤄 기기 시간대의 영향을 받지 않게 한다.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function kstParts(now = new Date()) {
  const d = new Date(now.getTime() + KST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

function ymd(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function kstToday(now = new Date()) {
  const p = kstParts(now);
  return ymd(p.year, p.month, p.day);
}

function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { year: y, month: m, day: d };
}

function addDays(dateStr, n) {
  const { year, month, day } = parseYmd(dateStr);
  const t = new Date(Date.UTC(year, month - 1, day + n));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function weekdayOf(dateStr) {
  const { year, month, day } = parseYmd(dateStr);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function weekdayName(dateStr) {
  return WEEKDAYS[weekdayOf(dateStr)];
}

/** 해당 날짜가 속한 주의 월요일 */
function mondayOf(dateStr) {
  const wd = weekdayOf(dateStr);
  return addDays(dateStr, wd === 0 ? -6 : 1 - wd);
}

function isWeekend(dateStr) {
  const wd = weekdayOf(dateStr);
  return wd === 0 || wd === 6;
}

/**
 * 연도 없는 월/일을 기준일에 가장 가까운 연도로 해석한다(연말·연초 게시물 대비).
 */
function resolveYear(month, day, refDateStr) {
  const ref = parseYmd(refDateStr);
  let best = null;
  for (const y of [ref.year - 1, ref.year, ref.year + 1]) {
    const s = ymd(y, month, day);
    const diff = Math.abs(daysBetween(refDateStr, s));
    if (!best || diff < best.diff) best = { s, diff };
  }
  return best.s;
}

function daysBetween(a, b) {
  const A = parseYmd(a), B = parseYmd(b);
  return Math.round((Date.UTC(B.year, B.month - 1, B.day) - Date.UTC(A.year, A.month - 1, A.day)) / 86400000);
}

/**
 * 게시물 제목의 "(3/4~ 3/8)" 같은 기간을 해석한다. 실패하면 null.
 */
function parseTitleRange(title, refDateStr) {
  const m = /\(\s*(\d{1,2})\s*[/.]\s*(\d{1,2})\s*~\s*(?:(\d{1,2})\s*[/.]\s*)?(\d{1,2})\s*\)/.exec(title || '');
  if (!m) return null;
  const sm = Number(m[1]), sd = Number(m[2]);
  const em = m[3] ? Number(m[3]) : sm, ed = Number(m[4]);
  if (!validMonthDay(sm, sd) || !validMonthDay(em, ed)) return null;
  const start = resolveYear(sm, sd, refDateStr);
  let end = resolveYear(em, ed, start);
  const span = daysBetween(start, end);
  if (span < 0 || span > 6) return null;
  return { start, end, weekStart: mondayOf(start) };
}

function validMonthDay(m, d) {
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

/** "11.3", "11/3", "113"(OCR이 점을 놓친 경우) 등을 기대 날짜와 비교 */
function headerMatchesDate(text, dateStr) {
  if (!text) return null; // 판독 불가
  const { month, day } = parseYmd(dateStr);
  const nums = String(text).match(/\d+/g);
  if (!nums) return null;
  if (nums.length >= 2) return Number(nums[0]) === month && Number(nums[1]) === day;
  return nums[0] === `${month}${day}` || nums[0] === `${month}${String(day).padStart(2, '0')}`;
}

module.exports = {
  WEEKDAYS,
  kstParts,
  kstToday,
  addDays,
  weekdayOf,
  weekdayName,
  mondayOf,
  isWeekend,
  resolveYear,
  daysBetween,
  parseTitleRange,
  headerMatchesDate,
  ymd,
};
