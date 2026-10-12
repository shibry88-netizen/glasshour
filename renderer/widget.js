'use strict';
/**
 * GlassHour · 组件渲染逻辑
 * 与视觉解耦：所有可视元素通过 [data-gh="名字"] 挂钩，样式由 widget.css 决定。
 * 支持两种模式：date（目标日期倒计时）/ timer（时长计时器）
 */
(function () {
  const q = (name) => document.querySelector(`[data-gh="${name}"]`);
  const qa = (name) => Array.from(document.querySelectorAll(`[data-gh="${name}"]`));

  // ---- 与主进程通信（截图时可用 window.__GH_MOCK__ 注入假状态） ----
  const MOCK = window.__GH_MOCK__ || null;
  const bridge = MOCK
    ? {
        getState: async () => Object.assign({ now: Date.now() }, MOCK),
        setState: async () => MOCK,
        setMode: async () => MOCK,
        onState: () => () => {},
        openSettings: () => {},
        hide: () => {},
        dragStart: () => {},
        dragMove: () => {},
        dragEnd: () => {},
      }
    : window.gh;

  let state = null;
  let ticker = null;

  const pad = (n, w = 2) => String(Math.max(0, Math.floor(n))).padStart(w, '0');

  function splitMs(ms) {
    ms = Math.max(0, ms);
    const total = Math.floor(ms / 1000);
    return {
      d: Math.floor(total / 86400),
      h: Math.floor((total % 86400) / 3600),
      m: Math.floor((total % 3600) / 60),
      s: total % 60,
      total,
    };
  }

  /* ---------------- 计算当前应显示的内容 ---------------- */
  function computeView() {
    const now = Date.now();
    const mode = state.mode;

    if (mode === 'date') {
      const target = new Date(state.targetISO).getTime();
      const left = target - now;
      const p = splitMs(left);
      const total = Math.max(1, target - (now - 1));
      return {
        mode,
        big: String(p.d),
        unit: '天',
        sub: `${pad(p.h)} 时 ${pad(p.m)} 分 ${pad(p.s)} 秒`,
        caption: state.title || '目标日',
        progress: left <= 0 ? 1 : 0,
        done: left <= 0,
        urgent: left > 0 && left <= 7 * 86400 * 1000,
        secondsLeft: p.total,
      };
    }

    // timer
    let leftMs;
    if (state.timerRunning) {
      leftMs = (state.timerEndsAt || 0) - now;
    } else {
      leftMs = (state.timerRemaining || state.durationSec || 0) * 1000;
    }
    const p = splitMs(leftMs);
    const total = state.durationSec || 1;
    const elapsedRatio = 1 - Math.min(1, Math.max(0, p.total / total));
    const mmss = p.d > 0 ? `${p.d * 24 + p.h}:${pad(p.m)}:${pad(p.s)}` : `${pad(p.m)}:${pad(p.s)}`;
    return {
      mode,
      big: mmss,
      unit: '',
      sub: state.timerRunning ? '计时中' : p.total <= 0 ? '已结束' : '已暂停',
      caption: '时长计时',
      progress: elapsedRatio,
      done: p.total <= 0 && !state.timerRunning,
      urgent: state.timerRunning && p.total <= 60,
      secondsLeft: p.total,
      running: !!state.timerRunning,
    };
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    if (!state) return;
    const v = computeView();

    const card = q('card');
    if (card) {
      card.classList.toggle('is-date', v.mode === 'date');
      card.classList.toggle('is-timer', v.mode === 'timer');
      card.classList.toggle('is-urgent', !!v.urgent);
      card.classList.toggle('is-done', !!v.done);
      card.classList.toggle('is-paused', v.mode === 'timer' && !v.running);
      card.style.setProperty('--gh-progress', (v.progress * 100).toFixed(2) + '%');
    }

    const big = q('big');
    if (big && big.textContent !== v.big) big.textContent = v.big;

    const unit = q('unit');
    if (unit) unit.textContent = v.unit;

    const sub = q('sub');
    if (sub) sub.textContent = v.sub;

    const cap = q('caption');
    if (cap) cap.textContent = v.caption;

    qa('mode-btn').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.mode === state.mode);
      b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
    });

    const toggle = q('timer-toggle');
    if (toggle) {
      const running = v.mode === 'timer' && v.running;
      toggle.classList.toggle('is-running', running);
      toggle.setAttribute('aria-label', running ? '暂停' : '开始');
      toggle.dataset.icon = running ? 'pause' : 'play';
    }

    qa('timer-only').forEach((n) => n.classList.toggle('is-hidden', state.mode !== 'timer'));
    qa('date-only').forEach((n) => n.classList.toggle('is-hidden', state.mode !== 'date'));

    document.title = v.mode === 'date' ? `还有 ${v.big} 天 · GlassHour` : `${v.big} · GlassHour`;
  }

  function startTicker() {
    if (ticker) clearInterval(ticker);
    ticker = setInterval(render, 250);
  }

  /* ---------------- 交互 ---------------- */
  function bind() {
    qa('mode-btn').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        state = await bridge.setMode(b.dataset.mode);
        render();
      });
    });

    const toggle = q('timer-toggle');
    if (toggle)
      toggle.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!state.timerRunning) {
          const left = (state.timerRemaining || state.durationSec || 0) > 0 ? state.timerRemaining || state.durationSec : state.durationSec;
          state = await bridge.setState({ timerRunning: true, timerEndsAt: Date.now() + left * 1000, timerRemaining: left });
        } else {
          const left = Math.max(0, Math.round((state.timerEndsAt - Date.now()) / 1000));
          state = await bridge.setState({ timerRunning: false, timerRemaining: left, timerEndsAt: 0 });
        }
        render();
      });

    const reset = q('timer-reset');
    if (reset)
      reset.addEventListener('click', async (e) => {
        e.stopPropagation();
        state = await bridge.setState({ timerRunning: false, timerEndsAt: 0, timerRemaining: state.durationSec });
        render();
      });

    const gear = q('settings');
    if (gear) gear.addEventListener('click', (e) => { e.stopPropagation(); bridge.openSettings(); });

    const close = q('close');
    if (close) close.addEventListener('click', (e) => { e.stopPropagation(); bridge.hide(); });

    // 拖动：整卡可拖，交互控件除外
    const drag = q('drag') || q('card');
    if (drag) {
      drag.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('[data-gh="mode-btn"],[data-gh="timer-toggle"],[data-gh="timer-reset"],[data-gh="settings"],[data-gh="close"]')) return;
        bridge.dragStart();
        const move = () => bridge.dragMove();
        const up = () => {
          bridge.dragEnd();
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        e.preventDefault();
      });
    }
  }

  async function boot() {
    state = await bridge.getState();
    if (!MOCK && bridge.onState) {
      bridge.onState((s) => {
        state = s;
        render();
      });
    }
    // 截图模式：把状态写进 location.hash 便于脚本断言
    if (MOCK) document.documentElement.dataset.mock = '1';
    bind();
    render();
    startTicker();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
