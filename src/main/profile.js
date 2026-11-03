'use strict';
// 그룹웨어 접속 프로필. 회사별 값(호스트, 게시판 ID, 로그인 경로, 계정 접미사 등)은
// 공개 소스에 두지 않고 사용자 데이터 폴더의 profile.json(설치 앱) 또는
// 저장소의 profile.local.json(개발용, git 제외)에서만 읽는다.
const fs = require('fs');
const path = require('path');

const PROFILE_FILE = 'profile.json';

function profileCandidates({ userDataDir, appRoot, env = process.env }) {
  const list = [];
  if (env.CAFETERIA_PROFILE) list.push(env.CAFETERIA_PROFILE);
  if (userDataDir) list.push(path.join(userDataDir, PROFILE_FILE));
  if (appRoot) list.push(path.join(appRoot, 'profile.local.json'));
  return list;
}

function loadProfile(opts) {
  for (const p of profileCandidates(opts)) {
    if (!p || !fs.existsSync(p)) continue;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { profile: validateProfile(raw), file: p };
  }
  return { profile: null, file: null };
}

class ProfileError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ProfileError';
  }
}

function requireString(obj, key, where) {
  if (typeof obj?.[key] !== 'string' || !obj[key]) throw new ProfileError(`프로필의 ${where}${key} 값이 없습니다`);
  return obj[key];
}

function validateProfile(raw) {
  const base = new URL(requireString(raw, 'baseUrl', ''));
  if (base.protocol !== 'https:' && !raw.allowInsecureHttp) {
    throw new ProfileError('baseUrl은 https 주소여야 합니다');
  }
  const login = raw.login || {};
  requireString(login, 'submitPath', 'login.');
  if (!login.fields || typeof login.fields !== 'object') throw new ProfileError('login.fields가 없습니다');
  const board = raw.board || {};
  requireString(board, 'listPath', 'board.');
  requireString(board, 'articlePath', 'board.');
  if (!board.articlePath.includes('{id}')) throw new ProfileError('board.articlePath에 {id} 자리표시자가 필요합니다');
  return {
    name: raw.name || base.host,
    baseUrl: base.origin,
    allowInsecureHttp: !!raw.allowInsecureHttp,
    login: {
      pagePath: login.pagePath || '/',
      submitPath: login.submitPath,
      orgLookupPath: login.orgLookupPath || null,
      loginIdSuffix: login.loginIdSuffix || '',
      fields: login.fields,
      errorCodes: login.errorCodes || {},
      sessionExpiredMarkers: login.sessionExpiredMarkers || [],
      extraAuthMarkers: login.extraAuthMarkers || ['OTP', '2차 인증', '추가 인증', '인증번호'],
    },
    board: {
      listPath: board.listPath,
      articlePath: board.articlePath,
      articleIdParam: board.articleIdParam || 'id',
      titleKeyword: board.titleKeyword || '',
      frameNames: board.frameNames || [],
      editorDataIds: board.editorDataIds || [],
    },
  };
}

function installProfile(srcFile, userDataDir) {
  const raw = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
  validateProfile(raw);
  fs.mkdirSync(userDataDir, { recursive: true });
  const dest = path.join(userDataDir, PROFILE_FILE);
  fs.writeFileSync(dest, JSON.stringify(raw, null, 2), { mode: 0o600 });
  return dest;
}

module.exports = { loadProfile, validateProfile, installProfile, profileCandidates, ProfileError, PROFILE_FILE };
