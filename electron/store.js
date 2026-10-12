'use strict';
/**
 * 极简 JSON 配置存储（无第三方依赖）
 * 落在 %APPDATA%/GlassHour/config.json
 */
const fs = require('fs');
const path = require('path');

class Store {
  constructor(name, defaults = {}) {
    this.file = path.join(this._dir(), `${name}.json`);
    this.defaults = defaults;
    this.data = this._load();
  }

  _dir() {
    // app 可能还没 ready，userData 在 ready 前后都能拿到
    try {
      const { app } = require('electron');
      return app.getPath('userData');
    } catch (_) {
      return path.join(process.env.APPDATA || process.env.HOME || '.', 'GlassHour');
    }
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      return Object.assign({}, this.defaults, parsed);
    } catch (_) {
      return Object.assign({}, this.defaults);
    }
  }

  get(key) {
    return this.data[key];
  }

  all() {
    return Object.assign({}, this.data);
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
    return value;
  }

  patch(obj) {
    Object.assign(this.data, obj);
    this.save();
  }

  reset() {
    this.data = Object.assign({}, this.defaults);
    this.save();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      // 写盘失败不能打断组件运行
      console.error('[store] save failed:', err && err.message);
    }
  }
}

module.exports = Store;
