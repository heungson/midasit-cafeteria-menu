'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tp = require('../src/main/ocr/textparse');

const L = (text, y, w = 100) => ({ text, x: 10, y, w, h: 20 });

test('섹션 제목과 태그, 슬래시 항목, 줄바꿈으로 잘린 단어', () => {
  const lines = [
    L('-간편식-', 10, 60),
    L('(M)프렌치토스트', 40, 150),
    L('(S)감자샐러드', 70, 140),
    L('-한식-', 100, 50),
    L('두부조림/시금치무침/배', 130, 290),
    L('추김치/쌀밥/미역국', 160, 200),
  ];
  const r = tp.parseCell(lines, 320);
  assert.equal(r.notServed, false);
  assert.deepEqual(r.sections, [
    { title: '간편식', items: [{ name: '프렌치토스트', tag: 'M' }, { name: '감자샐러드', tag: 'S' }] },
    { title: '한식', items: ['두부조림', '시금치무침', '배추김치', '쌀밥', '미역국'].map((name) => ({ name, tag: '' })) },
  ]);
});

test('슬래시가 없는 칸은 한 줄이 한 항목(서로 다른 메뉴를 합치지 않음)', () => {
  const r = tp.parseCell([L('믹스샐러드&방울토마토', 10, 300), L('삶은감자', 40, 90)], 320);
  assert.deepEqual(r.sections[0].items.map((i) => i.name), ['믹스샐러드&방울토마토', '삶은감자']);
});

test('짧은 줄은 이어 붙이지 않고 새 항목으로', () => {
  const r = tp.parseCell([L('고구마스프', 10, 120), L('그린샐러드&드레', 40, 300), L('싱/과일', 70, 100)], 320);
  assert.deepEqual(r.sections[0].items.map((i) => i.name), ['고구마스프', '그린샐러드&드레싱', '과일']);
});

test('셀 안 가로 구분선으로 섹션 분리, 미제공', () => {
  const r = tp.parseCell([L('카레', 10), L('단무지/김치', 200)], 320, [100]);
  assert.equal(r.sections.length, 2);
  assert.deepEqual(tp.parseCell([L('미제공', 100)], 320), { notServed: true, sections: [] });
  assert.deepEqual(tp.parseCell([], 320), { notServed: false, sections: [] });
});

test('층별 식사시간: 좌우 두 안내를 위치로 구분', () => {
  const lines = [
    { text: '[중식 - 시간별 층수 안내]', x: 70, y: 10, w: 300, h: 30 },
    { text: '[석식 - 시간별 층수 안내]', x: 410, y: 10, w: 300, h: 30 },
    { text: '11:30 = A동, 2F, 가F', x: 70, y: 50, w: 200, h: 30 },
    { text: '17:30 = A동, B동', x: 410, y: 50, w: 200, h: 30 },
    { text: '12:00 = B동, 3F', x: 70, y: 90, w: 200, h: 30 },
  ];
  assert.deepEqual(tp.parseFloorSchedules(lines), [
    { meal: '점심', time: '11:30', places: ['A동', '2F', '7F'] },
    { meal: '저녁', time: '17:30', places: ['A동', 'B동'] },
    { meal: '점심', time: '12:00', places: ['B동', '3F'] },
  ]);
});

test('층 표기 보정은 숫자+F 형태에만 적용', () => {
  assert.equal(tp.fixPlace('가F'), '7F');
  assert.equal(tp.fixPlace('1O F'), '1O F');
  assert.equal(tp.fixPlace('가동'), '가동');
  assert.equal(tp.fixPlace(' 10F '), '10F');
});

test('식사시간 문장 해석', () => {
  const t = '※ 식사시간 = 조식: 7시 30분~8시 30분 (8시 20분 배식완료), 중식: 11시 30분~13시 (12시 50분 배식 완료), 석식: 17시 30분~ 18시 30분';
  assert.deepEqual(tp.parseServingTimes(t), [
    { meal: '아침', start: '07:30', end: '08:30', lastServe: '08:20' },
    { meal: '점심', start: '11:30', end: '13:00', lastServe: '12:50' },
    { meal: '저녁', start: '17:30', end: '18:30', lastServe: '' },
  ]);
});

test('행 이름 분류', () => {
  assert.equal(tp.rowLabel('아 침'), '아침');
  assert.equal(tp.rowLabel('건강존 메뉴'), '건강존');
  assert.equal(tp.rowLabel('석식'), '저녁');
  assert.equal(tp.rowLabel(')-스'), '기타');
});
