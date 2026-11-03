'use strict';
// 주간 메뉴 이미지 → 주간 메뉴 데이터.
// 1) 격자 분할(날짜 열 × 식사 행) 2) Claude CLI로 날짜별 구조화 3) 실패한 날만 기본 OCR로 재시도
// 4) 기본 OCR이 있으면 Claude 결과와 대조 5) 날짜 머리글을 게시물 기간과 맞춰 검증
const { sliceWeek, prepareForOcr, GridError } = require('./grid');
const claude = require('./claude');
const native = require('./native');
const tp = require('./textparse');
const { MEAL_KEYS } = require('./schema');
const { addDays, weekdayName, headerMatchesDate, resolveYear } = require('../menu/week');

const LABEL_TO_KEY = { 아침: 'breakfast', 점심: 'lunch', 건강존: 'health', 저녁: 'dinner' };
const DEFAULT_ORDER = ['아침', '점심', '건강존', '저녁'];

class RecognitionError extends Error {
  constructor(msg, details = []) {
    super(msg);
    this.name = 'RecognitionError';
    this.code = 'recognition_failed';
    this.details = details;
  }
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
      }
    }),
  );
  return out;
}

function findTable(images) {
  const problems = [];
  for (let i = 0; i < images.length; i++) {
    if (images[i].type !== 'image/png') continue;
    try {
      return { index: i, sliced: sliceWeek(images[i].buf) };
    } catch (e) {
      if (!(e instanceof GridError)) throw e;
      problems.push(`이미지 ${i + 1}: ${e.message}`);
    }
  }
  throw new RecognitionError('메뉴표 격자를 찾지 못했습니다', problems);
}

/** 기본 OCR로 모든 셀을 한 번에 읽어 Claude와 같은 형태로 만든다 */
async function nativeRead(sliced, extraImages, ocr) {
  const bufs = [];
  const at = {};
  const add = (key, b) => {
    if (b) {
      at[key] = bufs.length;
      bufs.push(b);
    }
  };
  // 머리글·행 이름처럼 작은 칸은 키워서 읽는다(식사 칸은 하위 칸 좌표를 쓰므로 원본 크기 유지)
  sliced.labels.forEach((b, i) => add(`label${i}`, prepareForOcr(b)));
  add('top', sliced.top);
  add('bottom', sliced.bottom);
  extraImages.forEach((b, i) => add(`extra${i}`, b));
  sliced.days.forEach((d, di) => {
    add(`h${di}`, prepareForOcr(d.header));
    d.bands.forEach((b, bi) => add(`d${di}b${bi}`, b));
  });
  const pages = await ocr(bufs);
  const page = (k) => (k in at ? pages[at[k]] : null);
  const text = (k) => (page(k)?.lines || []).map((l) => l.text).join(' ');
  const g = sliced.grid;
  const days = sliced.days.map((d, di) => {
    const headerLines = tp.sortLines(page(`h${di}`)?.lines || []);
    const dateLine = headerLines.find((l) => /\d/.test(l.text));
    return {
      weekdayText: headerLines.find((l) => !/\d/.test(l.text))?.text.trim() || '',
      dateText: dateLine ? dateLine.text.trim() : '',
      cells: d.bands.map((_, bi) => {
        const p = page(`d${di}b${bi}`);
        return { index: bi + 1, ...tp.parseCell(p?.lines || [], p?.width || 1, g.splits[di][bi]) };
      }),
      rawText: d.bands.map((_, bi) => text(`d${di}b${bi}`)).join(' '),
    };
  });
  const infoLines = ['top', 'bottom', ...extraImages.map((_, i) => `extra${i}`)].flatMap((k) => page(k)?.lines || []);
  const meta = {
    rowLabels: sliced.labels.map((_, i) => tp.rowLabel(text(`label${i}`))),
    floorSchedules: ['top', ...extraImages.map((_, i) => `extra${i}`)].flatMap((k) => tp.parseFloorSchedules(page(k)?.lines || [])),
    servingTimes: tp.parseServingTimes(infoLines.map((l) => l.text).join(' ')),
  };
  return { days, meta };
}

const norm = (s) => String(s).replace(/[\s/()·.,]/g, '').toLowerCase();

/** Claude가 읽은 항목이 기본 OCR 원문에도 있는 비율(0~1) */
function agreement(day, rawText) {
  const hay = norm(rawText);
  const names = day.cells.flatMap((c) => c.sections.flatMap((s) => s.items.map((i) => norm(i.name)))).filter((n) => n.length >= 2);
  if (!names.length || !hay) return null;
  return names.filter((n) => hay.includes(n)).length / names.length;
}

/**
 * @param images [{buf, type}]
 * @param range { start, end, weekStart }  게시물 제목에서 읽은 기간
 * @param opts { useClaude, claudePath, claudeModel, nativeOcr(bufs)=>pages, crossCheck, onProgress }
 */
async function recognizeWeek(images, range, opts = {}) {
  const { index, sliced } = findTable(images);
  const extra = images.filter((im, i) => i !== index && im.type === 'image/png').map((im) => im.buf);
  const ocr = opts.nativeOcr || ((bufs) => native.recognize(bufs));
  const progress = opts.onProgress || (() => {});
  const cl = opts.claude || claude; // 테스트에서 대체 가능
  const warnings = [];
  const details = [];

  let nativeResult = null;
  const getNative = async () => {
    if (!nativeResult) nativeResult = nativeRead(sliced, extra, ocr).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
    return nativeResult;
  };

  let meta = null;
  let metaEngine = null;
  const dayResults = new Array(sliced.days.length).fill(null);
  const dayEngines = new Array(sliced.days.length).fill(null);

  if (opts.useClaude !== false && opts.claudePath) {
    const cli = { claudePath: opts.claudePath, model: opts.claudeModel || undefined };
    progress('Claude로 행 이름과 시간 안내를 읽는 중');
    const metaTry = await cl.readMeta({ ...cli, labels: sliced.labels, top: sliced.top, bottom: sliced.bottom, extra })
      .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
    if (metaTry.ok) {
      meta = metaTry.v.data;
      metaEngine = 'claude';
    } else details.push(`Claude(안내): ${metaTry.e.message}`);
    const labels = (meta?.rowLabels?.length === sliced.labels.length ? meta.rowLabels : DEFAULT_ORDER).slice();
    progress('Claude로 날짜별 메뉴를 읽는 중');
    const tries = await pool(sliced.days, 3, async (d) => {
      try {
        return await cl.readDay({ ...cli, header: d.header, bands: d.bands, bandLabels: labels });
      } catch (e) {
        if (e.code === 'not_installed') throw e;
        return cl.readDay({ ...cli, header: d.header, bands: d.bands, bandLabels: labels }); // 한 번 재시도
      }
    });
    tries.forEach((t, i) => {
      if (t.ok && t.v.data.cells.length === sliced.days[i].bands.length) {
        dayResults[i] = t.v.data;
        dayEngines[i] = 'claude';
      } else details.push(`Claude(${i + 1}열): ${t.ok ? '칸 개수 불일치' : t.e.message}`);
    });
  }

  const needNative = !meta || dayResults.some((d) => !d) || opts.crossCheck;
  if (needNative) {
    progress('기본 OCR로 읽는 중');
    const n = await getNative();
    if (n.ok) {
      const eng = native.engineName();
      if (!meta) {
        meta = n.v.meta;
        metaEngine = eng;
      }
      n.v.days.forEach((d, i) => {
        if (!dayResults[i]) {
          dayResults[i] = d;
          dayEngines[i] = eng;
        } else if (opts.crossCheck) {
          const a = agreement(dayResults[i], d.rawText);
          dayResults[i].agreement = a;
        }
      });
    } else details.push(`기본 OCR: ${n.e.message}`);
  }
  if (!meta || dayResults.some((d) => !d)) {
    throw new RecognitionError('메뉴 이미지를 읽지 못했습니다', details);
  }
  return buildWeek({ sliced, meta, metaEngine, dayResults, dayEngines, range, warnings, details });
}

function bandKeys(meta, count, warnings) {
  let labels = meta.rowLabels;
  if (!labels || labels.length !== count || labels.some((l) => !LABEL_TO_KEY[l])) {
    if (count === DEFAULT_ORDER.length) {
      warnings.push('행 이름을 읽지 못해 기본 순서(아침·점심·건강존·저녁)로 해석했습니다');
      labels = DEFAULT_ORDER;
    } else {
      labels = labels || [];
    }
  }
  return Array.from({ length: count }, (_, i) => LABEL_TO_KEY[labels[i]] || null);
}

/** 열 → 날짜 매핑과 검증. 머리글 날짜가 기간과 어긋나면 그 날은 '확인 불가'로 둔다 */
function assignDates(dayResults, range) {
  const n = dayResults.length;
  return dayResults.map((d, i) => {
    if (n === 5) {
      const date = addDays(range.weekStart, i);
      const match = headerMatchesDate(d.dateText, date);
      return { date, dateCheck: match === true ? 'verified' : match === null ? 'position' : 'mismatch' };
    }
    // 열 수가 평소와 다르면 머리글 날짜로만 판단
    const nums = (d.dateText.match(/\d+/g) || []).map(Number);
    if (nums.length >= 2) {
      const date = resolveYear(nums[0], nums[1], range.start);
      const inRange = date >= range.weekStart && date <= addDays(range.weekStart, 6);
      return { date: inRange ? date : null, dateCheck: inRange ? 'verified' : 'mismatch' };
    }
    return { date: null, dateCheck: 'mismatch' };
  });
}

function buildWeek({ sliced, meta, metaEngine, dayResults, dayEngines, range, warnings, details }) {
  const keys = bandKeys(meta, sliced.grid.bands.length, warnings);
  const dates = assignDates(dayResults, range);
  const days = dayResults.map((d, i) => {
    const { date, dateCheck } = dates[i];
    if (dateCheck === 'mismatch') warnings.push(`${i + 1}번째 열의 날짜(${d.dateText || '?'})가 게시 기간과 맞지 않아 제외했습니다`);
    if (dateCheck === 'position') warnings.push(`${date} 열의 날짜 머리글을 읽지 못해 열 순서로 판단했습니다`);
    if (d.agreement != null && d.agreement < 0.6) warnings.push(`${date} 메뉴의 자동 대조 일치율이 낮습니다(${Math.round(d.agreement * 100)}%)`);
    const meals = {};
    for (const k of MEAL_KEYS) meals[k] = { status: 'missing', sections: [] };
    d.cells.forEach((c, bi) => {
      const k = keys[bi];
      if (!k) return;
      meals[k] = {
        status: c.notServed ? 'not_served' : c.sections.some((s) => s.items.length) ? 'served' : 'empty',
        sections: c.sections.map((s) => ({ title: s.title, items: s.items.map((it) => ({ name: it.name, tag: it.tag })) })),
      };
    });
    return {
      date: dateCheck === 'mismatch' ? null : date,
      weekday: date ? weekdayName(date) : null,
      headerText: d.dateText,
      dateCheck,
      engine: dayEngines[i],
      agreement: d.agreement ?? null,
      meals,
    };
  });
  const byMeal = (list, meal) => list.filter((x) => x.meal === meal);
  const timeOf = (meal) => {
    const t = meta.servingTimes.find((s) => s.meal === meal);
    return t ? { start: t.start, end: t.end, lastServe: t.lastServe || null } : null;
  };
  return {
    schemaVersion: 1,
    weekStart: range.weekStart,
    rangeStart: range.start,
    rangeEnd: range.end,
    metaEngine,
    days,
    servingTimes: { breakfast: timeOf('아침'), lunch: timeOf('점심'), dinner: timeOf('저녁') },
    floorSchedules: {
      breakfast: byMeal(meta.floorSchedules, '아침').map(({ time, places }) => ({ time, places })),
      lunch: byMeal(meta.floorSchedules, '점심').map(({ time, places }) => ({ time, places })),
      dinner: byMeal(meta.floorSchedules, '저녁').map(({ time, places }) => ({ time, places })),
    },
    warnings,
    details,
  };
}

module.exports = { recognizeWeek, RecognitionError, agreement, assignDates, nativeRead };
