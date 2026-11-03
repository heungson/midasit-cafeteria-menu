'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../src/main/menu/week');
const { selectDay } = require('../src/main/menu/select');

test('한국 시간 기준 날짜: UTC 15:00 이후는 다음 날', () => {
  assert.equal(W.kstToday(new Date('2030-03-04T14:59:00Z')), '2030-03-04');
  assert.equal(W.kstToday(new Date('2030-03-04T15:00:00Z')), '2030-03-05');
});

test('주 시작(월요일)과 주말', () => {
  assert.equal(W.mondayOf('2030-03-06'), '2030-03-04');
  assert.equal(W.mondayOf('2030-03-10'), '2030-03-04'); // 일요일
  assert.equal(W.isWeekend('2030-03-09'), true);
  assert.equal(W.isWeekend('2030-03-08'), false);
});

test('게시물 제목의 기간 해석', () => {
  assert.deepEqual(W.parseTitleRange('(3/4~ 3/8) 주간 식단표', '2030-03-05'), { start: '2030-03-04', end: '2030-03-08', weekStart: '2030-03-04' });
  assert.deepEqual(W.parseTitleRange('(3/4 ~ 8) 식단', '2030-03-05'), { start: '2030-03-04', end: '2030-03-08', weekStart: '2030-03-04' });
  // 연말·연초를 걸치는 주
  assert.deepEqual(W.parseTitleRange('(12/30~1/3) 식단', '2030-12-31'), { start: '2030-12-30', end: '2031-01-03', weekStart: '2030-12-30' });
  assert.deepEqual(W.parseTitleRange('(12/30~1/3) 식단', '2031-01-02'), { start: '2030-12-30', end: '2031-01-03', weekStart: '2030-12-30' });
  assert.equal(W.parseTitleRange('주간 식단', '2030-03-05'), null);
  assert.equal(W.parseTitleRange('(3/4~ 3/20) 식단', '2030-03-05'), null); // 7일 초과
});

test('머리글 날짜 비교: OCR이 점을 놓친 경우까지', () => {
  assert.equal(W.headerMatchesDate('3.5', '2030-03-05'), true);
  assert.equal(W.headerMatchesDate('35', '2030-03-05'), true);
  assert.equal(W.headerMatchesDate('3.6', '2030-03-05'), false);
  assert.equal(W.headerMatchesDate('', '2030-03-05'), null);
});

test('오늘 선택: 다른 주의 메뉴를 오늘로 보여주지 않는다', () => {
  const week = { weekStart: '2030-03-04', days: [{ date: '2030-03-04' }, { date: '2030-03-05' }] };
  assert.equal(selectDay(week, '2030-03-05').status, 'ok');
  assert.equal(selectDay(week, '2030-03-05').day.date, '2030-03-05');
  assert.equal(selectDay(week, '2030-03-12').status, 'other_week');
  assert.equal(selectDay(week, '2030-03-09').status, 'weekend');
  assert.equal(selectDay(week, '2030-03-06').status, 'no_column');
  const bad = { weekStart: '2030-03-04', days: [{ date: null, dateCheck: 'mismatch' }] };
  assert.equal(selectDay(bad, '2030-03-04').status, 'date_unverified');
});
