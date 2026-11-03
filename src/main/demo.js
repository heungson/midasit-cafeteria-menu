'use strict';
// 오프라인 데모: 합성(가상) 메뉴 데이터를 이번 주 날짜로 옮겨 보여준다. 실제 메뉴가 아님을 화면에 표시한다.
const fs = require('fs');
const path = require('path');
const { MESSAGES, kstMinutes } = require('./menu/service');
const { selectDay } = require('./menu/select');
const W = require('./menu/week');

function loadDemoWeek(file, today) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const week = raw.weekStart ? raw : raw.claude || raw.native || Object.values(raw)[0];
  const weekStart = W.isWeekend(today) ? W.mondayOf(W.addDays(today, 7)) : W.mondayOf(today);
  const shift = W.daysBetween(week.weekStart, weekStart);
  return {
    ...week,
    weekStart,
    rangeStart: W.addDays(week.rangeStart, shift),
    rangeEnd: W.addDays(week.rangeEnd, shift),
    days: week.days.map((d) => (d.date ? { ...d, date: W.addDays(d.date, shift), weekday: W.weekdayName(W.addDays(d.date, shift)) } : d)),
  };
}

class DemoService {
  constructor({ file, clock = () => new Date(), onChange = () => {} }) {
    this.custom = !!file;
    this.file = file || path.join(__dirname, '..', '..', 'fixtures', 'demo-week.json');
    this.clock = clock;
    this.onChange = onChange;
  }

  compose() {
    const today = W.kstToday(this.clock());
    const week = loadDemoWeek(this.file, today);
    const sel = W.isWeekend(today) ? { status: 'weekend' } : selectDay(week, today);
    return {
      today,
      weekday: W.weekdayName(today),
      weekStart: week.weekStart,
      status: sel.status,
      message: MESSAGES[sel.status] || '',
      week,
      todayDay: sel.day || null,
      source: { title: this.custom ? '로컬 인식 결과 파일' : '데모 데이터', savedAt: this.clock().toISOString(), checkedAt: this.clock().toISOString(), engine: 'demo' },
      notice: null,
      busy: false,
      demo: this.custom ? 'file' : 'sample',
      nowMinutes: kstMinutes(this.clock()),
    };
  }

  emit() {
    const v = this.compose();
    this.onChange(v);
    return v;
  }

  async refresh() {
    this.emit();
  }

  credentialsChanged() {}
}

module.exports = { DemoService, loadDemoWeek };
