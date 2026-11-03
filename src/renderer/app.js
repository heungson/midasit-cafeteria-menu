'use strict';
/* global cafeteria */
// 메인 프로세스가 보내는 view 객체만 그린다. 모든 글자는 textContent로 넣는다.

const MEALS = [
  { key: 'breakfast', label: '아침', timeKey: 'breakfast' },
  { key: 'lunch', label: '점심', timeKey: 'lunch' },
  { key: 'health', label: '건강존', timeKey: null },
  { key: 'dinner', label: '저녁', timeKey: 'dinner' },
];
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const BANNERS = {
  weekend: 'info', not_posted: 'info', no_column: 'info',
  offline: 'warn', recognition_failed: 'warn', image_missing: 'warn', server_error: 'warn', unexpected: 'warn', date_unverified: 'warn', loading: 'info',
  auth_required: 'error', auth_failed: 'error', auth_user_unknown: 'error', extra_auth: 'error', no_profile: 'error',
};
const NEEDS_SETTINGS = new Set(['auth_required', 'auth_failed', 'auth_user_unknown', 'no_profile']);

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

let view = null;
let selected = null; // 사용자가 고른 날짜(없으면 오늘)

function md(date) {
  const [, m, d] = date.split('-').map(Number);
  return `${m}/${d}`;
}
function longDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `${m}월 ${d}일 ${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}요일`;
}
function ago(iso) {
  if (!iso) return '';
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  if (min < 1) return '방금 확인';
  if (min < 60) return `${min}분 전 확인`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h}시간 전 확인` : `${Math.round(h / 24)}일 전 확인`;
}
function kstNowMinutes() {
  if (view && Number.isFinite(view.nowMinutes) && view.demo) return view.nowMinutes;
  const d = new Date(Date.now() + 9 * 3600000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

function currentMealKey(week) {
  const t = kstNowMinutes();
  const st = week.servingTimes || {};
  for (const k of ['breakfast', 'lunch', 'dinner']) {
    const s = st[k];
    if (s && t >= toMin(s.start) - 60 && t <= toMin(s.end)) return k;
  }
  return null;
}

function render(v) {
  view = v;
  const shown = selected && v.week && v.week.days.some((d) => d.date === selected) ? selected : null;
  const day = shown ? v.week.days.find((d) => d.date === shown) : v.todayDay;
  const showingToday = !shown || shown === v.today;

  $('date').textContent = showingToday ? longDate(v.today) : `${longDate(shown)} 메뉴`;
  $('subtitle').textContent = showingToday ? '오늘의 메뉴 · 한국 시간 기준' : `오늘(${md(v.today)})이 아닌 날의 메뉴입니다`;
  $('refresh').classList.toggle('spin', !!v.busy);
  $('refresh').disabled = !!v.busy || v.demo;

  renderDays(v, shown);
  renderBanner(v, showingToday);
  renderMeals(v, day, showingToday);
  renderFooter(v);
}

function renderDays(v, shown) {
  const nav = $('days');
  nav.replaceChildren();
  if (!v.week) return;
  for (const d of v.week.days) {
    if (!d.date) continue;
    const b = el('button', 'day');
    b.append(el('span', 'wd', d.weekday), el('span', 'md', md(d.date)));
    if (d.date === v.today) b.classList.add('today');
    if (d.date === (shown || (v.todayDay ? v.today : null))) b.classList.add('selected');
    b.title = d.date === v.today ? '오늘' : `${md(d.date)} 메뉴 보기`;
    b.addEventListener('click', () => {
      selected = d.date === v.today ? null : d.date;
      render(view);
    });
    nav.append(b);
  }
}

function renderBanner(v, showingToday) {
  const box = $('banner');
  box.replaceChildren();
  let kind = null;
  if (v.demo) {
    kind = 'info';
    if (v.demo === 'file') box.append(el('div', 'big', '로컬 결과 미리보기'), el('div', null, '저장된 인식 결과 파일을 표시합니다. 그룹웨어는 조회하지 않습니다.'));
    else box.append(el('div', 'big', '데모 모드'), el('div', null, '실제 메뉴가 아닌 예시 데이터입니다.'));
  }
  if (showingToday && v.status !== 'ok') {
    kind = BANNERS[v.status] || 'warn';
    box.replaceChildren(el('div', 'big', v.busy && v.status === 'loading' ? (v.progress || v.message) : v.message));
    if (v.errorDetail && v.status !== 'not_posted') box.append(el('div', 'hint small', v.errorDetail));
    if (v.status === 'weekend' && v.week) box.append(el('div', null, '위에서 날짜를 눌러 다음 주 메뉴를 미리 볼 수 있습니다.'));
    if (NEEDS_SETTINGS.has(v.status)) {
      const b = el('button', 'primary', '설정 열기');
      b.addEventListener('click', openSettings);
      box.append(b);
    }
  } else if (v.notice) {
    kind = 'warn';
    box.replaceChildren(el('div', null, v.notice));
  } else if (v.busy && v.progress) {
    kind = 'info';
    box.replaceChildren(el('div', null, `${v.progress}…`));
  }
  const warnings = (v.week && v.week.warnings) || [];
  if (!kind && warnings.length && showingToday && v.status === 'ok') {
    kind = 'warn';
    box.replaceChildren(el('div', null, `인식 확인 필요: ${warnings[0]}`));
  }
  box.hidden = !kind;
  box.className = `banner ${kind || ''}`;
}

function renderMeals(v, day, showingToday) {
  const wrap = $('meals');
  wrap.replaceChildren();
  if (!day) return;
  const nowKey = showingToday ? currentMealKey(v.week) : null;
  for (const m of MEALS) {
    const meal = day.meals[m.key];
    const card = el('article', 'meal');
    if (nowKey === m.key) card.classList.add('now');
    const head = el('div', 'meal-head');
    const name = el('div', 'meal-name', m.label);
    if (nowKey === m.key) name.append(el('span', 'now-tag', '지금'));
    head.append(name);
    const t = m.timeKey && v.week.servingTimes[m.timeKey];
    if (t) head.append(el('div', 'meal-time', `${t.start}–${t.end}${t.lastServe ? ` · ${t.lastServe} 배식 완료` : ''}`));
    card.append(head);

    if (!meal || meal.status === 'missing') card.append(el('div', 'empty', '메뉴표에 없음'));
    else if (meal.status === 'not_served') card.append(el('div', 'empty', '미제공'));
    else if (meal.status === 'empty' || !meal.sections.length) card.append(el('div', 'empty', '메뉴 정보 없음'));
    else {
      meal.sections.forEach((s, si) => {
        const sec = el('div', 'section');
        if (s.title) sec.append(el('div', 'section-title', s.title));
        else if (si > 0) sec.append(el('div', 'section-title', '공통'));
        const ul = el('ul', 'items');
        s.items.forEach((it) => {
          const li = el('li', it.tag === 'M' ? 'main' : null);
          if (it.tag) li.append(el('span', 'tag', it.tag));
          li.append(document.createTextNode(it.name));
          ul.append(li);
        });
        sec.append(ul);
        card.append(sec);
      });
    }
    const floors = m.timeKey && v.week.floorSchedules[m.timeKey];
    if (floors && floors.length && meal && meal.status === 'served') {
      const f = el('div', 'floors');
      f.append(el('div', 'label', '층별 식사시간'));
      for (const row of floors) f.append(el('div', 't', row.time), el('div', 'p', row.places.join(' · ')));
      card.append(f);
    }
    wrap.append(card);
  }
}

function renderFooter(v) {
  const f = $('footer');
  f.replaceChildren();
  const left = el('span');
  if (v.demo) left.append(el('span', 'demo', v.demo === 'file' ? '로컬 결과 파일' : '데모 데이터'));
  else if (v.source) left.textContent = v.source.title || '';
  else left.textContent = '오늘의 메뉴';
  const engine = v.source && v.source.engine ? ({ claude: 'Claude 인식', vision: 'macOS Vision 인식', winocr: 'Windows OCR 인식', demo: '' }[v.source.engine] ?? `${v.source.engine} 인식`) : '';
  const right = el('span', null, [engine, v.demo ? '' : ago(v.source && v.source.checkedAt)].filter(Boolean).join(' · '));
  f.append(left, right);
}

// ── 설정 ─────────────────────────────────────────
async function openSettings() {
  $('menuView').hidden = true;
  $('settingsView').hidden = false;
  fillSettings(await cafeteria.getSettings());
}
function closeSettings() {
  $('settingsView').hidden = true;
  $('menuView').hidden = false;
}

function fillSettings(s) {
  const acc = $('accountState');
  if (s.demo) acc.textContent = '데모 모드에서는 계정을 사용하지 않습니다.';
  else if (s.keychainError) {
    acc.textContent = `${s.store}에 접근할 수 없습니다: ${s.keychainError}`;
    acc.className = 'hint bad';
  } else if (s.account.saved) {
    acc.textContent = `저장됨: ${s.account.username}`;
    acc.className = 'hint ok';
    $('username').value = s.account.username;
  } else {
    acc.textContent = '저장된 계정이 없습니다.';
    acc.className = 'hint';
  }
  $('storeHint').textContent = `계정과 비밀번호는 이 기기의 ${s.store}에만 저장되며, 메뉴 인식(Claude/OCR)에는 전달되지 않습니다.`;
  const ps = $('profileState');
  if (s.profile) {
    ps.textContent = `사용 중: ${s.profile.name}`;
    ps.className = 'hint ok';
  } else {
    ps.textContent = s.profileError ? `프로필 오류: ${s.profileError}` : '접속 프로필이 없습니다. 관리자에게 받은 프로필 파일(.json)을 가져와 주세요.';
    ps.className = 'hint bad';
  }
  $('claudeEnabled').checked = s.settings.claudeEnabled;
  $('claudeModel').value = s.settings.claudeModel;
  $('crossCheck').checked = s.settings.crossCheck;
  $('openAtLogin').checked = s.settings.openAtLogin;
  $('refreshMinutes').value = s.settings.refreshMinutes;
  $('claudeState').textContent = s.claudeFound ? `CLI: ${s.claudeFound}` : 'Claude Code CLI를 찾지 못했습니다. 기본 OCR로 인식합니다.';
  $('nativeState').textContent = s.nativeOcr ? `기본 OCR: ${s.nativeOcr}` : '기본 OCR 도구를 찾지 못했습니다.';
  $('version').textContent = `버전 ${s.version}`;
}

function bind() {
  $('refresh').addEventListener('click', () => cafeteria.refresh());
  $('openSettings').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', closeSettings);
  $('accountForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const acc = $('accountState');
    try {
      fillSettings(await cafeteria.saveCredentials($('username').value, $('password').value));
      $('password').value = '';
      closeSettings();
    } catch (err) {
      acc.textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      acc.className = 'hint bad';
    }
  });
  $('clearAccount').addEventListener('click', async () => {
    $('username').value = '';
    $('password').value = '';
    fillSettings(await cafeteria.clearCredentials());
  });
  $('importProfile').addEventListener('click', async () => fillSettings(await cafeteria.importProfile()));
  $('openData').addEventListener('click', () => cafeteria.openDataFolder());
  for (const id of ['claudeEnabled', 'crossCheck', 'openAtLogin']) {
    $(id).addEventListener('change', async () => fillSettings(await cafeteria.setSettings({ [id]: $(id).checked })));
  }
  $('claudeModel').addEventListener('change', async () => fillSettings(await cafeteria.setSettings({ claudeModel: $('claudeModel').value })));
  $('refreshMinutes').addEventListener('change', async () => fillSettings(await cafeteria.setSettings({ refreshMinutes: Number($('refreshMinutes').value) })));
  $('quit').addEventListener('click', () => cafeteria.quit());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && cafeteria.hide());
}

bind();
cafeteria.onView(render);
cafeteria.onOpen((what) => what === 'settings' && openSettings());
cafeteria.getView().then(render);
setInterval(() => view && render(view), 60000);
