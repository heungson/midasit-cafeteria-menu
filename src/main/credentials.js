'use strict';
// 계정과 비밀번호는 macOS Keychain / Windows Credential Manager에만 저장한다.
// 항목은 그룹웨어 호스트별로 나눠, 프로필의 주소가 바뀌어도 다른 서버로 계정이 전송되지 않게 한다.

const SERVICE = 'cafeteria-menu.groupware';

function loadKeyring() {
  // 네이티브 모듈은 실제 사용 시점에만 불러온다(테스트에서 대체 가능)
  return require('@napi-rs/keyring');
}

class CredentialStore {
  constructor({ keyring = null, service = SERVICE } = {}) {
    this.keyring = keyring;
    this.service = service;
  }

  entry(host) {
    const k = this.keyring || (this.keyring = loadKeyring());
    return new k.Entry(this.service, host);
  }

  get(host) {
    const raw = this.entry(host).getPassword();
    if (!raw) return null;
    try {
      const { u, p } = JSON.parse(raw);
      return u && p ? { username: u, password: p } : null;
    } catch {
      return null;
    }
  }

  set(host, { username, password }) {
    if (!username || !password) throw new Error('아이디와 비밀번호를 모두 입력해 주세요');
    this.entry(host).setPassword(JSON.stringify({ u: username, p: password }));
  }

  /** 화면에 보여줄 수 있는 정보만(비밀번호 제외) */
  describe(host) {
    const c = this.get(host);
    return c ? { saved: true, username: c.username } : { saved: false };
  }

  clear(host) {
    try {
      return this.entry(host).deletePassword();
    } catch {
      return false;
    }
  }
}

module.exports = { CredentialStore, SERVICE };
