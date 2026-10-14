'use strict';
/**
 * GlassHour · 桌面层策略纯逻辑测试（不需要 electron / 不需要 Windows）
 *
 * 用法： node test/layer_policy.test.js
 */
const path = require('path');
const {
  chainFor,
  nextCandidate,
  sanitizePref,
  clampToWorkArea,
  layerLabel,
  layerDescription,
} = require(path.join(__dirname, '..', 'electron', 'layer-policy.js'));

let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) fails++;
  console.log(`   ${cond ? '✅' : '❌'} ${msg}${extra ? '  ' + extra : ''}`);
};

console.log('\n===== 1. 偏好 → 候选层级链 =====');
const auto = chainFor('auto');
ok(
  auto.join(' > ') === 'workerw > progman > sink > normal',
  `auto 的逐级回退顺序：${auto.join(' > ')}`
);
ok(chainFor('workerw').includes('workerw') && !chainFor('workerw').includes('progman'), '显式选 workerw 不再绕 progman');
ok(chainFor('bottom').join(' > ') === 'sink > normal', `兼容模式只在「桌面之上/normal」里选：${chainFor('bottom').join(' > ')}`);
ok(chainFor('normal').join('') === 'normal', '普通窗口模式只有一级');
ok(chainFor('不存在的值').join(' > ') === auto.join(' > '), '非法偏好回落到 auto');
ok(chainFor('auto') !== chainFor('auto'), '每次返回新数组（调用方能随便改，不会污染常量）');

console.log('\n===== 2. 逐级回退推进 =====');
const chain = chainFor('auto');
let tried = [];
const step = () => {
  const c = nextCandidate(chain, tried);
  if (c) tried.push(c);
  return c;
};
ok(step() === 'workerw', '第 1 级 workerw');
ok(step() === 'progman', '第 2 级 progman');
ok(step() === 'sink', '第 3 级 sink');
ok(step() === 'normal', '第 4 级 normal');
ok(step() === null, '试完返回 null（上层就知道该收尾了）');
ok(nextCandidate([], ['workerw']) === null, '空链返回 null 不炸');

console.log('\n===== 3. 偏好值清洗 =====');
ok(sanitizePref('auto') === 'auto' && sanitizePref('workerw') === 'workerw', '合法值原样返回');
ok(sanitizePref(undefined) === 'auto' && sanitizePref(123) === 'auto' && sanitizePref('BOTTOM') === 'auto', '脏值（手改 config.json）一律回 auto');

console.log('\n===== 4. 位置兜底（换显示器 / 改分辨率后别丢窗口）=====');
const work = [{ x: 0, y: 0, width: 1920, height: 1080 }];
ok(JSON.stringify(clampToWorkArea(1400, 700, 460, 320, work)) === JSON.stringify({ x: 1400, y: 700, moved: false }), '窗口在屏幕里 → 原样不动');
const off = clampToWorkArea(5000, 3000, 460, 320, work);
ok(off.moved === true && off.x === 1920 - 460 - 24 && off.y === 1080 - 320 - 40, `完全跑出屏幕 → 拉回右下角 ${off.x},${off.y}`);
const partly = clampToWorkArea(1800, 1000, 460, 320, work);
ok(partly.moved === false, '还露着 120×80 px 的一角就尊重用户位置，不硬拽');
const tiny = clampToWorkArea(1910, 1060, 460, 320, work);
ok(tiny.moved === true, '只剩 10px 露头 → 判定为「看不见」，拉回来');
const twoScreens = [
  { x: 0, y: 0, width: 1920, height: 1080 },
  { x: -1920, y: 0, width: 1920, height: 1080 },
];
ok(clampToWorkArea(-1500, 400, 460, 320, twoScreens).moved === false, '副屏在左边（负坐标）也认得出来');
ok(clampToWorkArea(5000, 3000, 460, 320, []).moved === true, '拿不到显示器列表也不炸');

console.log('\n===== 5. 文案 =====');
ok(layerLabel('sink').includes('兼容模式'), `sink 的中文名：${layerLabel('sink')}`);
ok(layerDescription('workerw').includes('Win+D') || layerDescription('workerw').length > 0, '每一级都有说明文案');
ok(layerLabel('unknown-xyz') === 'unknown-xyz', '未知层级原样显示，不吞信息');

console.log(`\n===== 测试结束：${fails === 0 ? '全部通过 ✅' : fails + ' 处失败 ❌'} =====`);
process.exit(fails === 0 ? 0 : 1);
