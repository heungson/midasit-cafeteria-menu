'use strict';
// 테스트용 가짜 그룹웨어. 경로·필드 이름은 모두 임의 값이며 실제 서비스와 무관하다.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PNG = fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'synthetic-week.png'));

function profileFor(port, extra = {}) {
  return {
    name: '테스트 그룹웨어',
    baseUrl: `http://127.0.0.1:${port}`,
    allowInsecureHttp: true,
    login: {
      pagePath: '/login',
      submitPath: '/login/submit',
      orgLookupPath: '/org/lookup',
      fields: { userInput: '{input}', user: '{loginId}', pw: '{password}', lang: 'ko' },
      errorCodes: { E100: 'user_unknown', E200: 'auth_failed' },
      sessionExpiredMarkers: ['/login?expired=1'],
    },
    board: {
      listPath: '/board/list?bid=TEST',
      articlePath: '/board/view?type=WRAP&no={id}&bid=TEST',
      articleIdParam: 'no',
      titleKeyword: '주간 식단표',
      frameNames: ['bodyFrame'],
      editorDataIds: ['EDITOR_BODY'],
    },
    ...extra,
  };
}

const EXPIRED = `<!DOCTYPE html><html><head><script>
  try { top.location.href = '/login?expired=1'; } catch (e) { top.location.href = '/login?expired=1'; }
</script></head><body></body></html>`;

function loginPage(code = '') {
  return `<!DOCTYPE html><html><head><script>
    var message = '';
    $.ajax({ url: '/org/lookup', type: 'POST' });
    if ('${code}' != '') {
      if ('E100' == '${code}') alert('없는 사용자');
      else if ('E200' == '${code}') alert('비밀번호 확인');
    }
  </script></head><body><form id="f"><input name="userInput"><input type="password" name="pw"></form></body></html>`;
}

/**
 * opts: { orgDomain, users: {loginId: {password, otp}}, posts: [{no,title}], image, expireAfter }
 */
function startFakeGw(opts = {}) {
  const state = {
    orgDomain: opts.orgDomain ?? 'example.test',
    users: opts.users || { 'kim@example.test': { password: 'pw' } },
    posts: opts.posts || [
      { no: '10', title: '(2/25~ 3/1) 주간 식단표' },
      { no: '11', title: '(3/4~ 3/8) 주간 식단표' },
    ],
    image: opts.image || PNG,
    sessions: new Map(), // sid -> 남은 요청 수
    log: [],
    loginAttempts: 0,
    lastLoginForm: null,
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      state.log.push(`${req.method} ${u.pathname}${u.search}`);
      const sid = /SID=([^;]+)/.exec(req.headers.cookie || '')?.[1];
      const authed = sid && state.sessions.has(sid) && state.sessions.get(sid) !== 0;
      if (authed && state.sessions.get(sid) > 0) state.sessions.set(sid, state.sessions.get(sid) - 1);
      const html = (s, status = 200, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
        res.end(s);
      };
      const redirect = (loc, headers = {}) => {
        res.writeHead(302, { Location: loc, ...headers });
        res.end();
      };
      const p = u.pathname;
      if (p === '/login') return html(loginPage(u.searchParams.get('error') || ''), 200, { 'Set-Cookie': 'PRE=1; Path=/' });
      if (p === '/org/lookup' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
        return res.end(JSON.stringify({ orgInfo: state.orgDomain ? { org_mail_domain: state.orgDomain } : '' }));
      }
      if (p === '/login/submit' && req.method === 'POST') {
        state.loginAttempts++;
        const f = Object.fromEntries(new URLSearchParams(body));
        state.lastLoginForm = f;
        const user = state.users[f.user];
        if (!user) return redirect('/login?error=E100');
        if (user.password !== f.pw) return redirect('/login?error=E200');
        if (user.otp) return html('<html><body><h1>추가 인증</h1><form><input name="otp"></form></body></html>');
        const newSid = `s${state.loginAttempts}`;
        state.sessions.set(newSid, opts.expireAfter ?? -1);
        return redirect('/main', { 'Set-Cookie': `SID=${newSid}; Path=/; HttpOnly` });
      }
      if (p === '/elsewhere') return redirect('https://evil.example/steal');
      if (!authed) return html(EXPIRED);
      if (p === '/main') return html('<html><body>main</body></html>');
      if (p === '/board/list') {
        const rows = state.posts
          .map((x) => `<tr><td>${x.no}</td><td><a href="javascript:void(0)" onclick="fnView('${x.no}')">${x.title}</a></td></tr>`)
          .join('');
        return html(`<table><tr><th>번호</th><th>제목</th></tr><tr><td>1</td><td>공지사항 안내</td></tr>${rows}</table>`);
      }
      if (p === '/board/view') {
        const no = u.searchParams.get('no');
        return html(`<html><head><script>
          var no = '${no}';
          function del() { location.href = '/board/delete?no=' + no; }
          $(function () { $('#bodyFrame').attr('src', '/board/body?no=&bid=TEST'); });
        </script></head><body>
          <iframe id="adFrame" src="https://evil.example/ad"></iframe>
          <iframe id="bodyFrame" name="bodyFrame" src="about:blank"></iframe></body></html>`);
      }
      if (p === '/board/delete') {
        state.deleted = true;
        return html('deleted');
      }
      if (p === '/board/body') {
        const no = u.searchParams.get('no');
        if (!state.posts.some((x) => x.no === no)) return html('<html><body>없는 글</body></html>', 404);
        return html(`<html><body><textarea id="EDITOR_BODY" style="display:none">&lt;p&gt;&lt;img src=&quot;/files/menu-${no}.png&quot; width=&quot;800&quot;&gt;&lt;/p&gt;</textarea></body></html>`);
      }
      if (p.startsWith('/files/')) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(state.image);
      }
      html('not found', 404);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ port, state, profile: profileFor(port), close: () => new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      }) });
    }),
  );
}

module.exports = { startFakeGw, profileFor, PNG };
