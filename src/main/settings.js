'use strict';
// 비밀이 아닌 앱 설정만 저장한다(계정 정보는 credentials.js).
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  claudeEnabled: true,
  claudePath: '',
  claudeModel: 'sonnet',
  crossCheck: true,
  refreshMinutes: 30,
  openAtLogin: false,
};
const MODELS = ['sonnet', 'haiku', 'opus'];

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.values = { ...DEFAULTS };
    try {
      this.values = sanitize({ ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) });
    } catch {
      /* 기본값 사용 */
    }
  }

  get() {
    return { ...this.values };
  }

  set(patch) {
    this.values = sanitize({ ...this.values, ...patch });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2));
    return this.get();
  }
}

function sanitize(v) {
  return {
    claudeEnabled: !!v.claudeEnabled,
    claudePath: typeof v.claudePath === 'string' ? v.claudePath.trim() : '',
    claudeModel: MODELS.includes(v.claudeModel) ? v.claudeModel : DEFAULTS.claudeModel,
    crossCheck: !!v.crossCheck,
    refreshMinutes: Math.min(240, Math.max(10, Number(v.refreshMinutes) || DEFAULTS.refreshMinutes)),
    openAtLogin: !!v.openAtLogin,
  };
}

module.exports = { Settings, DEFAULTS, MODELS };
