#!/usr/bin/env node
'use strict';
// 접속 프로필을 설치된 앱의 사용자 데이터 폴더에 복사한다(앱의 '프로필 파일 가져오기'와 같은 동작).
//   node scripts/install-profile.js [프로필 경로, 기본 profile.local.json]
const os = require('os');
const path = require('path');
const { installProfile } = require('../src/main/profile');

function userDataDir() {
  const name = 'CafeteriaMenu'; // src/main/main.js의 DATA_DIR_NAME과 같아야 한다
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), name);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
}

const src = path.resolve(process.argv[2] || path.join(__dirname, '..', 'profile.local.json'));
const dest = installProfile(src, userDataDir());
console.log(`프로필 설치 완료: ${dest}`);
