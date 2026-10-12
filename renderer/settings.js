'use strict';
/* GlassHour · 设置窗口逻辑 */
(function () {
  const $ = (id) => document.getElementById(id);
  const gh = window.gh;
  let state = null;
  let userData = '';

  function toLocalInput(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function fromLocalInput(v) {
    // datetime-local 视为本地时间
    return v ? new Date(v).toISOString() : new Date().toISOString();
  }

  function paint(s) {
    state = s;
    if (s.userData) userData = s.userData;
    document.querySelectorAll('#modeSeg button').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.mode === s.mode)
    );
    $('title').value = s.title || '';
    $('target').value = toLocalInput(s.targetISO);
    $('durMin').value = Math.floor((s.durationSec || 0) / 60);
    $('durSec').value = (s.durationSec || 0) % 60;
    $('opacity').value = Math.round((s.opacity == null ? 1 : s.opacity) * 100);
    $('opacityVal').textContent = $('opacity').value + '%';
    $('layer').value = s.desktopLayer || 'auto';
    $('autostart').checked = !!s.loginItem;
    $('ver').textContent = 'v' + s.version;
    $('layerInfo').textContent = s.desktopLayer || '—';
  }

  async function refresh() {
    paint(await gh.getState());
  }

  function status(text) {
    $('status').textContent = text;
    setTimeout(() => {
      if ($('status').textContent === text) $('status').textContent = '';
    }, 2400);
  }

  document.querySelectorAll('#modeSeg button').forEach((b) =>
    b.addEventListener('click', async () => {
      paint(await gh.setMode(b.dataset.mode));
      status('已切换模式');
    })
  );

  $('applyDuration').addEventListener('click', async () => {
    const sec = Math.max(
      0,
      (parseInt($('durMin').value || '0', 10) || 0) * 60 + (parseInt($('durSec').value || '0', 10) || 0)
    );
    if (sec <= 0) return status('时长不能为 0');
    paint(
      await gh.setState({
        durationSec: sec,
        timerRunning: false,
        timerEndsAt: 0,
        timerRemaining: sec,
      })
    );
    status('时长已设为 ' + Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒');
  });

  $('opacity').addEventListener('input', async () => {
    $('opacityVal').textContent = $('opacity').value + '%';
    await gh.setState({ opacity: parseInt($('opacity').value, 10) / 100 });
  });

  $('autostart').addEventListener('change', async () => {
    const r = await gh.setLoginItem($('autostart').checked);
    $('autostart').checked = !!(r && r.openAtLogin);
    if (r && r.userData) userData = r.userData;
    status($('autostart').checked ? '已开启开机自启' : '已关闭开机自启');
  });

  $('resetPos').addEventListener('click', async () => {
    await gh.resetPosition();
    status('窗口已回到右下角');
  });

  $('openCfg').addEventListener('click', async () => {
    if (!userData && state && state.userData) userData = state.userData;
    if (userData) {
      await gh.openPath(userData);
      status('已打开配置目录');
    } else {
      status('配置目录：%APPDATA%\\GlassHour');
    }
  });

  $('hideWidget').addEventListener('click', () => gh.hide());

  $('save').addEventListener('click', async () => {
    const sec = Math.max(
      0,
      (parseInt($('durMin').value || '0', 10) || 0) * 60 + (parseInt($('durSec').value || '0', 10) || 0)
    );
    paint(
      await gh.setState({
        title: $('title').value || '目标日',
        targetISO: fromLocalInput($('target').value),
        durationSec: sec || 1500,
        desktopLayer: $('layer').value,
        opacity: parseInt($('opacity').value, 10) / 100,
      })
    );
    status('已保存 ✓');
  });

  gh.onState(paint);
  refresh();
})();
