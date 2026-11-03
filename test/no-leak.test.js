'use strict';
// 공개 저장소에 회사별 접속 정보·실제 메뉴·기기 경로가 들어가지 않았는지 확인한다.
// (비공개 검사어는 로컬에만 있는 profile.local.json / local/acceptance.json에서 만든다)
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { privateTerms, committableFiles, scan } = require('../scripts/leak-check');

let isRepo = true;
try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: __dirname, stdio: 'ignore' });
} catch {
  isRepo = false;
}

test('공개 대상 파일에 비공개 문자열이 없다', { skip: !isRepo && 'git 저장소 아님' }, () => {
  const files = committableFiles();
  assert.ok(!files.some((f) => /(^|\/)(profile\.local\.json|profile\.json)$|^local\//.test(f)), '로컬 프로필·검증 자산은 git 대상이 아니어야 한다');
  const hits = scan(files, privateTerms());
  assert.deepEqual(hits.map((h) => h.file), []);
});
