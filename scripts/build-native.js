#!/usr/bin/env node
'use strict';
// macOS Vision OCR 도우미를 arm64/x64 유니버설 바이너리로 빌드한다(macOS에서만).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'build', 'native', 'mac');
if (process.platform !== 'darwin') {
  console.log('macOS가 아니므로 Vision 도우미 빌드를 건너뜁니다');
  process.exit(0);
}
fs.mkdirSync(outDir, { recursive: true });
const src = path.join(root, 'native', 'mac', 'vision-ocr.swift');
const parts = [];
for (const arch of ['arm64', 'x86_64']) {
  const out = path.join(outDir, `vision-ocr-${arch}`);
  execFileSync('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos11`, src, '-o', out], { stdio: 'inherit' });
  parts.push(out);
}
const universal = path.join(outDir, 'vision-ocr');
execFileSync('lipo', ['-create', ...parts, '-output', universal], { stdio: 'inherit' });
parts.forEach((p) => fs.rmSync(p));
console.log('빌드 완료:', path.relative(root, universal));
