'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CredentialStore } = require('../src/main/credentials');
const { validateProfile, loadProfile, installProfile } = require('../src/main/profile');

function memoryKeyring() {
  const store = new Map();
  class Entry {
    constructor(service, user) {
      this.k = `${service}/${user}`;
    }
    setPassword(p) { store.set(this.k, p); }
    getPassword() { return store.get(this.k) ?? null; }
    deletePassword() { return store.delete(this.k); }
  }
  return { Entry, store };
}

test('계정은 호스트별 키링 항목 하나에 저장, 화면용 정보에는 비밀번호 없음', () => {
  const kr = memoryKeyring();
  const c = new CredentialStore({ keyring: kr });
  c.set('gw.a.test', { username: 'kim', password: 'secret' });
  assert.deepEqual(c.get('gw.a.test'), { username: 'kim', password: 'secret' });
  assert.equal(c.get('gw.b.test'), null, '다른 호스트에는 계정을 주지 않는다');
  assert.deepEqual(c.describe('gw.a.test'), { saved: true, username: 'kim' });
  assert.ok(!JSON.stringify(c.describe('gw.a.test')).includes('secret'));
  assert.equal(c.clear('gw.a.test'), true);
  assert.equal(c.get('gw.a.test'), null);
  assert.throws(() => c.set('gw.a.test', { username: 'kim', password: '' }));
});

// 실제 macOS 키체인 / Windows 자격 증명 관리자 왕복 확인(로컬 기기에서 직접 실행할 때만)
const real = process.env.CAFETERIA_TEST_KEYCHAIN === '1' ? false : 'CAFETERIA_TEST_KEYCHAIN=1일 때만 실행';
test('실제 OS 자격 증명 저장소 왕복', { skip: real }, () => {
  const c = new CredentialStore({ service: 'cafeteria-menu.test' });
  const host = `selftest-${process.pid}.invalid`;
  try {
    c.set(host, { username: 'tester', password: 'p@ss 한글' });
    assert.deepEqual(c.get(host), { username: 'tester', password: 'p@ss 한글' });
  } finally {
    c.clear(host);
  }
  assert.equal(c.get(host), null);
});

test('프로필 검증: https 필수, 게시물 경로에 {id} 필요', () => {
  const ok = { baseUrl: 'https://gw.test/x', login: { submitPath: '/l', fields: { u: '{loginId}' } }, board: { listPath: '/b', articlePath: '/a?n={id}' } };
  assert.equal(validateProfile(ok).baseUrl, 'https://gw.test');
  assert.throws(() => validateProfile({ ...ok, baseUrl: 'http://gw.test' }), /https/);
  assert.throws(() => validateProfile({ ...ok, board: { listPath: '/b', articlePath: '/a' } }), /\{id\}/);
});

test('공개 예시 프로필은 유효하고 실제 값이 아닌 자리표시자만 담는다', () => {
  const ex = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'profile.example.json'), 'utf8'));
  const p = validateProfile(ex);
  assert.match(new URL(p.baseUrl).hostname, /\.example$/);
});

test('프로필 가져오기는 사용자 데이터 폴더에 저장하고, 그 파일을 우선 사용', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-'));
  const dest = installProfile(path.join(__dirname, '..', 'profile.example.json'), dir);
  assert.equal(dest, path.join(dir, 'profile.json'));
  const { profile, file } = loadProfile({ userDataDir: dir, appRoot: null, env: {} });
  assert.equal(file, dest);
  assert.ok(profile);
  if (process.platform !== 'win32') assert.equal(fs.statSync(dest).mode & 0o077, 0, '다른 사용자가 읽을 수 없게 저장');
});
