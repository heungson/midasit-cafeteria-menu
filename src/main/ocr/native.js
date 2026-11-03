'use strict';
// 운영체제 기본 OCR(macOS Vision / Windows.Media.Ocr) 실행기.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

class NativeOcrError extends Error {
  constructor(code, msg) {
    super(msg);
    this.name = 'NativeOcrError';
    this.code = code; // unavailable | korean_unsupported | failed
  }
}

function resourceDirs() {
  const dirs = [];
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'native'));
  const root = path.join(__dirname, '..', '..', '..');
  dirs.push(path.join(root, 'build', 'native', 'mac'), path.join(root, 'native', 'win'));
  return dirs;
}

function locate(platform = process.platform) {
  const name = platform === 'darwin' ? 'vision-ocr' : platform === 'win32' ? 'win-ocr.ps1' : null;
  if (!name) return null;
  for (const d of resourceDirs()) {
    const p = path.join(d, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function engineName(platform = process.platform) {
  return platform === 'darwin' ? 'vision' : platform === 'win32' ? 'winocr' : null;
}

/**
 * 이미지 버퍼 묶음을 OCR한다. 임시 폴더에 쓰고, 끝나면 지운다.
 * @returns {Promise<{width:number,height:number,lines:{text,x,y,w,h,conf}[]}[]>}
 */
async function recognize(buffers, { platform = process.platform, timeoutMs = 120000 } = {}) {
  const tool = locate(platform);
  if (!tool) throw new NativeOcrError('unavailable', '이 기기에서 사용할 수 있는 기본 OCR 도구가 없습니다');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cafeteria-native-'));
  try {
    const files = buffers.map((b, i) => {
      const f = path.join(dir, `cell-${String(i).padStart(3, '0')}.png`);
      fs.writeFileSync(f, b);
      return f;
    });
    const [cmd, args] =
      platform === 'win32'
        ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tool, ...files]]
        : [tool, files];
    const stdout = await new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, out, errOut) => {
        if (err) {
          if (err.code === 3 || /korean_unsupported/.test(errOut || '')) {
            return reject(new NativeOcrError('korean_unsupported', '한국어 OCR을 지원하지 않습니다(Windows: 설정 > 언어에서 한국어 추가)'));
          }
          return reject(new NativeOcrError('failed', `기본 OCR 실패: ${(errOut || err.message).trim().slice(0, 300)}`));
        }
        resolve(out);
      });
    });
    const pages = JSON.parse(stdout.replace(/^﻿/, ''));
    return (Array.isArray(pages) ? pages : [pages]).map((p) => ({ ...p, lines: p.lines || [] }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { recognize, locate, engineName, NativeOcrError };
