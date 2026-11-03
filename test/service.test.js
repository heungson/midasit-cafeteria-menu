'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MenuService } = require('../src/main/menu/service');
const { WeekCache } = require('../src/main/menu/cache');
const { validateProfile } = require('../src/main/profile');
const { GwError } = require('../src/main/gw/http');
const { RecognitionError } = require('../src/main/ocr');
const { startFakeGw } = require('./helpers/fake-gw');

const demoWeek = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'demo-week.json'), 'utf8'));
const at = (iso) => () => new Date(iso);
const TUE = '2030-03-05T12:10:00+09:00';

function tmpCache() {
  return new WeekCache(fs.mkdtempSync(path.join(os.tmpdir(), 'cafeteria-cache-')));
}

function fakeCreds(map = { '127.0.0.1': { username: 'kim', password: 'pw' } }) {
  return { get: (host) => map[host.split(':')[0]] || null };
}

function make({ profile, clock = at(TUE), cache = tmpCache(), credentials = fakeCreds(), recognize, createClient, settings = {} }) {
  const calls = { recognize: 0 };
  const svc = new MenuService({
    getProfile: () => profile,
    credentials,
    cache,
    settings: () => ({ claudeEnabled: false, claudeModel: 'sonnet', crossCheck: false, refreshMinutes: 30, ...settings }),
    claudePath: () => null,
    clock,
    createClient,
    recognize: async (...a) => {
      calls.recognize++;
      return recognize ? recognize(...a) : demoWeek;
    },
  });
  return { svc, calls, cache };
}

test('정상: 이번 주 게시물 → 이미지 → 인식 → 오늘(화) 메뉴', async (t) => {
  const gw = await startFakeGw();
  t.after(gw.close);
  const { svc, calls } = make({ profile: validateProfile(gw.profile) });
  await svc.refresh({ force: true });
  const v = svc.view;
  assert.equal(v.status, 'ok', v.message);
  assert.equal(v.todayDay.date, '2030-03-05');
  assert.equal(v.todayDay.meals.lunch.sections[0].items[0].name, '닭갈비');
  assert.equal(calls.recognize, 1);
});

test('같은 이미지(해시)면 다시 인식하지 않고, 이미지가 바뀌면 다시 인식', async (t) => {
  const gw = await startFakeGw();
  t.after(gw.close);
  const { svc, calls } = make({ profile: validateProfile(gw.profile) });
  await svc.refresh({ force: true });
  await svc.refresh({ force: true });
  assert.equal(calls.recognize, 1);
  gw.state.image = Buffer.concat([gw.state.image, Buffer.from([0])]);
  await svc.refresh({ force: true });
  assert.equal(calls.recognize, 2);
});

test('주말: 네트워크 상태와 관계없이 주말로 표시, 다음 주 게시물은 미리보기용', async (t) => {
  const gw = await startFakeGw({ posts: [{ no: '11', title: '(3/11~ 3/15) 주간 식단표' }] });
  t.after(gw.close);
  const { svc } = make({ profile: validateProfile(gw.profile), clock: at('2030-03-09T10:00:00+09:00'), recognize: () => ({ ...demoWeek, weekStart: '2030-03-11', days: demoWeek.days.map((d, i) => ({ ...d, date: `2030-03-1${1 + i}` })) }) });
  await svc.refresh({ force: true });
  assert.equal(svc.view.status, 'weekend');
  assert.equal(svc.view.todayDay, null);
  assert.equal(svc.view.week.weekStart, '2030-03-11');
});

test('미게시: 이번 주 글이 없으면 not_posted와 최근 게시 기간', async (t) => {
  const gw = await startFakeGw({ posts: [{ no: '10', title: '(2/25~ 3/1) 주간 식단표' }] });
  t.after(gw.close);
  const { svc } = make({ profile: validateProfile(gw.profile) });
  await svc.refresh({ force: true });
  assert.equal(svc.view.status, 'not_posted');
  assert.match(svc.view.message, /최근 게시: 2\/25~3\/1/);
});

test('네트워크 단절: 캐시가 없으면 offline, 있으면 캐시와 안내', async (t) => {
  const gw = await startFakeGw();
  const profile = validateProfile(gw.profile);
  const cache = tmpCache();
  const first = make({ profile, cache });
  await first.svc.refresh({ force: true });
  await gw.close();
  const noCache = make({ profile, createClient: undefined });
  await noCache.svc.refresh({ force: true });
  assert.equal(noCache.svc.view.status, 'offline');
  const withCache = make({ profile, cache });
  await withCache.svc.refresh({ force: true });
  assert.equal(withCache.svc.view.status, 'ok');
  assert.match(withCache.svc.view.notice, /사내망 또는 VPN/);
});

test('지난주 캐시는 이번 주 오늘 메뉴로 쓰지 않는다', async (t) => {
  const gw = await startFakeGw();
  const profile = validateProfile(gw.profile);
  const cache = tmpCache();
  await make({ profile, cache }).svc.refresh({ force: true }); // 3/4 주 캐시
  await gw.close();
  const nextWeek = make({ profile, cache, clock: at('2030-03-12T09:00:00+09:00') });
  await nextWeek.svc.refresh({ force: true });
  assert.equal(nextWeek.svc.view.status, 'offline');
  assert.equal(nextWeek.svc.view.todayDay, null);
  assert.equal(nextWeek.svc.view.week, null);
});

test('계정 없음, 비밀번호 오류(자동 재시도 중단), 추가 인증을 구분', async (t) => {
  const gw = await startFakeGw({ users: { 'kim@example.test': { password: 'pw' }, 'otp@example.test': { password: 'pw', otp: true } } });
  t.after(gw.close);
  const profile = validateProfile(gw.profile);
  const none = make({ profile, credentials: fakeCreds({}) });
  await none.svc.refresh({ force: true });
  assert.equal(none.svc.view.status, 'auth_required');

  const wrong = make({ profile, credentials: fakeCreds({ '127.0.0.1': { username: 'kim', password: 'bad' } }) });
  await wrong.svc.refresh({ force: true });
  assert.equal(wrong.svc.view.status, 'auth_failed');
  const attempts = gw.state.loginAttempts;
  await wrong.svc.refresh(); // 자동 갱신
  await wrong.svc.refresh();
  assert.equal(gw.state.loginAttempts, attempts, '틀린 비밀번호로 자동 재시도하지 않는다');

  const otp = make({ profile, credentials: fakeCreds({ '127.0.0.1': { username: 'otp', password: 'pw' } }) });
  await otp.svc.refresh({ force: true });
  assert.equal(otp.svc.view.status, 'extra_auth');
});

test('인식 실패와 프로필 없음', async (t) => {
  const gw = await startFakeGw();
  t.after(gw.close);
  const failing = make({ profile: validateProfile(gw.profile), recognize: () => Promise.reject(new RecognitionError('x', ['Claude: 실패', '기본 OCR: 실패'])) });
  await failing.svc.refresh({ force: true });
  assert.equal(failing.svc.view.status, 'recognition_failed');
  assert.match(failing.svc.view.errorDetail, /기본 OCR/);
  const noProfile = make({ profile: null });
  await noProfile.svc.refresh({ force: true });
  assert.equal(noProfile.svc.view.status, 'no_profile');
});

test('날짜가 맞지 않는 열은 오늘로 보여주지 않는다', async (t) => {
  const gw = await startFakeGw();
  t.after(gw.close);
  const shifted = { ...demoWeek, days: demoWeek.days.map((d) => (d.date === '2030-03-05' ? { ...d, date: null, dateCheck: 'mismatch' } : d)) };
  const { svc } = make({ profile: validateProfile(gw.profile), recognize: () => shifted });
  await svc.refresh({ force: true });
  assert.equal(svc.view.status, 'date_unverified');
  assert.equal(svc.view.todayDay, null);
});

test('서버 오류 분류', async () => {
  const profile = validateProfile({ baseUrl: 'https://gw.test', login: { submitPath: '/l', fields: {} }, board: { listPath: '/b', articlePath: '/a?{id}' } });
  const { svc } = make({
    profile,
    credentials: fakeCreds({ 'gw.test': { username: 'a', password: 'b' } }),
    createClient: () => ({ listWeeklyPosts: () => Promise.reject(new GwError('server_error', '500')) }),
  });
  await svc.refresh({ force: true });
  assert.equal(svc.view.status, 'server_error');
});

test('자동 조회 간격: 게시물이 없어도 매분 조회하지 않고, 직접 새로고침은 바로 조회', async (t) => {
  const gw = await startFakeGw({ posts: [] });
  t.after(gw.close);
  let now = new Date(TUE);
  const { svc } = make({ profile: validateProfile(gw.profile), clock: () => now });
  await svc.refresh();
  const count = () => gw.state.log.filter((l) => l.startsWith('GET /board/list')).length;
  assert.equal(count(), 1);
  now = new Date(now.getTime() + 60000);
  await svc.refresh();
  assert.equal(count(), 1, '1분 뒤 자동 조회는 건너뜀');
  now = new Date(now.getTime() + 31 * 60000);
  await svc.refresh();
  assert.equal(count(), 2, '확인 간격(30분)이 지나면 조회');
  await svc.refresh({ force: true });
  assert.equal(count(), 3);
});
