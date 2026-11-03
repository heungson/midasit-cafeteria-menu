'use strict';
// 오늘 메뉴 조회의 상태 기계. 화면은 이 서비스가 만든 view 객체만 그린다.
const crypto = require('crypto');
const { GroupwareClient } = require('../gw/client');
const { pickWeekArticle } = require('../gw/parse');
const { recognizeWeek } = require('../ocr');
const { selectDay } = require('./select');
const W = require('./week');

const MESSAGES = {
  ok: '',
  loading: '메뉴를 불러오는 중입니다',
  weekend: '주말에는 구내식당을 운영하지 않습니다',
  not_posted: '이번 주 메뉴가 아직 게시되지 않았습니다',
  offline: '그룹웨어에 연결할 수 없습니다. 사내망 또는 VPN 연결을 확인해 주세요',
  auth_required: '그룹웨어 계정을 설정해 주세요',
  auth_failed: '로그인에 실패했습니다. 아이디와 비밀번호를 확인해 주세요',
  auth_user_unknown: '그룹웨어에 등록되지 않은 사용자입니다',
  extra_auth: '추가 인증(OTP 등)이 필요한 계정이라 자동 로그인을 지원하지 않습니다',
  recognition_failed: '메뉴 이미지를 읽지 못했습니다',
  image_missing: '게시물에서 메뉴 이미지를 찾지 못했습니다',
  server_error: '그룹웨어 서버에서 오류가 발생했습니다',
  unexpected: '그룹웨어 응답을 처리하지 못했습니다',
  date_unverified: '오늘 날짜 열을 확인할 수 없어 메뉴를 표시하지 않습니다',
  no_column: '오늘 날짜의 메뉴가 메뉴표에 없습니다',
  no_profile: '그룹웨어 접속 프로필이 없습니다. 설정에서 프로필 파일을 가져와 주세요',
};
const AUTH_STOP = new Set(['auth_failed', 'auth_user_unknown', 'extra_auth']);

class MenuService {
  /**
   * deps: { getProfile, credentials, cache, settings(), clock(), createClient(profile), recognize(images, range, opts), claudePath(), onChange(view) }
   */
  constructor(deps) {
    this.d = {
      clock: () => new Date(),
      createClient: (p) => new GroupwareClient(p),
      recognize: recognizeWeek,
      onChange: () => {},
      ...Object.fromEntries(Object.entries(deps).filter(([, v]) => v !== undefined)),
    };
    this.view = { status: 'loading', message: MESSAGES.loading, busy: false };
    this.inflight = null;
    this.client = null;
    this.clientKey = null;
    this.blockedCreds = null; // 로그인 실패한 계정으로 자동 재시도하지 않기 위한 표시
    this.lastError = null;
  }

  targetWeek(today) {
    // 주말에는 다음 주 게시물을 미리 확인한다(오늘 메뉴로 표시하지는 않음)
    return W.isWeekend(today) ? W.mondayOf(W.addDays(today, 7)) : W.mondayOf(today);
  }

  /** 네트워크 없이 현재 캐시와 날짜만으로 화면 상태를 다시 계산 */
  compose(extra = {}) {
    const today = W.kstToday(this.d.clock());
    const weekStart = this.targetWeek(today);
    const entry = this.d.cache.get(weekStart);
    const err = extra.error || this.lastError;
    let status;
    let todayDay = null;
    if (W.isWeekend(today)) status = 'weekend';
    else if (entry) {
      const sel = selectDay(entry.week, today);
      status = sel.status === 'ok' ? 'ok' : sel.status;
      todayDay = sel.day || null;
    } else status = err ? err.code : 'loading';
    if (!(status in MESSAGES)) status = 'unexpected';
    const view = {
      today,
      weekday: W.weekdayName(today),
      weekStart,
      status,
      message: MESSAGES[status],
      week: entry ? entry.week : null,
      todayDay,
      source: entry ? { title: entry.source.title, savedAt: entry.savedAt, checkedAt: entry.checkedAt, engine: summarizeEngine(entry.week) } : null,
      // 캐시를 보여주고 있지만 최신 확인에 실패한 경우
      notice: entry && err ? `${MESSAGES[err.code] || err.message} · 저장된 결과를 표시합니다` : null,
      errorCode: err ? err.code : null,
      errorDetail: err && err.detail ? err.detail : null,
      latestPosted: extra.latestPosted || this.latestPosted || null,
      busy: !!this.inflight,
      progress: this.progress || null,
      demo: false,
      nowMinutes: kstMinutes(this.d.clock()),
    };
    if (status === 'not_posted' && view.latestPosted) {
      view.message += ` (최근 게시: ${view.latestPosted})`;
    }
    this.view = view;
    return view;
  }

  emit(extra) {
    const v = this.compose(extra);
    this.d.onChange(v);
    return v;
  }

  /**
   * force: 사용자가 직접 새로고침(간격·로그인 실패 차단 무시)
   * minIntervalMs: 자동 조회 최소 간격(기본: 설정의 확인 간격, 오프라인이면 5분)
   */
  refresh({ force = false, minIntervalMs = null } = {}) {
    if (!this.inflight) {
      this.inflight = this.doRefresh({ force, minIntervalMs }).finally(() => {
        this.inflight = null;
        this.progress = null;
        this.emit();
      });
      this.emit();
    }
    return this.inflight;
  }

  setProgress(msg) {
    this.progress = msg;
    this.emit();
  }

  async doRefresh({ force, minIntervalMs }) {
    const settings = this.d.settings();
    const now = this.d.clock();
    if (!force && this.lastAttempt) {
      const interval = minIntervalMs ?? (this.lastError && this.lastError.code === 'offline' ? 5 : settings.refreshMinutes) * 60000;
      if (now - this.lastAttempt < interval) return;
    }
    const today = W.kstToday(now);
    const weekStart = this.targetWeek(today);
    const entry = this.d.cache.get(weekStart);
    const profile = this.d.getProfile();
    if (!profile) return this.fail({ code: 'no_profile' });
    const host = new URL(profile.baseUrl).host;
    const creds = this.d.credentials.get(host);
    if (!creds) return this.fail({ code: 'auth_required' });
    const credKey = crypto.createHash('sha256').update(`${host}\n${creds.username}\n${creds.password}`).digest('hex');
    if (!force && this.blockedCreds === credKey) return; // 같은 잘못된 계정으로 자동 재시도하지 않음(계정 잠김 방지)
    if (!force && !this.lastAttempt && entry && entry.checkedAt && now - new Date(entry.checkedAt) < settings.refreshMinutes * 60000) return;
    this.lastAttempt = now;

    const clientKey = `${profile.baseUrl}\n${credKey}`;
    if (!this.client || this.clientKey !== clientKey) {
      this.client = this.d.createClient(profile);
      this.clientKey = clientKey;
    }
    try {
      this.setProgress('게시판 확인 중');
      const items = await this.client.listWeeklyPosts(creds);
      this.blockedCreds = null;
      const { article, latest } = pickWeekArticle(items, weekStart, today);
      this.latestPosted = latest ? `${fmtMd(latest.range.start)}~${fmtMd(latest.range.end)}` : null;
      if (!article) {
        if (entry) return this.ok(); // 이전에 읽은 이번 주 결과가 있으면 그대로 사용
        return this.fail({ code: 'not_posted' });
      }
      this.setProgress('메뉴 이미지 확인 중');
      const fetched = await this.client.fetchArticleImages(article.id, creds);
      const checkedAt = new Date(this.d.clock()).toISOString();
      if (entry && entry.source.sha256 === fetched.sha256 && entry.source.articleId === article.id) {
        this.d.cache.touch(weekStart, checkedAt);
        return this.ok();
      }
      const claudePath = settings.claudeEnabled ? this.d.claudePath() : null;
      const week = await this.d.recognize(fetched.images, article.range, {
        useClaude: !!claudePath,
        claudePath,
        claudeModel: settings.claudeModel,
        crossCheck: settings.crossCheck,
        onProgress: (m) => this.setProgress(m),
      });
      this.d.cache.put({
        week,
        source: { articleId: article.id, title: article.title, sha256: fetched.sha256 },
        savedAt: checkedAt,
        checkedAt,
      });
      return this.ok();
    } catch (e) {
      if (AUTH_STOP.has(e.code)) {
        this.blockedCreds = credKey;
        this.client = null;
      }
      return this.fail({ code: e.code in MESSAGES ? e.code : 'unexpected', message: e.message, detail: (e.details || []).join(' | ') || e.message });
    }
  }

  ok() {
    this.lastError = null;
  }

  fail(err) {
    this.lastError = err;
  }

  /** 계정이 바뀌면 차단 표시와 세션을 지운다 */
  credentialsChanged() {
    this.blockedCreds = null;
    this.client = null;
    this.lastError = null;
  }
}

function kstMinutes(now) {
  const p = W.kstParts(now);
  return p.hour * 60 + p.minute;
}

function fmtMd(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}/${d}`;
}

function summarizeEngine(week) {
  const engines = new Set(week.days.map((d) => d.engine).filter(Boolean));
  return [...engines].join('+') || null;
}

module.exports = { MenuService, MESSAGES, kstMinutes };
