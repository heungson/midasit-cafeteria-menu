'use strict';
// 공개 저장소·배포 파일에 회사별 접속 정보, 실제 메뉴, 이 기기의 경로가 들어가지 않았는지 검사한다.
// 검사어는 git에 올리지 않는 profile.local.json / local/acceptance.json과 현재 사용자 홈 경로에서 만든다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');

function leaves(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => leaves(x, out));
  else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => (leaves(k, out), leaves(x, out)));
  return out;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** 공개되면 안 되는 문자열 목록 */
function privateTerms() {
  const terms = new Set();
  const local = readJson(path.join(root, 'profile.local.json'));
  if (local) {
    const pub = new Set(leaves(readJson(path.join(root, 'profile.example.json')) || {}));
    const generic = /^(\{\w+\}|ko|id|password|name|baseUrl|login|board|fields|errorCodes|user_unknown|auth_failed|pagePath|submitPath|orgLookupPath|loginIdSuffix|sessionExpiredMarkers|extraAuthMarkers|listPath|articlePath|articleIdParam|titleKeyword|frameNames|editorDataIds|loginId|inputId|loginPwd)$/;
    for (const s of leaves(local)) {
      if (pub.has(s) || generic.test(s) || s.length < 5) continue;
      terms.add(s);
      try {
        const u = new URL(s, 'https://placeholder.invalid');
        if (u.hostname !== 'placeholder.invalid') terms.add(u.hostname);
        if (u.pathname.length > 4) terms.add(u.pathname);
        for (const [, v] of u.searchParams) if (v.length >= 8 && !v.includes('{')) terms.add(v);
      } catch {
        /* URL 아님 */
      }
    }
  }
  const acc = readJson(path.join(root, 'local', 'acceptance.json'));
  if (acc) {
    for (const c of acc.checks || []) for (const w of c.contains || []) if (w.length >= 3) terms.add(w);
    if (acc.png) terms.add(path.dirname(acc.png));
  }
  const home = os.homedir();
  if (home && home.length > 3) terms.add(home);
  terms.add(['', 'private', 'tmp', 'claude-'].join('/')); // 작업 도구의 임시 폴더 경로
  return [...terms];
}

/** git에 올라갈 파일(추적 중 + 무시되지 않은 새 파일) */
function committableFiles() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  return out.split('\0').filter(Boolean).filter((f) => fs.existsSync(path.join(root, f)));
}

const TEXT = /\.(js|json|md|html|css|ps1|swift|yml|yaml|txt|plist|xml)$|^\.gitignore$|LICENSE/i;

/** 파일 목록에서 검사어가 보이는 위치 */
function scan(files, terms, { base = root, readFile = (f) => fs.readFileSync(path.join(base, f)) } = {}) {
  const hits = [];
  for (const f of files) {
    if (!TEXT.test(path.basename(f)) || /package-lock\.json$/.test(f)) continue;
    const text = readFile(f).toString('utf8');
    for (const t of terms) if (text.includes(t)) hits.push({ file: f, term: t });
  }
  return hits;
}

module.exports = { privateTerms, committableFiles, scan };

if (require.main === module) {
  const terms = privateTerms();
  const hits = scan(committableFiles(), terms);
  console.log(`검사어 ${terms.length}개, 공개 대상 파일 검사`);
  for (const h of hits) console.log(`✘ ${h.file}: 비공개 문자열 포함`);
  if (!hits.length) console.log('✔ 공개 대상 파일에 비공개 정보 없음');
  process.exit(hits.length ? 1 : 0);
}
