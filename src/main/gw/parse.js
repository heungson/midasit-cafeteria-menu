'use strict';
// 그룹웨어 HTML을 실행하지 않고 문자열로만 해석한다.
// 스크립트는 절대 실행하지 않으며, 스크립트 안의 문자열 리터럴에서 같은 출처 경로만 후보로 뽑는다.
const { parseTitleRange } = require('../menu/week');

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITY[e.toLowerCase()] ?? m;
  });
}

function decodeJsString(s) {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([\\/'"])/g, '$1')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\\t/g, '\t');
}

function stripTags(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : null;
}

/** 로그인 응답에 실린 오류 코드/메시지를 찾는다. 템플릿이 `'코드' == '코드'`로 채워지는 형태를 인식 */
function findLoginError(html, errorCodes = {}) {
  for (const [code, kind] of Object.entries(errorCodes)) {
    const esc = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`['"]${esc}['"]\\s*==\\s*['"]${esc}['"]`).test(html)) return { code, kind };
  }
  const msg = /var\s+message\s*=\s*'([^']+)'/.exec(html);
  if (msg && msg[1].trim()) return { code: null, kind: 'auth_failed', message: decodeJsString(msg[1]).replace(/<br\s*\/?>/gi, ' ') };
  return null;
}

function hasPasswordForm(html) {
  return /<input[^>]+type\s*=\s*["']?password/i.test(html);
}

/**
 * 게시판 목록에서 주간 게시물 후보를 찾는다. HTML 표/목록과 JSON 응답을 모두 지원.
 * @returns {{id:string,title:string}[]}
 */
function parseBoardList(body, { articleIdParam = 'id', titleKeyword = '' } = {}) {
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return dedupe(fromJson(JSON.parse(trimmed), articleIdParam, titleKeyword));
    } catch {
      /* HTML로 계속 */
    }
  }
  const out = [];
  const chunks = body.split(/<(?=tr[\s>]|li[\s>]|dl[\s>])/i);
  const idRe = [
    new RegExp(`${articleIdParam}=(\\d+)`),
    new RegExp(`${articleIdParam}["']?\\s*[:=]\\s*["']?(\\d+)`),
  ];
  for (const chunk of chunks) {
    const text = stripTags('<' + chunk);
    if (!isWeeklyTitle(text, titleKeyword)) continue;
    let id = null;
    for (const re of idRe) {
      const m = re.exec(chunk);
      if (m) {
        id = m[1];
        break;
      }
    }
    // onclick="openArticle('123')" 같은 함수 인자(javascript:void(0)은 제외)
    if (!id) {
      const handlers = [...chunk.matchAll(/\bon\w+\s*=\s*("([^"]*)"|'([^']*)')|href\s*=\s*["']javascript:([^"']*)/gi)].map((m) => m[2] ?? m[3] ?? m[4] ?? '');
      for (const h of handlers) {
        const m = /(?<!void)\(\s*['"]?(\d{1,10})['"]?\s*[,)]/.exec(h);
        if (m) {
          id = m[1];
          break;
        }
      }
    }
    if (id) out.push({ id, title: extractTitle(text, titleKeyword) });
  }
  return dedupe(out);
}

function fromJson(node, idParam, kw, out = []) {
  if (Array.isArray(node)) node.forEach((n) => fromJson(n, idParam, kw, out));
  else if (node && typeof node === 'object') {
    const titleKey = Object.keys(node).find((k) => typeof node[k] === 'string' && isWeeklyTitle(node[k], kw));
    const idVal = node[idParam] ?? node.articleNum ?? node.article_id ?? node.id;
    if (titleKey && idVal != null) out.push({ id: String(idVal), title: node[titleKey].trim() });
    Object.values(node).forEach((v) => typeof v === 'object' && fromJson(v, idParam, kw, out));
  }
  return out;
}

function isWeeklyTitle(text, kw) {
  return /\(\s*\d{1,2}\s*[/.]\s*\d{1,2}\s*~/.test(text) && (!kw || text.includes(kw));
}

function extractTitle(text, kw) {
  const m = /\(\s*\d{1,2}\s*[/.]\s*\d{1,2}\s*~[^)]*\)[^()]{0,60}/.exec(text);
  let t = m ? m[0].trim() : text;
  if (kw && t.includes(kw)) t = t.slice(0, t.indexOf(kw) + kw.length);
  return t;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((i) => (seen.has(i.id) ? false : seen.add(i.id)));
}

/** 이번 주(weekStart) 게시물을 고른다. 같은 주 게시물이 여러 개면 가장 최근(큰 ID)을 쓴다. */
function pickWeekArticle(items, weekStart, todayStr) {
  const withRange = items
    .map((i) => ({ ...i, range: parseTitleRange(i.title, todayStr) }))
    .filter((i) => i.range);
  const thisWeek = withRange.filter((i) => i.range.weekStart === weekStart);
  thisWeek.sort((a, b) => Number(b.id) - Number(a.id));
  const latest = [...withRange].sort((a, b) => (a.range.start < b.range.start ? 1 : -1))[0] || null;
  return { article: thisWeek[0] || null, latest };
}

const UNSAFE_PATH = /(logout|delete|remove|insert|update|save|write|modify|del\.|reg\.|upload)/i;

/**
 * 게시물 래퍼에서 본문 프레임 후보 URL을 찾는다(실행 없이 속성과 문자열 리터럴만 본다).
 */
function findFrameUrls(html, { frameNames = [], docUrl }) {
  const urls = [];
  const names = frameNames.map((n) => n.toLowerCase());
  const tagRe = /<i?frame\b[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    const id = (attr(tag, 'name') || attr(tag, 'id') || '').toLowerCase();
    const src = attr(tag, 'src');
    if (src && !/^(about:|javascript:)/i.test(src) && (!names.length || names.includes(id))) {
      urls.push({ url: src, why: `frame:${id || '?'}` });
    }
  }
  // 스크립트에서 프레임에 주소를 넣는 문자열 리터럴: bodyFrame.location = '...' / $('#bodyFrame').attr('src', '...')
  for (const name of frameNames) {
    const re = new RegExp(`${name}[\\s\\S]{0,160}?(?:src|location|href)[\\s\\S]{0,40}?(['"])((?:\\.{0,2}/|https?:)[^'"]{2,500})\\1`, 'gi');
    while ((m = re.exec(html))) urls.push({ url: decodeJsString(m[2]), why: `script:${name}` });
  }
  // 그래도 없으면 스크립트 안의 같은 출처 화면 경로 리터럴
  if (!urls.length) {
    const lit = /(['"])(\/[A-Za-z0-9_\-/]+\.(?:hi|do|jsp|action)(?:\?[^'"]*)?)\1/g;
    while ((m = lit.exec(html))) urls.push({ url: decodeJsString(m[2]), why: 'literal' });
  }
  return completeUrls(urls, docUrl);
}

/** 프레임 주소에 값이 비어 있는 쿼리 파라미터가 있으면 래퍼 주소의 같은 이름 값을 채운다 */
function completeUrls(cands, docUrl) {
  const doc = new URL(docUrl);
  const out = [];
  const seen = new Set();
  for (const c of cands) {
    let u;
    try {
      u = new URL(c.url, doc);
    } catch {
      continue;
    }
    if (UNSAFE_PATH.test(u.pathname)) continue;
    for (const [k, v] of doc.searchParams) if (u.searchParams.has(k) && !u.searchParams.get(k)) u.searchParams.set(k, v);
    if (seen.has(u.href) || u.href === doc.href) continue;
    seen.add(u.href);
    out.push({ url: u.href, why: c.why });
  }
  return out;
}

/** 에디터 본문(프로필의 editorDataIds)을 찾아 HTML로 돌려준다. 여러 저장 형태를 지원 */
function findEditorHtml(html, editorDataIds = []) {
  const found = [];
  for (const id of editorDataIds) {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // <textarea id="EDITOR">&lt;img ...&gt;</textarea>, <div id="EDITOR">...</div>
    const el = new RegExp(`<(textarea|div|span|pre|td)\\b[^>]*\\b(?:id|name)\\s*=\\s*["']?${esc}["']?[^>]*>([\\s\\S]*?)</\\1>`, 'i').exec(html);
    if (el) found.push(el[1].toLowerCase() === 'textarea' ? decodeEntities(el[2]) : el[2]);
    // <input type="hidden" id="EDITOR" value="...">
    const input = new RegExp(`<input\\b[^>]*\\b(?:id|name)\\s*=\\s*["']?${esc}["']?[^>]*>`, 'i').exec(html);
    if (input) found.push(decodeEntities(attr(input[0], 'value') || ''));
    // var EDITOR = '...';  또는 "EDITOR" : "..."
    const js = new RegExp(`${esc}["']?\\s*[:=]\\s*(['"])((?:\\\\.|(?!\\1)[\\s\\S])*)\\1`, 'g');
    let m;
    while ((m = js.exec(html))) found.push(decodeEntities(decodeJsString(m[2])));
  }
  return found.filter((s) => /<img/i.test(s));
}

/** HTML 조각에서 이미지 주소를 찾는다(PNG 우선) */
function findImages(html) {
  const imgs = [];
  const re = /<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const src = attr(m[0], 'src');
    if (src) imgs.push(src.trim());
  }
  const score = (s) => (/^data:image\/png/i.test(s) || /\.png(\?|$)/i.test(s) ? 0 : /^data:image|\.(jpe?g|gif|bmp|webp)(\?|$)/i.test(s) ? 1 : 2);
  return [...new Set(imgs)].sort((a, b) => score(a) - score(b));
}

function sniffImage(buf) {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  return null;
}

module.exports = {
  decodeEntities,
  decodeJsString,
  stripTags,
  findLoginError,
  hasPasswordForm,
  parseBoardList,
  pickWeekArticle,
  findFrameUrls,
  findEditorHtml,
  findImages,
  sniffImage,
  UNSAFE_PATH,
};
