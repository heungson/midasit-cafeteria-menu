'use strict';
// 메뉴 막대(macOS)/알림 영역(Windows) 앱의 진입점.
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { loadProfile, installProfile } = require('./profile');
const { CredentialStore } = require('./credentials');
const { WeekCache } = require('./menu/cache');
const { MenuService } = require('./menu/service');
const { DemoService } = require('./demo');
const { Settings } = require('./settings');
const { findClaude } = require('./ocr/claude');
const native = require('./ocr/native');
const W = require('./menu/week');

const argv = process.argv.slice(1);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? null : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
};
const DEMO = !!flag('demo') || !!flag('demo-data');
const SCREENSHOT = flag('screenshot'); // 화면 확인용: 창을 그린 뒤 PNG로 저장하고 종료
const FIXED_DATE = flag('date'); // 데모/스크린샷 전용 날짜(YYYY-MM-DD, 한국 시간 정오로 고정)
const APP_ROOT = path.join(__dirname, '..', '..');

// 사용자 데이터 폴더 이름은 ASCII로 고정(개발 실행과 설치 앱이 같은 폴더를 쓰도록)
const DATA_DIR_NAME = 'CafeteriaMenu';
app.setPath('userData', path.join(app.getPath('appData'), DATA_DIR_NAME));

if (!SCREENSHOT && !app.requestSingleInstanceLock()) app.quit();

let tray = null;
let dialogOpen = false;
let win = null;
let service = null;
let settings = null;
let profileInfo = { profile: null, file: null };
const credentials = new CredentialStore();

const clock = () => {
  if ((DEMO || SCREENSHOT) && typeof FIXED_DATE === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(FIXED_DATE)) {
    const hm = typeof flag('time') === 'string' ? flag('time') : '12:10';
    return new Date(`${FIXED_DATE}T${hm}:00+09:00`);
  }
  return new Date();
};

function iconPath(name) {
  return path.join(APP_ROOT, 'assets', name);
}

function trayIcon() {
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromPath(iconPath('trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(iconPath('tray.png'));
}

function createWindow() {
  win = new BrowserWindow({
    width: 384,
    height: 640,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    transparent: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('blur', () => {
    if (!SCREENSHOT && !dialogOpen && !win.webContents.isDevToolsOpened()) win.hide();
  });
  // 외부 링크·새 창은 열지 않는다
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function positionWindow() {
  const b = tray.getBounds();
  const wb = win.getBounds();
  const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  const wa = display.workArea;
  let x = Math.round(b.x + b.width / 2 - wb.width / 2);
  let y = b.y < wa.y + wa.height / 2 ? b.y + b.height + 4 : b.y - wb.height - 4;
  if (!b.width) {
    // 트레이 위치를 알 수 없는 환경: 작업 영역 오른쪽 위/아래
    x = wa.x + wa.width - wb.width - 12;
    y = process.platform === 'darwin' ? wa.y + 4 : wa.y + wa.height - wb.height - 12;
  }
  x = Math.min(Math.max(x, wa.x + 4), wa.x + wa.width - wb.width - 4);
  y = Math.min(Math.max(y, wa.y + 4), wa.y + wa.height - wb.height - 4);
  win.setPosition(x, y, false);
}

function toggleWindow() {
  if (win.isVisible()) return win.hide();
  positionWindow();
  win.show();
  win.focus();
  service.emit();
  const v = service.view;
  // 창을 열 때는 2분 이상 지났으면 다시 확인(로그인 실패 차단은 유지)
  service.refresh({ minIntervalMs: 2 * 60000 });
}

function send(view) {
  if (win && !win.isDestroyed()) win.webContents.send('view:update', view);
  if (tray && process.platform === 'darwin') tray.setToolTip(trayTooltip(view));
}

function trayTooltip(v) {
  return v.status === 'ok' ? `오늘의 메뉴 · ${v.today.slice(5).replace('-', '/')} (${v.weekday})` : `오늘의 메뉴 · ${v.message}`;
}

function buildService() {
  const userData = app.getPath('userData');
  settings = new Settings(userData);
  if (DEMO) {
    const data = flag('demo-data');
    return new DemoService({ file: typeof data === 'string' ? path.resolve(data) : undefined, clock, onChange: send });
  }
  profileInfo = loadProfile({ userDataDir: userData, appRoot: app.isPackaged ? null : APP_ROOT });
  return new MenuService({
    getProfile: () => profileInfo.profile,
    credentials,
    cache: new WeekCache(path.join(userData, 'cache')),
    settings: () => settings.get(),
    claudePath: () => findClaude({ configured: settings.get().claudePath }),
    clock,
    onChange: send,
  });
}

function settingsView() {
  const s = settings.get();
  const p = profileInfo.profile;
  const host = p ? new URL(p.baseUrl).host : null;
  let account = { saved: false };
  let keychainError = null;
  if (host && !DEMO) {
    try {
      account = credentials.describe(host);
    } catch (e) {
      keychainError = e.message;
    }
  }
  return {
    settings: s,
    demo: DEMO,
    profile: p ? { name: p.name, host } : null,
    profileError: profileInfo.error || null,
    account,
    keychainError,
    store: process.platform === 'darwin' ? 'macOS 키체인' : process.platform === 'win32' ? 'Windows 자격 증명 관리자' : '시스템 키링',
    claudeFound: findClaude({ configured: s.claudePath }),
    nativeOcr: native.locate() ? (process.platform === 'darwin' ? 'macOS Vision' : 'Windows OCR') : null,
    version: app.getVersion(),
  };
}

function registerIpc() {
  ipcMain.handle('view:get', () => service.emit());
  ipcMain.handle('menu:refresh', () => service.refresh({ force: true }).then(() => service.view));
  ipcMain.handle('settings:get', () => settingsView());
  ipcMain.handle('settings:set', (_e, patch) => {
    const s = settings.set(patch || {});
    if ('openAtLogin' in (patch || {})) app.setLoginItemSettings({ openAtLogin: s.openAtLogin });
    return settingsView();
  });
  ipcMain.handle('creds:save', (_e, { username, password } = {}) => {
    const p = profileInfo.profile;
    if (!p) throw new Error('먼저 접속 프로필을 가져와 주세요');
    credentials.set(new URL(p.baseUrl).host, { username: String(username || '').trim(), password: String(password || '') });
    service.credentialsChanged();
    service.refresh({ force: true });
    return settingsView();
  });
  ipcMain.handle('creds:clear', () => {
    const p = profileInfo.profile;
    if (p) credentials.clear(new URL(p.baseUrl).host);
    service.credentialsChanged();
    service.emit();
    return settingsView();
  });
  ipcMain.handle('profile:import', async () => {
    dialogOpen = true;
    let r;
    try {
      r = await dialog.showOpenDialog(win, { title: '접속 프로필 선택', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
    } finally {
      dialogOpen = false;
    }
    if (r.canceled || !r.filePaths[0]) return settingsView();
    try {
      installProfile(r.filePaths[0], app.getPath('userData'));
      profileInfo = loadProfile({ userDataDir: app.getPath('userData'), appRoot: null });
      service.credentialsChanged();
      service.refresh({ force: true });
    } catch (e) {
      profileInfo = { ...profileInfo, error: e.message };
    }
    return settingsView();
  });
  ipcMain.handle('app:openDataFolder', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('app:quit', () => app.quit());
  ipcMain.handle('app:hide', () => win.hide());
}

function startTimers() {
  let lastDay = W.kstToday(clock());
  setInterval(() => {
    const today = W.kstToday(clock());
    if (today !== lastDay) {
      // 자정(한국 시간)이 지나면 오늘 메뉴를 다시 고른다
      lastDay = today;
      service.emit();
      service.refresh();
    } else service.refresh(); // 서비스가 refreshMinutes 간격으로만 실제 조회
  }, 60 * 1000);
}

async function captureScreenshot(out) {
  if (Number(flag('height'))) win.setSize(384, Number(flag('height')));
  win.setPosition(40, 40);
  win.showInactive();
  await Promise.race([service.refresh(), new Promise((r) => setTimeout(r, 30000))]);
  service.emit();
  await new Promise((r) => setTimeout(r, Number(flag('wait')) || 1500));
  const img = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), img.toPNG());
  console.log(`screenshot saved: ${out}`);
  app.exit(0);
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  service = buildService();
  registerIpc();
  createWindow();
  if (SCREENSHOT) {
    if (flag('view') === 'settings') win.webContents.once('did-finish-load', () => win.webContents.send('ui:open', 'settings'));
    win.webContents.once('did-finish-load', () => captureScreenshot(SCREENSHOT));
    return;
  }
  tray = new Tray(trayIcon());
  tray.setToolTip('오늘의 메뉴');
  tray.on('click', toggleWindow);
  tray.on('right-click', () =>
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: '오늘의 메뉴 열기', click: toggleWindow },
        { label: '지금 새로고침', click: () => service.refresh({ force: true }) },
        { type: 'separator' },
        { label: '종료', click: () => app.quit() },
      ]),
    ),
  );
  startTimers();
  service.refresh();
});

app.on('second-instance', () => win && toggleWindow());
app.on('window-all-closed', (e) => e.preventDefault());
