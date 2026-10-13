'use strict';
/* GlassHour · 设置窗口逻辑（v1.1：条目管理 + 备注） */
(function () {
  const $ = (id) => document.getElementById(id);
  const gh = window.gh;
  let state = null;
  let userData = '';
  let editingId = null; // null = 新增
  let pendingDelete = null;

  const pad = (n) => String(n).padStart(2, '0');

  const ICON_EDIT =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11.2 2.3l2.5 2.5M12.4 1.1l2.5 2.5-8.3 8.3-3.2.7.7-3.2z"/></svg>';
  const ICON_DEL =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11M6.5 4V2.5h3V4M4.2 4l.6 9.2h6.4l.6-9.2M6.6 6.6v4.4M9.4 6.6v4.4"/></svg>';

  /* ---------- 时间字符串：统一用「本地朴素」格式 YYYY-MM-DDTHH:mm:ss ---------- */
  function splitISO(iso) {
    const s = String(iso || '');
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(s);
    if (m) return { date: m[1], time: m[2] };
    const d = new Date(s);
    if (isNaN(d.getTime())) return { date: '', time: '00:00' };
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    };
  }
  const joinISO = (date, time) => (date ? `${date}T${time || '00:00'}:00` : '');

  function remainText(iso) {
    const t = new Date(iso).getTime();
    if (isNaN(t)) return '日期无效';
    const left = t - Date.now();
    if (left <= 0) return '已完成';
    const d = Math.floor(left / 86400000);
    const h = Math.floor((left % 86400000) / 3600000);
    return `剩 ${d} 天 ${h} 小时`;
  }

  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function status(text, ms) {
    $('status').textContent = text;
    clearTimeout(status._t);
    status._t = setTimeout(() => {
      if ($('status').textContent === text) $('status').textContent = '';
    }, ms || 4200);
  }

  /* ---------- 条目列表 ---------- */
  function renderList() {
    const box = $('entryList');
    const list = (state && state.entries) || [];
    if (!list.length) {
      box.innerHTML = '<div class="empty">还没有条目</div>';
      return;
    }
    box.innerHTML = list
      .map((e) => {
        const active = e.id === state.activeId;
        const dt = splitISO(e.targetISO);
        return `<div class="eitem${active ? ' is-active' : ''}" data-id="${esc(e.id)}" title="点击设为当前">
          <div class="eitem__info">
            <div class="eitem__name">${esc(e.title)}${active ? '<span class="eitem__tag">当前</span>' : ''}</div>
            <div class="eitem__meta">${dt.date} ${dt.time} · <b>${remainText(e.targetISO)}</b></div>
          </div>
          <button class="iconbtn" data-act="edit" title="编辑">${ICON_EDIT}</button>
          <button class="iconbtn" data-act="del" title="删除">${ICON_DEL}</button>
        </div>`;
      })
      .join('');
  }

  function findEntry(id) {
    return ((state && state.entries) || []).find((e) => e.id === id) || null;
  }

  /* ---------- 编辑表单 ---------- */
  function openForm(id) {
    editingId = id || null;
    const e = id ? findEntry(id) : null;
    $('fTitle').value = e ? e.title : '';
    const dt = e ? splitISO(e.targetISO) : splitISO(toLocalNaive(Date.now() + 30 * 86400000));
    $('fDate').value = dt.date;
    $('fTime').value = dt.time;
    $('fNote').value = e ? e.note || '' : '';
    $('fDelete').style.display = e ? '' : 'none';
    $('entryForm').classList.remove('is-hidden');
    updateCounts();
    $('fTitle').focus();
  }

  function closeForm() {
    editingId = null;
    $('entryForm').classList.add('is-hidden');
  }

  function toLocalNaive(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function updateCounts() {
    const t = $('fTitle').value.length;
    $('fTitleCount').textContent = t + '/20';
    $('fTitleCount').classList.toggle('is-warn', t >= 20);

    const n = $('fNote').value.length;
    $('fNoteCount').textContent = n + '/40';
    $('fNoteCount').classList.toggle('is-warn', n >= 40);
    // 超过卡片可显示的宽度就提示会被截断（中文约 18 字 / 西文约 34 字）
    $('fNoteHint').style.display = n > 18 ? '' : 'none';
  }

  async function saveForm() {
    const title = $('fTitle').value.trim() || '未命名';
    const targetISO = joinISO($('fDate').value, $('fTime').value);
    const note = $('fNote').value.trim();
    if (!targetISO) {
      $('fDate').focus();
      $('fDate').style.borderColor = 'rgba(201,164,91,.85)';
      setTimeout(() => { $('fDate').style.borderColor = ''; }, 2600);
      status('⚠ 还没选截止日期 —— 选好再点「保存」', 6000);
      return;
    }
    if (editingId) {
      state = await gh.updateEntry(editingId, { title, targetISO, note });
      await gh.setActiveEntry(editingId);
      state = await gh.getState();
      status('已保存 ✓');
    } else {
      state = await gh.addEntry({ title, targetISO, note });
      status('已新增并设为当前 ✓');
    }
    closeForm();
    renderList();
    paintScaffold();
    const e = findEntry(editingId || state.activeId);
    if (e) status('已保存并生效 ✓  ' + e.title + ' · ' + e.targetISO.slice(0, 16).replace('T', ' '), 6000);
  }

  /* ---------- 删除确认 ---------- */
  function askDelete(id) {
    const e = findEntry(id);
    if (!e) return;
    if (((state && state.entries) || []).length <= 1) {
      status('至少要保留一条倒计时');
      return;
    }
    pendingDelete = id;
    $('confirmName').textContent = e.title.length > 12 ? e.title.slice(0, 12) + '…' : e.title;
    $('confirm').classList.remove('is-hidden');
  }

  function closeConfirm() {
    pendingDelete = null;
    $('confirm').classList.add('is-hidden');
  }

  /* ---------- 其余设置 ---------- */
  function paintScaffold() {
    document.querySelectorAll('#modeSeg button').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.mode === state.mode)
    );
    $('durMin').value = Math.floor((state.durationSec || 0) / 60);
    $('durSec').value = (state.durationSec || 0) % 60;
    $('opacity').value = Math.round((state.opacity == null ? 1 : state.opacity) * 100);
    $('opacityVal').textContent = $('opacity').value + '%';
    $('layer').value = state.desktopLayer || 'auto';
    $('autostart').checked = !!state.loginItem;
    $('ver').textContent = 'v' + state.version;
    $('layerInfo').textContent = state.desktopLayer || '—';
    if (state.userData) userData = state.userData;
  }

  function paint(s) {
    state = s;
    if (s.userData) userData = s.userData;
    renderList();
    paintScaffold();
  }

  /* ---------- 事件绑定 ---------- */
  $('entryList').addEventListener('click', async (ev) => {
    const item = ev.target.closest('.eitem');
    if (!item) return;
    const id = item.dataset.id;
    const act = ev.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'edit') openForm(id);
      else askDelete(id);
      return;
    }
    if (id !== state.activeId) {
      paint(await gh.setActiveEntry(id));
      status('已切换当前倒计时');
    } else {
      openForm(id);
    }
  });

  $('addEntry').addEventListener('click', () => openForm(null));
  $('fCancel').addEventListener('click', closeForm);
  $('fSave').addEventListener('click', saveForm);
  $('fDelete').addEventListener('click', () => {
    if (editingId) {
      const id = editingId;
      closeForm();
      askDelete(id);
    }
  });
  $('fTitle').addEventListener('input', updateCounts);
  $('fNote').addEventListener('input', updateCounts);

  $('confirmCancel').addEventListener('click', closeConfirm);
  $('confirmDelete').addEventListener('click', async () => {
    const id = pendingDelete;
    closeConfirm();
    if (!id) return;
    const r = await gh.removeEntry(id);
    if (r && r.state) paint(r.state);
    status(r && r.ok ? '已删除' : '删除失败');
  });
  $('confirm').addEventListener('click', (e) => {
    if (e.target === $('confirm')) closeConfirm();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('confirm').classList.contains('is-hidden')) closeConfirm();
    else if (!$('entryForm').classList.contains('is-hidden')) closeForm();
  });

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

  $('layer').addEventListener('change', async () => {
    paint(await gh.setState({ desktopLayer: $('layer').value }));
    status('桌面层策略已切换');
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
    if (userData) {
      await gh.openPath(userData);
      status('已打开配置目录');
    } else {
      status('配置目录：%APPDATA%\\GlassHour');
    }
  });

  $('hideWidget').addEventListener('click', () => gh.hide());

  gh.onState(paint);
  gh.getState().then((s) => {
    paint(s);
    // 只有一条时直接把编辑表单摊开 —— 用户打开设置多半就是为了改这条的日期
    if ((s.entries || []).length === 1) openForm(s.activeId);
  });
})();
