'use strict';
/**
 * GlassHour · 桌面层策略（纯逻辑，不依赖 Electron / 不碰 FFI，方便单测）
 *
 * 「固定」到底把窗口放到哪一层，由两个输入决定：
 *   - locked       是否已固定（固定 = 钉到桌面层 + 位置锁死；解锁 = 普通窗口 + 可拖动）
 *   - desktopLayer 用户偏好：auto | workerw | bottom | normal
 *
 * auto 会给出一条「逐级回退链」，运行时按顺序试；每一级做完都会在真机上做一次
 * 「鼠标点得到吗」自检（user32!WindowFromPoint），过不了就退到下一级。
 * 目的：任何机器上都不会出现「钉到桌面之后按钮点不动」的死状态。
 */

const CHAINS = {
  auto: ['workerw', 'progman', 'sink', 'normal'],
  workerw: ['workerw', 'sink', 'normal'],
  bottom: ['sink', 'normal'],
  normal: ['normal'],
};

const LABELS = {
  workerw: '壁纸层 (WorkerW)',
  progman: '桌面窗口 (Progman)',
  sink: '桌面之上 · 普通窗口之下（兼容模式，可点击）',
  normal: '普通窗口',
  none: '未钉层',
};

const DESCRIPTIONS = {
  workerw: '挂到壁纸层：被所有窗口盖住、不进任务栏/Alt+Tab，Win+D 显示桌面也不会消失',
  progman: '挂到桌面窗口（Progman）下：语义同上，部分机器上命中测试更友好',
  sink: '不改父窗口，把窗口压在「桌面图标之上、所有普通窗口之下」：一定可点击',
  normal: '完全不改层级，只负责锁位置 / 或自由拖动',
};

/** 用户偏好 → 候选层级链（顺序即优先级） */
function chainFor(desktopLayer) {
  return (CHAINS[desktopLayer] || CHAINS.auto).slice();
}

/** 取下一个还没试过的候选；全试过返回 null */
function nextCandidate(chain, tried) {
  const done = new Set(tried || []);
  for (const c of chain) if (!done.has(c)) return c;
  return null;
}

function layerLabel(layer) {
  return LABELS[layer] || String(layer || 'none');
}

function layerDescription(layer) {
  return DESCRIPTIONS[layer] || '';
}

/** 把非法偏好收敛到合法值（老配置 / 手改 config.json 都兜住） */
function sanitizePref(pref) {
  return CHAINS[pref] ? pref : 'auto';
}

/**
 * 位置兜底：保证窗口至少有一部分落在某块屏幕的可用区里。
 * 换显示器、改分辨率、拔掉外接屏之后，窗口不至于跑到看不见的地方。
 */
function clampToWorkArea(x, y, w, h, workAreas, minVisible) {
  const min = Number.isFinite(minVisible) ? minVisible : 80;
  const areas = Array.isArray(workAreas) && workAreas.length
    ? workAreas
    : [{ x: 0, y: 0, width: 1920, height: 1080 }];
  for (const wa of areas) {
    const ox = Math.min(x + w, wa.x + wa.width) - Math.max(x, wa.x);
    const oy = Math.min(y + h, wa.y + wa.height) - Math.max(y, wa.y);
    if (ox >= min && oy >= min) return { x: Math.round(x), y: Math.round(y), moved: false };
  }
  const wa = areas[0];
  return {
    x: Math.round(wa.x + wa.width - w - 24),
    y: Math.round(wa.y + wa.height - h - 40),
    moved: true,
  };
}

module.exports = {
  CHAINS,
  chainFor,
  nextCandidate,
  layerLabel,
  layerDescription,
  sanitizePref,
  clampToWorkArea,
};
