'use strict';
// Claude CLI 호출 방식 검증: 가짜 CLI로 인자·입력·환경 변수를 확인한다(실제 Claude는 호출하지 않음).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runClaude, readDay, findClaude } = require('../src/main/ocr/claude');
const { DAY_SCHEMA } = require('../src/main/ocr/schema');

const skip = process.platform === 'win32' ? '가짜 CLI 스크립트는 POSIX에서만 실행' : false;

function fakeCli(dir, output) {
  const file = path.join(dir, 'claude');
  const record = path.join(dir, 'record.json');
  fs.writeFileSync(
    file,
    `#!${process.execPath}
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), input, env: process.env, cwd: process.cwd() }));
  process.stdout.write(${JSON.stringify(output)});
});
`,
    { mode: 0o755 },
  );
  return { file, read: () => JSON.parse(fs.readFileSync(record, 'utf8')) };
}

const okDay = { weekdayText: '화', dateText: '3.5', cells: [{ index: 1, notServed: false, sections: [{ title: '', items: [{ name: '닭갈비', tag: '' }] }] }] };
const resultLine = (structured) => JSON.stringify({ type: 'system', subtype: 'init' }) + '\n' + JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: structured, total_cost_usd: 0.01 }) + '\n';

test('이미지 블록 입력, 스키마 강제, 도구·MCP·설정 끔, 그룹웨어 비밀 미전달', { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = fakeCli(dir, resultLine(okDay));
  process.env.GROUPWARE_PASSWORD_FOR_TEST = 'should-not-leak';
  t.after(() => delete process.env.GROUPWARE_PASSWORD_FOR_TEST);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const r = await readDay({ claudePath: cli.file, model: 'sonnet', header: png, bands: [png], bandLabels: ['점심'] });
  assert.deepEqual(r.data, okDay);
  const rec = cli.read();
  const a = rec.argv;
  const val = (flag) => a[a.indexOf(flag) + 1];
  assert.equal(val('--input-format'), 'stream-json');
  assert.equal(val('--tools'), '');
  assert.equal(val('--setting-sources'), '');
  assert.ok(a.includes('--strict-mcp-config'));
  assert.ok(a.includes('--no-session-persistence'));
  assert.deepEqual(JSON.parse(val('--json-schema')), DAY_SCHEMA);
  assert.equal(val('--model'), 'sonnet');
  const msg = JSON.parse(rec.input.trim());
  const imgs = msg.message.content.filter((b) => b.type === 'image');
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].source.media_type, 'image/png');
  assert.equal(imgs[0].source.data, png.toString('base64'));
  assert.ok(!('GROUPWARE_PASSWORD_FOR_TEST' in rec.env), '앱 환경 변수가 그대로 전달되면 안 된다');
  assert.ok(!rec.input.includes('should-not-leak'));
  assert.ok(rec.cwd.includes('cafeteria-ocr-'), '빈 임시 폴더에서 실행');
});

test('스키마에 맞지 않는 결과는 거부', { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = fakeCli(dir, resultLine({ weekdayText: '화', dateText: '3.5', cells: [{ index: 1, notServed: 'no', sections: [] }] }));
  await assert.rejects(runClaude({ claudePath: cli.file, content: [], schema: DAY_SCHEMA }), { code: 'schema_error' });
});

test('구조화 출력이 없거나 CLI가 실패하면 cli_error', { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = fakeCli(dir, JSON.stringify({ type: 'result', is_error: true, result: 'auth error' }) + '\n');
  await assert.rejects(runClaude({ claudePath: cli.file, content: [], schema: DAY_SCHEMA }), { code: 'cli_error' });
  await assert.rejects(runClaude({ claudePath: null, content: [], schema: DAY_SCHEMA }), { code: 'not_installed' });
});

test('설치 위치 탐색: 설정 경로 → PATH → 알려진 위치', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-claude-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  fs.writeFileSync(path.join(dir, name), '');
  assert.equal(findClaude({ env: { PATH: dir, HOME: dir, USERPROFILE: dir } }), path.join(dir, name));
  assert.equal(findClaude({ configured: path.join(dir, name), env: { PATH: '' } }), path.join(dir, name));
  assert.equal(findClaude({ env: { PATH: '', HOME: path.join(dir, 'none'), USERPROFILE: path.join(dir, 'none'), APPDATA: dir, LOCALAPPDATA: dir }, platform: 'linux' }), fs.existsSync('/opt/homebrew/bin/claude') ? '/opt/homebrew/bin/claude' : fs.existsSync('/usr/local/bin/claude') ? '/usr/local/bin/claude' : null);
});
