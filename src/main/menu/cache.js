'use strict';
// 주간 인식 결과를 로컬에 저장한다. 원본 이미지는 저장하지 않고 해시만 남긴다.
const fs = require('fs');
const path = require('path');

const KEEP_WEEKS = 6;

class WeekCache {
  constructor(dir) {
    this.dir = dir;
  }

  file(weekStart) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new Error('잘못된 주 시작일');
    return path.join(this.dir, `week-${weekStart}.json`);
  }

  get(weekStart) {
    try {
      const v = JSON.parse(fs.readFileSync(this.file(weekStart), 'utf8'));
      return v && v.week && v.week.weekStart === weekStart ? v : null;
    } catch {
      return null;
    }
  }

  /** entry: { week, source: { articleId, title, sha256 }, savedAt, checkedAt } */
  put(entry) {
    fs.mkdirSync(this.dir, { recursive: true });
    const f = this.file(entry.week.weekStart);
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
    this.prune();
  }

  touch(weekStart, checkedAt) {
    const e = this.get(weekStart);
    if (e) this.put({ ...e, checkedAt });
  }

  prune() {
    const files = fs.readdirSync(this.dir).filter((f) => /^week-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_WEEKS))) fs.rmSync(path.join(this.dir, f), { force: true });
  }
}

module.exports = { WeekCache };
