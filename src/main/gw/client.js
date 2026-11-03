'use strict';
// 그룹웨어 로그인 → 게시판 목록 → 이번 주 게시물 → 본문 프레임 → 메뉴 이미지 다운로드.
const crypto = require('crypto');
const { Session, GwError } = require('./http');
const P = require('./parse');

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_FRAME_FETCHES = 8;

class GroupwareClient {
  constructor(profile, opts = {}) {
    this.profile = profile;
    this.opts = opts;
    this.session = new Session(profile.baseUrl, opts);
    this.loggedIn = false;
  }

  isSessionExpired(res) {
    const body = res.text();
    const markers = this.profile.login.sessionExpiredMarkers;
    return markers.some((m) => body.includes(m)) || (this.isLoginPage(res.url) && P.hasPasswordForm(body));
  }

  isLoginPage(url) {
    const u = new URL(url);
    return u.pathname === new URL(this.profile.login.pagePath, this.profile.baseUrl).pathname;
  }

  /** 로그인 화면의 스크립트와 같은 방식으로 계정 도메인을 정한다 */
  async resolveLoginId(input, loginPageHtml) {
    const { login } = this.profile;
    if (input.includes('@')) return { loginId: input, source: 'input' };
    if (login.orgLookupPath && loginPageHtml.includes(login.orgLookupPath)) {
      const host = new URL(this.profile.baseUrl).hostname;
      const sub = host.includes('.') ? host.slice(0, host.indexOf('.')) : '';
      if (sub) {
        try {
          const res = await this.session.request(login.orgLookupPath, { method: 'POST', form: { org_cd: sub } });
          const info = JSON.parse(res.text()).orgInfo;
          if (info && info.org_mail_domain) return { loginId: `${input}@${info.org_mail_domain}`, source: 'orgLookup' };
        } catch (e) {
          if (e.code === 'offline') throw e;
        }
      }
    }
    if (login.loginIdSuffix) return { loginId: input + login.loginIdSuffix, source: 'profile' };
    return { loginId: input, source: 'input' };
  }

  async login({ username, password }) {
    if (!username || !password) throw new GwError('auth_required', '계정 정보가 없습니다');
    const { login } = this.profile;
    const page = await this.session.request(login.pagePath);
    const { loginId } = await this.resolveLoginId(username, page.text());
    const vars = { input: username, loginId, password };
    const form = {};
    for (const [k, tmpl] of Object.entries(login.fields)) {
      form[k] = String(tmpl).replace(/\{(input|loginId|password)\}/g, (_, v) => vars[v]);
    }
    const res = await this.session.request(login.submitPath, { method: 'POST', form });
    const html = res.text();
    const err = P.findLoginError(html, login.errorCodes);
    if (err) {
      throw new GwError(err.kind === 'user_unknown' ? 'auth_user_unknown' : 'auth_failed', err.message || '아이디 또는 비밀번호가 올바르지 않습니다', { serverCode: err.code });
    }
    if (this.isLoginPage(res.url) && P.hasPasswordForm(html)) {
      throw new GwError('auth_failed', '로그인 화면으로 되돌아왔습니다. 계정 정보를 확인해 주세요');
    }
    // 추가 인증 여부는 실제로 세션이 동작하지 않을 때만 판단한다(포털 화면에도 'OTP' 같은 글자가 있을 수 있음)
    this.lastLoginHtml = html;
    this.loggedIn = true;
  }

  failureAfterLogin() {
    const html = this.lastLoginHtml || '';
    if (this.profile.login.extraAuthMarkers.some((m) => html.includes(m)) && /<input/i.test(html)) {
      return new GwError('extra_auth', '추가 인증(OTP 등)이 필요한 계정입니다');
    }
    return new GwError('auth_failed', '로그인 후에도 게시판에 접근할 수 없습니다');
  }

  /** 로그인 세션이 만료되면 한 번 다시 로그인한다 */
  async getAuthed(path, creds, opts = {}) {
    let fresh = false;
    if (!this.loggedIn) {
      await this.login(creds);
      fresh = true;
    }
    let res = await this.session.request(path, opts);
    if (this.isSessionExpired(res) && !fresh) {
      this.loggedIn = false;
      await this.login(creds);
      res = await this.session.request(path, opts);
    }
    if (this.isSessionExpired(res)) {
      this.loggedIn = false;
      throw this.failureAfterLogin();
    }
    return res;
  }

  async listWeeklyPosts(creds) {
    const res = await this.getAuthed(this.profile.board.listPath, creds);
    return P.parseBoardList(res.text(), this.profile.board);
  }

  /**
   * 게시물 본문의 이미지들을 내려받는다.
   * @returns {{images:{buf:Buffer,type:string,sha256:string}[], sha256:string, trail:string[]}}
   */
  async fetchArticleImages(articleId, creds) {
    const { board } = this.profile;
    const path = board.articlePath.replace('{id}', encodeURIComponent(articleId));
    const first = await this.getAuthed(path, creds);
    const queue = [{ res: first, depth: 0 }];
    const visited = new Set([first.url]);
    const trail = [];
    let fetches = 0;
    while (queue.length) {
      const { res, depth } = queue.shift();
      const html = res.text();
      trail.push(new URL(res.url).pathname);
      const editor = P.findEditorHtml(html, board.editorDataIds);
      const imgSrcs = (editor.length ? editor.flatMap(P.findImages) : depth > 0 ? P.findImages(html) : []).slice(0, 5);
      if (imgSrcs.length) {
        const images = [];
        for (const src of imgSrcs) {
          const img = await this.downloadImage(src, res.url, creds);
          if (img) images.push(img);
        }
        if (images.length) {
          const h = crypto.createHash('sha256');
          images.forEach((i) => h.update(i.sha256));
          return { images, sha256: h.digest('hex'), trail };
        }
      }
      if (depth >= 3) continue;
      for (const c of P.findFrameUrls(html, { frameNames: board.frameNames, docUrl: res.url })) {
        if (fetches >= MAX_FRAME_FETCHES || visited.has(c.url) || !this.session.isSameOrigin(c.url)) continue;
        visited.add(c.url);
        fetches++;
        const next = await this.getAuthed(c.url, creds);
        queue.push({ res: next, depth: depth + 1 });
      }
    }
    throw new GwError('image_missing', '게시물에서 메뉴 이미지를 찾지 못했습니다', { trail });
  }

  async downloadImage(src, docUrl, creds) {
    let buf;
    if (/^data:image\/(png|jpeg);base64,/i.test(src)) {
      buf = Buffer.from(src.slice(src.indexOf(',') + 1), 'base64');
    } else {
      if (!this.session.isSameOrigin(src, docUrl)) return null;
      const res = await this.getAuthed(new URL(src, docUrl).href, creds);
      buf = res.body;
    }
    if (buf.length > MAX_IMAGE_BYTES) return null;
    const type = P.sniffImage(buf);
    if (!type) return null;
    return { buf, type, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  }
}

module.exports = { GroupwareClient, GwError };
