'use strict';
// Claude 구조화 출력용 JSON Schema와, 받은 결과를 다시 검사하는 최소 검증기.

const TAGS = ['', 'M', 'S', 'E', 'B', 'H', 'N'];
const MEAL_KEYS = ['breakfast', 'lunch', 'health', 'dinner'];
const MEAL_LABELS = { breakfast: '아침', lunch: '점심', health: '건강존', dinner: '저녁' };
const ROW_LABELS = ['아침', '점심', '건강존', '저녁', '기타'];
const TIME_RE = '^([01]\\d|2[0-3]):[0-5]\\d$';

const item = {
  type: 'object',
  properties: { name: { type: 'string', minLength: 1 }, tag: { type: 'string', enum: TAGS } },
  required: ['name', 'tag'],
  additionalProperties: false,
};
const section = {
  type: 'object',
  properties: { title: { type: 'string' }, items: { type: 'array', items: item } },
  required: ['title', 'items'],
  additionalProperties: false,
};

const DAY_SCHEMA = {
  type: 'object',
  properties: {
    weekdayText: { type: 'string', description: '머리글의 요일 글자(예: 화). 읽을 수 없으면 빈 문자열' },
    dateText: { type: 'string', description: '머리글의 날짜 그대로(예: 11.3). 읽을 수 없으면 빈 문자열' },
    cells: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', minimum: 1 },
          notServed: { type: 'boolean' },
          sections: { type: 'array', items: section },
        },
        required: ['index', 'notServed', 'sections'],
        additionalProperties: false,
      },
    },
  },
  required: ['weekdayText', 'dateText', 'cells'],
  additionalProperties: false,
};

const META_SCHEMA = {
  type: 'object',
  properties: {
    rowLabels: { type: 'array', items: { type: 'string', enum: ROW_LABELS } },
    floorSchedules: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          meal: { type: 'string', enum: ['아침', '점심', '저녁'] },
          time: { type: 'string', pattern: TIME_RE },
          places: { type: 'array', items: { type: 'string', minLength: 1 } },
        },
        required: ['meal', 'time', 'places'],
        additionalProperties: false,
      },
    },
    servingTimes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          meal: { type: 'string', enum: ['아침', '점심', '저녁'] },
          start: { type: 'string', pattern: TIME_RE },
          end: { type: 'string', pattern: TIME_RE },
          lastServe: { type: 'string', description: '배식 완료 시각 HH:MM, 없으면 빈 문자열' },
        },
        required: ['meal', 'start', 'end', 'lastServe'],
        additionalProperties: false,
      },
    },
  },
  required: ['rowLabels', 'floorSchedules', 'servingTimes'],
  additionalProperties: false,
};

// 필요한 부분만 지원하는 JSON Schema 검사기(type/enum/pattern/required/additionalProperties/items/minLength/minimum)
function validate(schema, value, path = '$') {
  const errors = [];
  const t = schema.type;
  const typeOk =
    t === 'object' ? value && typeof value === 'object' && !Array.isArray(value)
    : t === 'array' ? Array.isArray(value)
    : t === 'integer' ? Number.isInteger(value)
    : t === 'string' ? typeof value === 'string'
    : t === 'boolean' ? typeof value === 'boolean'
    : true;
  if (!typeOk) return [`${path}: ${t} 형식이 아닙니다`];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: 허용되지 않은 값 ${JSON.stringify(value)}`);
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: 형식 불일치 ${JSON.stringify(value)}`);
  if (schema.minLength && value.length < schema.minLength) errors.push(`${path}: 비어 있습니다`);
  if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: 최소값 미만`);
  if (t === 'object') {
    for (const k of schema.required || []) if (!(k in value)) errors.push(`${path}.${k}: 누락`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) errors.push(...validate(schema.properties[k], v, `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${k}: 허용되지 않은 속성`);
    }
  }
  if (t === 'array' && schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${path}[${i}]`)));
  return errors;
}

module.exports = { DAY_SCHEMA, META_SCHEMA, MEAL_KEYS, MEAL_LABELS, ROW_LABELS, TAGS, validate };
