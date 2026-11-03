#!/usr/bin/env node
'use strict';
// 빌드된 앱 묶음(dist/)을 검사한다.
//  - app.asar에 로컬 프로필·검증 자산·테스트·스크립트가 없는지
//  - 패키지 안 모든 텍스트에 비공개 문자열(회사 접속 정보, 실제 메뉴, 기기 경로)이 없는지
//  - 기본 OCR 도우미와 키링 네이티브 모듈이 들어 있는지
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');
const { privateTerms, scan } = require('./leak-check');

const dist = path.join(__dirname, '..', 'dist');
function findAll(dir, name, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.name === name) out.push(p);
    else if (e.isDirectory() && !e.isSymbolicLink()) findAll(p, name, out);
  }
  return out;
}

const archives = findAll(dist, 'app.asar');
if (!archives.length) {
  console.error('dist/에서 app.asar를 찾지 못했습니다. 먼저 pack:mac 또는 pack:win을 실행하세요');
  process.exit(2);
}
const terms = privateTerms();
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '✔' : '✘'} ${m}`);
  if (!c) fail++;
};

for (const archive of archives) {
  const rel = path.relative(dist, archive);
  console.log(`\n[${rel}]`);
  const files = asar.listPackage(archive).map((f) => f.replace(/\\/g, '/').replace(/^\//, ''));
  const forbidden = files.filter((f) => /(^|\/)(profile\.local\.json|profile\.json|acceptance\.json)$|^(local|test|scripts|dist)\/|\.test\.js$|synthetic-week\.png$/.test(f));
  ok(!forbidden.length, `금지 파일 없음${forbidden.length ? `: ${forbidden.join(', ')}` : ''}`);
  ok(files.includes('src/main/main.js') && files.includes('src/renderer/index.html'), '앱 소스 포함');
  ok(files.includes('fixtures/demo-week.json'), '합성 데모 데이터 포함');
  const hits = scan(files.filter((f) => !f.startsWith('node_modules/')).concat(files.filter((f) => f.startsWith('node_modules/') && /\.(js|json)$/.test(f))), terms, {
    readFile: (f) => {
      try {
        return asar.extractFile(archive, f);
      } catch {
        return Buffer.alloc(0);
      }
    },
  });
  ok(!hits.length, `비공개 문자열 없음(검사어 ${terms.length}개)${hits.length ? `: ${[...new Set(hits.map((h) => h.file))].join(', ')}` : ''}`);
  const resources = path.dirname(archive);
  const unpacked = `${archive}.unpacked`;
  const nodeFiles = findAll(unpacked, 'node_modules').length ? fs.readdirSync(path.join(unpacked, 'node_modules', '@napi-rs')).filter((d) => d.startsWith('keyring-')) : [];
  ok(nodeFiles.length > 0, `키링 네이티브 모듈 포함(${nodeFiles.join(', ') || '없음'})`);
  const ocrTool = ['vision-ocr', 'win-ocr.ps1'].map((n) => path.join(resources, 'native', n)).find((p) => fs.existsSync(p));
  ok(!!ocrTool, `기본 OCR 도우미 포함(${ocrTool ? path.basename(ocrTool) : '없음'})`);
  // 리소스 폴더의 다른 텍스트 파일도 검사
  const extra = fs.readdirSync(resources).filter((f) => /\.(json|txt|plist|yml)$/i.test(f));
  ok(!scan(extra, terms, { base: resources }).length, '리소스 폴더 텍스트에 비공개 문자열 없음');
}
console.log(fail ? `\n${fail}개 실패` : '\n패키지 검사 통과');
process.exit(fail ? 1 : 0);
