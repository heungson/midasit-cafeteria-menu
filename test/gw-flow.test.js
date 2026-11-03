'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GroupwareClient } = require('../src/main/gw/client');
const { validateProfile } = require('../src/main/profile');
const { Session } = require('../src/main/gw/http');
const { startFakeGw, PNG } = require('./helpers/fake-gw');

const creds = { username: 'kim', password: 'pw' };

test('로그인(조직 도메인 조회) → 목록 → 래퍼 → 본문 프레임 → 에디터 이미지', async (t) => {
  const gw = await startFakeGw();
  t.after(gw.close);
  const c = new GroupwareClient(validateProfile(gw.profile));
  const items = await c.listWeeklyPosts(creds);
  assert.deepEqual(items.map((i) => i.id), ['10', '11']);
  // 로그인 화면 스크립트처럼 입력값 + '@' + 조직 도메인으로 아이디를 만든다
  assert.deepEqual(gw.state.lastLoginForm, { userInput: 'kim', user: 'kim@example.test', pw: 'pw', lang: 'ko' });
  const r = await c.fetchArticleImages('11', creds);
  assert.equal(r.images.length, 1);
  assert.ok(r.images[0].buf.equals(PNG));
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.ok(gw.state.log.some((l) => l.startsWith('GET /board/body?no=11&bid=TEST')), gw.state.log.join('\n'));
  assert.ok(!gw.state.deleted, '위험한 경로는 요청하지 않는다');
  assert.ok(!gw.state.log.some((l) => l.includes('evil')));
});

test('조직 도메인이 없으면 입력한 이메일 주소를 그대로 사용', async (t) => {
  const gw = await startFakeGw({ orgDomain: '', users: { 'lee@corp.test': { password: 'pw' } } });
  t.after(gw.close);
  const c = new GroupwareClient(validateProfile(gw.profile));
  await c.listWeeklyPosts({ username: 'lee@corp.test', password: 'pw' });
  assert.equal(gw.state.lastLoginForm.user, 'lee@corp.test');
});

test('비밀번호 오류·없는 사용자·추가 인증을 구분', async (t) => {
  const gw = await startFakeGw({ users: { 'kim@example.test': { password: 'pw' }, 'otp@example.test': { password: 'pw', otp: true } } });
  t.after(gw.close);
  const p = validateProfile(gw.profile);
  await assert.rejects(new GroupwareClient(p).listWeeklyPosts({ username: 'kim', password: 'wrong' }), { code: 'auth_failed', serverCode: 'E200' });
  await assert.rejects(new GroupwareClient(p).listWeeklyPosts({ username: 'nobody', password: 'pw' }), { code: 'auth_user_unknown' });
  await assert.rejects(new GroupwareClient(p).listWeeklyPosts({ username: 'otp', password: 'pw' }), { code: 'extra_auth' });
});

test('세션이 만료되면 한 번 다시 로그인한다', async (t) => {
  const gw = await startFakeGw({ expireAfter: 2 }); // 로그인 직후 이동(/main) + 목록 1회
  t.after(gw.close);
  const c = new GroupwareClient(validateProfile(gw.profile));
  await c.listWeeklyPosts(creds); // 세션의 유일한 허용 요청 사용
  const items = await c.listWeeklyPosts(creds); // 만료 화면 → 재로그인
  assert.equal(items.length, 2);
  assert.equal(gw.state.loginAttempts, 2);
});

test('다른 출처로의 리다이렉트는 따라가지 않는다', async (t) => {
  const gw = await startFakeGw();
  t.after(gw.close);
  const s = new Session(gw.profile.baseUrl);
  await assert.rejects(s.request('/elsewhere'), { code: 'unexpected' });
  assert.throws(() => s.url('https://evil.example/x'), { code: 'unexpected' });
});

test('연결 실패는 offline으로 분류', async () => {
  const gw = await startFakeGw();
  const profile = validateProfile(gw.profile);
  await gw.close();
  await assert.rejects(new GroupwareClient(profile, { timeoutMs: 2000 }).listWeeklyPosts(creds), { code: 'offline' });
});

test('게시물에 이미지가 없으면 image_missing', async (t) => {
  const gw = await startFakeGw();
  t.after(gw.close);
  const c = new GroupwareClient(validateProfile(gw.profile));
  await assert.rejects(c.fetchArticleImages('999', creds), { code: 'image_missing' });
});
