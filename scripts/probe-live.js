#!/usr/bin/env node
'use strict';
// 계정 없이 확인할 수 있는 범위에서 접속 프로필을 실제 그룹웨어와 대조한다(읽기 전용).
//  - 로그인 화면: 프로필의 폼 필드가 실제 로그인 폼에 있는지, 조직 도메인 조회 스크립트가 있는지
//  - 조직 도메인 조회 결과(로그인 화면 스크립트와 같은 요청)
//  - 게시판 목록·게시물 주소가 로그인 전 '세션 만료' 화면으로 인식되는지
// 실행: node scripts/probe-live.js [--profile profile.local.json]
const path = require('path');
const fs = require('fs');
const { validateProfile } = require('../src/main/profile');
const { Session } = require('../src/main/gw/http');
const { GroupwareClient } = require('../src/main/gw/client');
const P = require('../src/main/gw/parse');

const i = process.argv.indexOf('--profile');
const file = path.resolve(i > 0 ? process.argv[i + 1] : path.join(__dirname, '..', 'profile.local.json'));
if (!fs.existsSync(file)) {
  console.error('프로필 파일이 없습니다:', path.basename(file));
  process.exit(2);
}
const profile = validateProfile(JSON.parse(fs.readFileSync(file, 'utf8')));
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '✔' : '✘'} ${m}`);
  if (!c) fail++;
};

(async () => {
  const s = new Session(profile.baseUrl);
  const page = await s.request(profile.login.pagePath);
  const html = page.text();
  ok(page.status === 200 && P.hasPasswordForm(html), `로그인 화면 응답 ${page.status}, 비밀번호 입력란 존재`);
  const names = new Set([...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bname\s*=\s*["']?([\w-]+)/gi)].map((m) => m[1]));
  const missing = Object.keys(profile.login.fields).filter((f) => !names.has(f));
  ok(!missing.length, `프로필 로그인 필드가 실제 폼에 있음${missing.length ? ` (없음: ${missing.join(', ')})` : ''}`);
  ok(html.includes(profile.login.submitPath), '로그인 스크립트가 프로필의 제출 경로를 사용');
  const client = new GroupwareClient(profile);
  if (profile.login.orgLookupPath) {
    ok(html.includes(profile.login.orgLookupPath), '로그인 화면이 조직 도메인 조회를 수행');
    const r = await client.resolveLoginId('someone', html);
    console.log(`  · 도메인 없이 입력한 아이디의 처리: ${r.source === 'orgLookup' ? '조직 도메인 자동 추가' : r.source === 'profile' ? '프로필 접미사 추가' : '입력값 그대로(이메일 주소 전체 입력 필요)'}`);
  }
  for (const [label, p] of [['게시판 목록', profile.board.listPath], ['게시물 보기', profile.board.articlePath.replace('{id}', '1')]]) {
    const res = await new Session(profile.baseUrl).request(p);
    ok(client.isSessionExpired(res), `${label}: 로그인 전에는 세션 만료 화면으로 인식(${res.status})`);
  }
  console.log(fail ? `\n${fail}개 확인 실패` : '\n계정 없이 확인 가능한 항목 모두 통과 (실제 로그인·목록·이미지는 계정이 있어야 확인 가능)');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`✘ ${e.code || ''} ${e.message}`);
  process.exit(1);
});
