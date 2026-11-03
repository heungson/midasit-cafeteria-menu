'use strict';
// 주간 데이터에서 '오늘'을 고른다. 날짜가 정확히 일치하고 검증된 열만 오늘로 보여준다.
const { mondayOf, isWeekend } = require('./week');

/**
 * @returns {{status:'ok'|'weekend'|'other_week'|'no_column'|'date_unverified', day?:object}}
 */
function selectDay(week, dateStr) {
  if (!week || mondayOf(dateStr) !== week.weekStart) return { status: 'other_week' };
  if (isWeekend(dateStr)) return { status: 'weekend' };
  const day = week.days.find((d) => d.date === dateStr);
  if (!day) {
    const mismatched = week.days.some((d) => d.dateCheck === 'mismatch');
    return { status: mismatched ? 'date_unverified' : 'no_column' };
  }
  return { status: 'ok', day };
}

module.exports = { selectDay };
