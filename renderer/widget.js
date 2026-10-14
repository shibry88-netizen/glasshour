'use strict';
/**
 * GlassHour · 组件渲染逻辑
 * 与视觉解耦：所有可视元素通过 [data-gh="名字"] 挂钩，样式由 widget.css 决定。
 * 两种模式：date（目标日期倒计时）/ timer（时长计时器）
 * v1.1：支持多条倒计时条目（卡片顶栏切换）+ 每条自定义备注
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
        stepEntry: async () => MOCK,
        setActiveEntry: async () => MOCK,
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

    const entries = Array.isArray(state.entries) && state.entries.length ? state.entries : null;
    let idx = entries ? entries.findIndex((e) => e.id === state.activeId) : 0;
    if (idx < 0) idx = 0;
    const total = entries ? entries.length : 1;
    const nav = {
      show: total > 1,
      cur: idx + 1,
      total,
      canPrev: idx > 0,
      canNext: idx < total - 1,
    };

    if (mode === 'date') {
      const target = new Date(state.targetISO).getTime();
      const left = target - now;
      const p = splitMs(left);
      const title = state.title || '目标日';
      const note = state.note || '';

      if (left <= 0) {
        return {
          mode,
          big: '00',
          unit: '天',
          sub: '已完成',
          caption: title,
          note,
          nav,
          progress: 1,
          done: true,
          urgent: false,
          secondsLeft: 0,
        };
      }
      return {
        mode,
        big: String(p.d),
        unit: '天',
        sub: `${pad(p.h)} 时 ${pad(p.m)} 分 ${pad(p.s)} 秒`,
        caption: title,
        note,
        nav,
        progress: 0,
        done: false,
        urgent: left <= 7 * 86400 * 1000,
        secondsLeft: p.total,
      };
    }

    // timer：规范里 B 模式不显示副行与备注
    let leftMs;
    if (state.timerRunning) {
      leftMs = (state.timerEndsAt || 0) - now;
    } else {
      leftMs = (state.timerRemaining || state.durationSec || 0) * 1000;
    }
    const p = splitMs(leftMs);
    const totalSec = state.durationSec || 1;
    const elapsedRatio = 1 - Math.min(1, Math.max(0, p.total / totalSec));
    const mmss = p.d > 0 ? `${p.d * 24 + p.h}:${pad(p.m)}:${pad(p.s)}` : `${pad(p.m)}:${pad(p.s)}`;
    const statusText = state.timerRunning ? '计时中' : p.total <= 0 ? '已结束' : '已暂停';
    return {
      mode,
      big: mmss,
      unit: '',
      sub: '',
      note: '',
      caption: '时长计时 · ' + statusText,
      nav,
      progress: elapsedRatio,
      done: p.total <= 0 && !state.timerRunning,
      urgent: state.timerRunning && p.total <= 60,
      secondsLeft: p.total,
      running: !!state.timerRunning,
    };
  }

  /* ---------------- 渲染 ---------------- */
  // 组件大小：写 <html data-scale>，换档只做瞬时重排 + 120ms 淡入（不逐帧 resize）
  let lastScale = null;
  function applyScaleAttr(k) {
    const el = document.documentElement;
    const next = String(k || 1);
    if (el.dataset.scale === next) return;
    el.dataset.scale = next;
    const card = q('card');
    if (card && lastScale !== null) {
      card.classList.remove('is-rescale');
      void card.offsetWidth;
      card.classList.add('is-rescale');
      setTimeout(() => card.classList.remove('is-rescale'), 140);
    }
    lastScale = next;
  }

  function render() {
    if (!state) return;
    const v = computeView();
    applyScaleAttr(state.uiScale);

    const card = q('card');
    if (card) {
      card.classList.toggle('is-date', v.mode === 'date');
      card.classList.toggle('is-timer', v.mode === 'timer');
      card.classList.toggle('is-urgent', !!v.urgent);
      card.classList.toggle('is-done', !!v.done);
      card.classList.toggle('is-paused', v.mode === 'timer' && !v.running);
      card.classList.toggle('is-locked', !!state.locked);
      // HH:MM:SS 八字符形态：迷你档要降号，否则单行溢出
      card.classList.toggle('is-long', /^\d{2}:\d{2}:\d{2}$/.test(String(v.big || '')));
      card.style.setProperty('--gh-progress', (v.progress * 100).toFixed(2) + '%');
      if (state.opacity != null) card.style.opacity = String(state.opacity);
    }

    const big = q('big');
    if (big && big.textContent !== v.big) {
      big.textContent = v.big;
      big.classList.remove('is-tick');
      void big.offsetWidth; // 重启动画
      big.classList.add('is-tick');
    }

    const unit = q('unit');
    if (unit) unit.textContent = v.unit;

    const sub = q('sub');
    if (sub) {
      const m = /^(\d{2}) 时 (\d{2}) 分 (\d{2}) 秒$/.exec(v.sub);
      sub.innerHTML = m ? `${m[1]} 时 ${m[2]} 分 <b>${m[3]}</b> 秒` : v.sub;
    }

    const cap = q('caption');
    if (cap) cap.textContent = v.caption;

    // 备注：空则不渲染（display:none），其它元素零位移
    const note = q('note');
    if (note) {
      const txt = v.note || '';
      if (note.textContent !== txt) note.textContent = txt;
      note.title = txt;
      note.classList.toggle('is-hidden', !txt);
    }

    // 多条目切换控件：只有 1 条时完全不渲染
    // 固定按钮：两态由 .is-locked 驱动样式，这里只同步可访问性属性与 tooltip 文案
    const lockBtn = q('lock');
    if (lockBtn) {
      lockBtn.setAttribute('aria-pressed', String(!!state.locked));
      lockBtn.title = state.locked ? '解除固定' : '固定位置';
      lockBtn.setAttribute('aria-label', lockBtn.title);
    }

    const nav = q('entry-nav');
    if (nav) nav.classList.toggle('is-hidden', !v.nav.show);
    const cur = q('entry-cur');
    if (cur) cur.textContent = String(v.nav.cur);
    const tot = q('entry-total');
    if (tot) tot.textContent = String(v.nav.total);
    const prev = q('entry-prev');
    if (prev) prev.disabled = !v.nav.canPrev;
    const next = q('entry-next');
    if (next) next.disabled = !v.nav.canNext;

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
      const label = running ? '暂停' : '开始';
      if (toggle.textContent !== label) toggle.textContent = label;
    }

    qa('timer-only').forEach((n) => n.classList.toggle('is-hidden', state.mode !== 'timer'));
    qa('date-only').forEach((n) => n.classList.toggle('is-hidden', state.mode !== 'date'));

    document.title =
      v.mode === 'date' ? `还有 ${v.big} 天 · ${v.caption}` : `${v.big} · GlassHour`;
  }

  /** 切换条目时，只让「内容类」元素做 120ms crossfade，控件不动 */
  function flashSwap() {
    ['caption', 'big', 'sub', 'note'].forEach((name) => {
      const el = q(name);
      if (!el) return;
      el.classList.remove('gh-swap');
      void el.offsetWidth;
      el.classList.add('gh-swap');
    });
    setTimeout(() => {
      ['caption', 'big', 'sub', 'note'].forEach((name) => {
        const el = q(name);
        if (el) el.classList.remove('gh-swap');
      });
    }, 180);
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
          const left =
            (state.timerRemaining || state.durationSec || 0) > 0
              ? state.timerRemaining || state.durationSec
              : state.durationSec;
          state = await bridge.setState({
            timerRunning: true,
            timerEndsAt: Date.now() + left * 1000,
            timerRemaining: left,
          });
        } else {
          const left = Math.max(0, Math.round((state.timerEndsAt - Date.now()) / 1000));
          state = await bridge.setState({
            timerRunning: false,
            timerRemaining: left,
            timerEndsAt: 0,
          });
        }
        render();
      });

    const reset = q('timer-reset');
    if (reset)
      reset.addEventListener('click', async (e) => {
        e.stopPropagation();
        state = await bridge.setState({
          timerRunning: false,
          timerEndsAt: 0,
          timerRemaining: state.durationSec,
        });
        render();
      });

    const prev = q('entry-prev');
    if (prev)
      prev.addEventListener('click', async (e) => {
        e.stopPropagation();
        state = await bridge.stepEntry(-1);
        flashSwap();
        render();
      });

    const next = q('entry-next');
    if (next)
      next.addEventListener('click', async (e) => {
        e.stopPropagation();
        state = await bridge.stepEntry(1);
        flashSwap();
        render();
      });

    const lockBtn = q('lock');
    if (lockBtn)
      lockBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        state = await bridge.setState({ locked: !state.locked });
        render();
      });

    // 双击卡片打开设置（很多人第一反应是点卡片本身）
    const dbl = q('drag') || q('card');
    if (dbl)
      dbl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        bridge.openSettings();
      });

    const gear = q('settings');
    if (gear)
      gear.addEventListener('click', (e) => {
        e.stopPropagation();
        bridge.openSettings();
      });

    const close = q('close');
    if (close)
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        bridge.hide();
      });

    // 拖动：整卡可拖，交互控件除外。锁定态由主进程权威拦截（这里是第一道、省个来回）
    const drag = q('drag') || q('card');
    if (drag) {
      const NO_DRAG =
        '[data-gh="mode-btn"],[data-gh="timer-toggle"],[data-gh="timer-reset"],[data-gh="settings"],[data-gh="close"],[data-gh="entry-prev"],[data-gh="entry-next"],[data-gh="lock"]';
      let activeId = null;
      const onUp = () => {
        if (activeId == null) return;
        const id = activeId;
        activeId = null;
        bridge.dragEnd();
        try {
          drag.releasePointerCapture(id);
        } catch (_) {
          /* ignore */
        }
      };
      drag.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest(NO_DRAG)) return;
        if (state && state.locked) return; // 已固定：拖不动
        activeId = e.pointerId;
        // 用 pointer capture：甩得快、指针跑到窗口外也不会丢掉 mouseup，拖动不会「断」
        try {
          drag.setPointerCapture(e.pointerId);
        } catch (_) {
          /* ignore */
        }
        bridge.dragStart();
        e.preventDefault();
      });
      drag.addEventListener('pointermove', () => {
        if (activeId == null) return;
        bridge.dragMove();
      });
      drag.addEventListener('pointerup', onUp);
      drag.addEventListener('pointercancel', onUp);
      drag.addEventListener('lostpointercapture', onUp);
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
    if (MOCK) document.documentElement.dataset.mock = '1';
    bind();
    render();
    startTicker();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
