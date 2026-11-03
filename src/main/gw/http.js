'use strict';
// 그룹웨어 전용 HTTP 세션. 쿠키는 메모리에만 두고, 리다이렉트는 같은 출처(origin)일 때만 따라간다.

const MAX_REDIRECTS = 6;
const DEFAULT_TIMEOUT_MS = 15000;
const NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'CERT_HAS_EXPIRED',
]);

class GwError extends Error {
  /** code: offline | auth_failed | auth_user_unknown | extra_auth | session_expired | not_posted | server_error | unexpected */
  constructor(code, msg, extra = {}) {
    super(msg);
    this.name = 'GwError';
    this.code = code;
    Object.assign(this, extra);
  }
}

class Session {
  constructor(baseUrl, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.origin = new URL(baseUrl).origin;
    this.cookies = new Map();
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  url(pathOrUrl, base) {
    const u = new URL(pathOrUrl, base || this.origin);
    if (u.origin !== this.origin) throw new GwError('unexpected', '다른 출처로의 이동은 허용하지 않습니다', { url: u.origin });
    return u;
  }

  isSameOrigin(pathOrUrl, base) {
    try {
      return new URL(pathOrUrl, base || this.origin).origin === this.origin;
    } catch {
      return false;
    }
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeCookies(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const [pair, ...attrs] = c.split(';');
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a)) || value === '';
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  /**
   * 요청을 보내고 같은 출처 리다이렉트만 따라간다. POST 후 302/303은 GET으로 바뀐다.
   * @returns {{status:number,url:string,headers:Headers,body:Buffer,text:()=>string}}
   */
  async request(pathOrUrl, { method = 'GET', form = null, headers = {}, base } = {}) {
    let url = this.url(pathOrUrl, base);
    let body = form ? new URLSearchParams(form).toString() : undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const h = { 'User-Agent': 'Mozilla/5.0 (CafeteriaMenu)', Accept: '*/*', ...headers };
      if (this.cookies.size) h.Cookie = this.cookieHeader();
      if (body !== undefined) h['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      let res;
      try {
        res = await this.fetch(url.href, { method, headers: h, body, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        throw classifyNetworkError(err);
      }
      this.storeCookies(res);
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location'), url);
        if (next.origin !== this.origin) {
          throw new GwError('unexpected', '다른 출처로 리다이렉트되어 중단했습니다', { url: next.origin });
        }
        url = next;
        if (res.status !== 307 && res.status !== 308) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.status >= 500) throw new GwError('server_error', `그룹웨어 서버 오류(${res.status})`);
      return { status: res.status, url: url.href, headers: res.headers, body: buf, text: () => decodeText(buf, res.headers) };
    }
    throw new GwError('unexpected', '리다이렉트가 너무 많습니다');
  }
}

function decodeText(buf, headers) {
  const ct = headers.get('content-type') || '';
  const m = /charset=([\w-]+)/i.exec(ct);
  const charset = (m && m[1].toLowerCase()) || 'utf-8';
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

function classifyNetworkError(err) {
  const code = err?.cause?.code || err?.code;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || NETWORK_CODES.has(code) || err instanceof TypeError) {
    return new GwError('offline', '그룹웨어에 연결할 수 없습니다(사내망/VPN 확인)', { cause: code || err?.name });
  }
  return new GwError('unexpected', err?.message || String(err));
}

module.exports = { Session, GwError, classifyNetworkError };
