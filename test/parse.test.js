'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/main/gw/parse');

test('게시판 HTML 목록: 제목 키워드와 기간이 있는 글만, onclick/링크에서 ID 추출', () => {
  const html = `<table>
    <tr><td><a href="/view?no=5">공지사항</a></td></tr>
    <tr><td><a href="#" onclick="fnView('12')">(3/4~ 3/8) 주간 식단표</a></td></tr>
    <tr><td><a href="/view?type=A&amp;no=11&amp;bid=T">(2/25~ 3/1) 주간 식단표</a></td></tr>
    <tr><td><a href="/view?no=13">(3/4~ 3/8) 다른 게시물</a></td></tr>
  </table>`;
  const items = P.parseBoardList(html, { articleIdParam: 'no', titleKeyword: '주간 식단표' });
  assert.deepEqual(items, [
    { id: '12', title: '(3/4~ 3/8) 주간 식단표' },
    { id: '11', title: '(2/25~ 3/1) 주간 식단표' },
  ]);
});

test('게시판 JSON 목록도 지원', () => {
  const json = JSON.stringify({ rows: [{ no: 21, subject: '(3/11~3/15) 주간 식단표' }, { no: 22, subject: '공지' }] });
  assert.deepEqual(P.parseBoardList(json, { articleIdParam: 'no', titleKeyword: '주간 식단표' }), [{ id: '21', title: '(3/11~3/15) 주간 식단표' }]);
});

test('이번 주 게시물 선택: 같은 주에 여러 개면 가장 최근 글', () => {
  const items = [
    { id: '10', title: '(2/25~ 3/1) 주간 식단표' },
    { id: '11', title: '(3/4~ 3/8) 주간 식단표' },
    { id: '14', title: '(3/4~ 3/8) 주간 식단표(수정)' },
  ];
  const { article, latest } = P.pickWeekArticle(items, '2030-03-04', '2030-03-05');
  assert.equal(article.id, '14');
  assert.equal(latest.range.start, '2030-03-04');
  assert.equal(P.pickWeekArticle(items, '2030-03-11', '2030-03-12').article, null);
});

test('프레임 주소: 속성·스크립트 문자열에서 찾고, 빈 쿼리 값은 래퍼 주소에서 채움, 위험 경로 제외', () => {
  const html = `<iframe id="ad" src="https://evil.example/ad"></iframe><iframe name="bodyFrame" src="about:blank"></iframe>
    <script>function d(){ location.href='/board/delete.hi?no=' + no; }
    $('#bodyFrame').attr('src', '/board/body.hi?no=&bid=T');</script>`;
  const urls = P.findFrameUrls(html, { frameNames: ['bodyFrame'], docUrl: 'https://gw.test/board/view.hi?type=W&no=7&bid=T' });
  assert.deepEqual(urls.map((u) => u.url), ['https://gw.test/board/body.hi?no=7&bid=T']);
});

test('에디터 본문: textarea(이스케이프), hidden input, JS 문자열 형태', () => {
  const a = P.findEditorHtml('<textarea id="ED">&lt;img src=&quot;/f/a.png&quot;&gt;</textarea>', ['ED']);
  assert.deepEqual(P.findImages(a[0]), ['/f/a.png']);
  const b = P.findEditorHtml('<input type="hidden" name="ED" value="&lt;p&gt;&lt;img src=\'/f/b.png\'&gt;">', ['ED']);
  assert.deepEqual(P.findImages(b[0]), ['/f/b.png']);
  const c = P.findEditorHtml(`<script>var ED = '\\u003cimg src=\\"/f/c.png\\"\\u003e';</script>`, ['ED']);
  assert.deepEqual(P.findImages(c[0]), ['/f/c.png']);
  // PNG 우선
  assert.deepEqual(P.findImages('<img src="/x.gif"><img src="/y.png">'), ['/y.png', '/x.gif']);
});

test('로그인 오류 코드 인식', () => {
  const codes = { E100: 'user_unknown', E200: 'auth_failed' };
  assert.deepEqual(P.findLoginError("if ('E200' == 'E200') alert(1)", codes), { code: 'E200', kind: 'auth_failed' });
  assert.equal(P.findLoginError("if ('E200' == '') alert(1); var message = '';", codes), null);
  assert.equal(P.findLoginError("var message = '잠긴 계정입니다<BR>문의';", codes).message, '잠긴 계정입니다 문의');
});

test('이미지 형식 확인', () => {
  assert.equal(P.sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0])), 'image/png');
  assert.equal(P.sniffImage(Buffer.from('<html>')), null);
});
