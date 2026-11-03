'use strict';
// Claude Code CLI로 셀 이미지를 구조화한다.
// - 이미지는 stream-json 입력의 image 블록으로 직접 전달(파일 경로나 도구 사용 없음)
// - --json-schema로 출력 형식을 강제하고, 받은 결과를 다시 검증
// - 도구·MCP·설정 파일을 모두 끄고 빈 임시 폴더에서 실행. 그룹웨어 계정·쿠키·주소는 전달하지 않음
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DAY_SCHEMA, META_SCHEMA, validate } = require('./schema');

const SYSTEM_PROMPT = [
  '당신은 한국어 구내식당 메뉴표의 셀 이미지를 그대로 옮겨 적는 OCR 도구입니다.',
  '이미지에 실제로 보이는 글자만 적습니다. 추측하거나, 빠진 글자를 보완하거나, 다른 칸의 내용을 옮기지 않습니다.',
  '출력은 반드시 주어진 JSON 스키마를 따릅니다.',
].join('\n');

const DAY_RULES = [
  '규칙:',
  "- 칸 안에서 '-브런치-', '-한식-'처럼 하이픈으로 둘러싼 줄은 섹션 제목입니다. title에는 하이픈을 뺀 글자만 넣습니다.",
  '- 칸 안에 가로 구분선이 있으면 선 아래는 새 섹션입니다. 그 섹션에 제목이 없으면 title은 빈 문자열입니다.',
  "- 칸 너비 때문에 줄이 바뀌며 잘린 단어는 이어 붙입니다(예: '그린샐러드&토핑&드레' 다음 줄 '싱/...' → '그린샐러드&토핑&드레싱').",
  "- '/'로 구분된 것은 각각 별도 항목입니다. '/'가 없는 칸은 한 줄이 한 항목입니다(잘린 단어는 이어 붙임).",
  '- (M), (S), (E), (B), (H), (N) 표시는 tag에 넣고 name에서는 뺍니다. 표시가 없으면 tag는 빈 문자열입니다.',
  "- '미제공'처럼 식사를 제공하지 않는다고 적힌 칸은 notServed=true, sections=[]입니다.",
  '- 글자가 없는 빈 칸은 notServed=false, sections=[]입니다.',
  '- 항목 이름의 띄어쓰기와 기호는 이미지에 보이는 대로 둡니다.',
].join('\n');

function candidatePaths(env = process.env, platform = process.platform) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return [
      path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(appData, 'npm', 'claude.cmd'),
      path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'claude', 'claude.exe'),
    ];
  }
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.npm-global', 'bin', 'claude'),
  ];
}

/** Finder/탐색기에서 실행한 앱은 PATH가 짧으므로 알려진 설치 위치도 찾아본다 */
function findClaude({ configured, env = process.env, platform = process.platform } = {}) {
  const list = [];
  if (configured) list.push(configured);
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']) list.push(path.join(dir, name));
  }
  list.push(...candidatePaths(env, platform));
  return list.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }) || null;
}

/** 실행 명령 구성. Windows의 npm 래퍼(.cmd)는 셸 따옴표 문제를 피하려고 cli.js를 Electron 내장 Node로 직접 실행 */
function commandFor(claudePath) {
  if (/\.cmd$/i.test(claudePath)) {
    const cli = path.join(path.dirname(claudePath), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(cli)) return { cmd: process.execPath, pre: [cli], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return { cmd: claudePath, pre: [], env: {} };
}

/** Claude 인증에 필요한 값만 남긴 환경 변수(그룹웨어 정보는 애초에 환경 변수에 없음) */
function childEnv(extra) {
  const keep = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'HOMEDRIVE', 'HOMEPATH',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS',
  ];
  const env = {};
  for (const k of keep) if (process.env[k] != null) env[k] = process.env[k];
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_|AWS_|GOOGLE_|CLOUD_ML_|VERTEX_)/.test(k)) env[k] = v;
  }
  return { ...env, ...extra };
}

function imageBlock(buf) {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') } };
}

class ClaudeError extends Error {
  constructor(code, msg) {
    super(msg);
    this.name = 'ClaudeError';
    this.code = code; // not_installed | timeout | cli_error | schema_error
  }
}

/**
 * CLI 한 번 실행. content는 Messages API 형식의 블록 배열.
 */
function runClaude({ claudePath, model, content, schema, timeoutMs = 180000 }) {
  return new Promise((resolve, reject) => {
    if (!claudePath) return reject(new ClaudeError('not_installed', 'Claude Code CLI를 찾지 못했습니다'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cafeteria-ocr-'));
    const { cmd, pre, env } = commandFor(claudePath);
    const args = [
      ...pre,
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--json-schema', JSON.stringify(schema),
      '--system-prompt', SYSTEM_PROMPT,
      '--tools', '',
      '--strict-mcp-config',
      '--setting-sources', '',
      '--no-session-persistence',
    ];
    if (model) args.push('--model', model);
    const child = spawn(cmd, args, { cwd, env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      finish(new ClaudeError('timeout', 'Claude 응답 시간이 초과되었습니다'));
    }, timeoutMs);
    let done = false;
    const finish = (e, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fs.rm(cwd, { recursive: true, force: true }, () => {});
      e ? reject(e) : resolve(v);
    };
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => finish(new ClaudeError(e.code === 'ENOENT' ? 'not_installed' : 'cli_error', e.message)));
    child.on('close', (code) => {
      const result = out
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .find((m) => m && m.type === 'result');
      if (!result) return finish(new ClaudeError('cli_error', `Claude CLI 실패(종료 코드 ${code}): ${err.trim().slice(0, 300)}`));
      if (result.is_error || result.structured_output == null) {
        return finish(new ClaudeError('cli_error', `Claude 구조화 출력 없음: ${String(result.result || result.subtype).slice(0, 300)}`));
      }
      const problems = validate(schema, result.structured_output);
      if (problems.length) return finish(new ClaudeError('schema_error', `스키마 불일치: ${problems.slice(0, 5).join('; ')}`));
      finish(null, { data: result.structured_output, costUsd: result.total_cost_usd || 0, durationMs: result.duration_ms });
    });
    child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  });
}

/** 하루치(날짜 머리글 + 식사 칸들)를 읽는다 */
function readDay({ header, bands, bandLabels, ...cli }) {
  const content = [
    { type: 'text', text: '이미지 0은 이 날짜 열의 머리글(요일, 날짜)입니다.' },
    imageBlock(header),
  ];
  bands.forEach((b, i) => {
    content.push({ type: 'text', text: `이미지 ${i + 1}: 같은 날짜의 '${bandLabels[i] || '식사'}' 칸입니다. cells의 index=${i + 1}로 적으세요.` });
    content.push(imageBlock(b));
  });
  content.push({ type: 'text', text: `${DAY_RULES}\n\ncells에는 index 1부터 ${bands.length}까지 모두 적으세요.` });
  return runClaude({ ...cli, content, schema: DAY_SCHEMA });
}

/** 행 이름, 층별 식사시간, 배식 시간을 읽는다 */
function readMeta({ labels, top, bottom, extra = [], ...cli }) {
  const content = [];
  labels.forEach((l, i) => {
    content.push({ type: 'text', text: `행 이름 이미지 ${i + 1}` });
    content.push(imageBlock(l));
  });
  for (const [name, buf] of [['표 위쪽 안내 영역', top], ['표 아래쪽 안내 영역', bottom], ...extra.map((b, i) => [`추가 안내 이미지 ${i + 1}`, b])]) {
    if (!buf) continue;
    content.push({ type: 'text', text: name });
    content.push(imageBlock(buf));
  }
  content.push({
    type: 'text',
    text: [
      `rowLabels: 행 이름 이미지 ${labels.length}개를 순서대로 아침/점심/건강존/저녁/기타 중 하나로 분류하세요.`,
      'floorSchedules: "[중식 - 시간별 층수 안내]" 같은 안내의 각 줄을 meal(중식=점심, 석식=저녁, 조식=아침), time(HH:MM), places(쉼표로 나뉜 층·건물 이름 그대로)로 적으세요.',
      'servingTimes: "식사시간 = 조식: 8시~9시 (8시 50분 배식완료)" 같은 문장을 meal, start, end, lastServe(HH:MM, 24시간제)로 적으세요. 없으면 빈 배열입니다.',
      '이미지에 없는 내용은 만들지 마세요.',
    ].join('\n'),
  });
  return runClaude({ ...cli, content, schema: META_SCHEMA });
}

module.exports = { findClaude, runClaude, readDay, readMeta, ClaudeError, childEnv, SYSTEM_PROMPT };
