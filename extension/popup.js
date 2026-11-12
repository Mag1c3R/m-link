import { BRAND } from './config.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = null;
let status = { state: 'off' };
let testing = null;
let filter = '';
let timerId = null;
let helperMissing = null; // текст ошибки, если при пинге выяснилось, что помощника нет
const collapsed = new Set(readCollapsed());

function readCollapsed() {
  try { return JSON.parse(localStorage.getItem('collapsed') || '[]'); } catch { return []; }
}
function saveCollapsed() {
  try { localStorage.setItem('collapsed', JSON.stringify([...collapsed])); } catch { /* ничего */ }
}

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload }).then((r) => {
    if (!r) throw new Error('Нет ответа от расширения');
    if (!r.ok) throw Object.assign(new Error(r.error), { code: r.code });
    return r;
  });
}

function onError(e) {
  if (e.code === 'no_helper') {
    helperMissing = e.message;
    renderHero();
  } else {
    toast(e.message, true);
  }
}

function toast(text, isError = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, isError ? 5000 : 2500);
}

async function busy(btn, fn) {
  btn.disabled = true;
  btn.classList.add('spin');
  try { return await fn(); }
  catch (e) { onError(e); }
  finally { btn.disabled = false; btn.classList.remove('spin'); }
}

// ---------- форматирование ----------

function fmtBytes(n) {
  if (!n) return '0';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
}
function fmtDate(sec) {
  return new Date(sec * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtAgo(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return [h, m, r].map((x) => String(x).padStart(2, '0')).join(':');
}
function pingClass(ms) {
  if (ms == null) return '';
  if (ms < 0) return 'bad';
  if (ms < 300) return 'good';
  if (ms < 800) return 'mid';
  return 'bad';
}
function pingText(ms) {
  if (ms == null) return '';
  if (ms < 0) return 'нет';
  return ms + ' мс';
}

const MODE_TEXT = {
  all: 'Все сайты через прокси',
  except: 'Все сайты, кроме исключений',
  only: 'Только выбранные сайты',
};

// ---------- отрисовка ----------

function allNodes() {
  return [...state.subs.flatMap((s) => s.nodes || []), ...state.manual];
}

function renderHero() {
  const hero = $('hero');
  const st = status.state;
  hero.className = 'hero ' + st;
  const selected = allNodes().find((n) => n.id === state.selectedId);
  const nodeName = status.nodeName && st !== 'off' ? status.nodeName : selected?.name;

  const titles = { off: 'Отключено', connecting: 'Подключение…', on: 'Подключено', error: 'Ошибка' };
  $('status-text').textContent = titles[st] || 'Отключено';
  if (st === 'on' && status.since) $('status-text').textContent += ' · ' + fmtDuration(Date.now() - status.since);

  $('node-line').textContent = nodeName ? nodeName + (selected ? ' · ' + selected.label : '') : 'Узел не выбран';
  $('power').setAttribute('aria-label', st === 'on' ? 'Отключить' : 'Подключить');
  $('power').disabled = st === 'connecting';
  $('mode-chip').textContent = MODE_TEXT[state.settings.mode] || MODE_TEXT.all;

  clearInterval(timerId);
  if (st === 'on') timerId = setInterval(renderHero, 1000);

  const banner = $('banner');
  const noHelper = (st === 'error' && status.code === 'no_helper') || (helperMissing && st !== 'on');
  if (noHelper) {
    banner.hidden = false;
    banner.innerHTML = `<b>Помощник не установлен.</b> Без него не работают подключение и замер пинга:
      браузер сам не умеет VLESS и Hysteria2.
      <div class="row"><a href="${esc(BRAND.helperDownloadUrl)}" target="_blank" rel="noopener">Скачать помощник</a></div>
      <div class="hint-small">Распакуй архив, запусти install.sh (macOS/Linux) или install.bat (Windows) и перезапусти браузер.</div>`;
  } else if (st === 'error' && status.error) {
    banner.hidden = false;
    banner.textContent = status.error;
  } else {
    banner.hidden = true;
  }
}

function nodeRow(n, canDelete) {
  const ms = state.latency[n.id];
  const sel = n.id === state.selectedId;
  const cls = ['node', sel && 'selected', sel && status.state === 'on' && 'active', n.unsupported && 'unsupported']
    .filter(Boolean).join(' ');
  const title = n.unsupported ? n.unsupported : `${n.server}:${n.port}`;
  return `<div class="${cls}" role="button" tabindex="0" data-node="${esc(n.id)}" title="${esc(title)}">
    <span class="dot"></span>
    <span class="node-name">${esc(n.name)}</span>
    <span class="badge">${esc(n.unsupported ? 'не поддерж.' : n.label)}</span>
    <span class="ping ${pingClass(ms)}">${pingText(ms)}</span>
    ${canDelete ? `<button class="icon-btn del" data-del-manual="${esc(n.id)}" title="Удалить узел" aria-label="Удалить узел">${ICON.x}</button>` : ''}
  </div>`;
}

const ICON = {
  chev: '<svg class="chev" viewBox="0 0 24 24" width="16" height="16"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="13" height="13"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6 6 18"/></svg>',
};

function matches(n) {
  if (!filter) return true;
  const q = filter.toLowerCase();
  return n.name.toLowerCase().includes(q) || (n.label || '').toLowerCase().includes(q) || (n.server || '').includes(q);
}

function groupHtml({ id, name, meta, nodes, traffic, canDelete, actions }) {
  const shown = nodes.filter(matches);
  if (filter && !shown.length) return '';
  const isCollapsed = collapsed.has(id) && !filter;
  return `<div class="group ${isCollapsed ? 'collapsed' : ''}" data-group="${esc(id)}">
    <div class="group-head" data-toggle="${esc(id)}">
      ${ICON.chev}
      <div class="group-title">
        <div class="group-name">${esc(name)}</div>
        <div class="group-meta">${meta}</div>
      </div>
      ${actions}
    </div>
    ${traffic != null ? `<div class="traffic"><i style="width:${Math.min(100, traffic)}%"></i></div>` : ''}
    <div class="nodes">${shown.map((n) => nodeRow(n, canDelete)).join('')}</div>
  </div>`;
}

function subMeta(sub) {
  const parts = [`${sub.nodes.length} узл.`];
  const ui = sub.userinfo;
  if (ui && (ui.total || ui.download || ui.upload)) {
    const used = (ui.upload || 0) + (ui.download || 0);
    parts.push(ui.total ? `${fmtBytes(used)} из ${fmtBytes(ui.total)}` : fmtBytes(used));
  }
  if (ui?.expire) parts.push('до ' + fmtDate(ui.expire));
  if (sub.error) return parts.join(' · ') + ` · <span class="err" title="${esc(sub.error)}">ошибка обновления</span>`;
  parts.push(fmtAgo(sub.updatedAt));
  return esc(parts.join(' · '));
}

function renderList() {
  const list = $('list');
  const groups = [];
  for (const sub of state.subs) {
    const ui = sub.userinfo;
    const traffic = ui?.total ? (((ui.upload || 0) + (ui.download || 0)) / ui.total) * 100 : null;
    const isTesting = testing === sub.id || testing === 'all';
    groups.push(groupHtml({
      id: sub.id,
      name: sub.name,
      meta: subMeta(sub),
      nodes: sub.nodes,
      traffic,
      canDelete: false,
      actions: `
        <button class="icon-btn ${isTesting ? 'spin' : ''}" data-test="${esc(sub.id)}" title="Проверить задержку" aria-label="Проверить задержку">${ICON.bolt}</button>
        <button class="icon-btn" data-update="${esc(sub.url)}" title="Обновить" aria-label="Обновить">${ICON.refresh}</button>
        <button class="icon-btn danger" data-remove-sub="${esc(sub.id)}" title="Удалить подписку" aria-label="Удалить подписку">${ICON.trash}</button>`,
    }));
  }
  if (state.manual.length) {
    groups.push(groupHtml({
      id: 'manual',
      name: 'Мои узлы',
      meta: esc(`${state.manual.length} узл. · добавлены вручную`),
      nodes: state.manual,
      canDelete: true,
      actions: `<button class="icon-btn ${testing === 'manual' || testing === 'all' ? 'spin' : ''}" data-test="manual" title="Проверить задержку" aria-label="Проверить задержку">${ICON.bolt}</button>`,
    }));
  }

  const hasAny = state.subs.length || state.manual.length;
  if (!hasAny) {
    list.innerHTML = `<div class="empty">
      <h3>Пока пусто</h3>
      <p>Добавь ссылку на подписку или узел кнопкой «+»</p>
    </div>${promoCard()}`;
  } else {
    const html = groups.join('');
    list.innerHTML = html || '<div class="empty"><p>Ничего не найдено</p></div>';
  }
  $('add-panel').hidden = hasAny ? $('add-panel').hidden : false;
  for (const id of ['search', 'test-all', 'update-all']) $(id).style.visibility = hasAny ? '' : 'hidden';
}

function promoCard() {
  const p = BRAND.promo;
  if (!p.enabled) return '';
  return `<div class="promo">
    <b>${esc(p.title)}</b>
    <p>${esc(p.text)}</p>
    <a class="btn primary small" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.button)}</a>
  </div>`;
}

function renderFoot() {
  const p = BRAND.promo;
  const hasAny = state.subs.length || state.manual.length;
  const left = `${allNodes().filter((n) => !n.unsupported).length} узлов`;
  const right = p.enabled && hasAny ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.button)} →</a>` : '';
  $('foot').innerHTML = `<span>${left}</span>${right}`;
}

function render() {
  if (!state) return;
  renderHero();
  renderList();
  renderFoot();
}

// ---------- настройки ----------

let settingsMode = 'except';

function fillSettings() {
  const s = state.settings;
  settingsMode = s.mode;
  $('except-list').value = s.exceptList;
  $('only-list').value = s.onlyList;
  $('port').value = s.port;
  $('update-hours').value = s.updateHours;
  $('user-agent').value = s.userAgent;
  syncModeSeg();
}

function syncModeSeg() {
  for (const b of $('mode-seg').querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === settingsMode);
  $('except-field').hidden = settingsMode !== 'except';
  $('only-field').hidden = settingsMode !== 'only';
}

async function loadHelperInfo() {
  const box = $('helper-box');
  box.textContent = 'Проверяю…';
  try {
    const r = await send('helperInfo');
    if (!r.installed) {
      box.innerHTML = `<span class="no">Не установлен.</span> ${esc(r.error || '')}<br><a href="${esc(BRAND.helperDownloadUrl)}" target="_blank" rel="noopener">Скачать помощник</a>`;
    } else if (r.coreError) {
      box.innerHTML = `<span class="ok">Помощник ${esc(r.version)}</span>, но <span class="no">ядро sing-box не найдено</span>: ${esc(r.coreError)}`;
    } else {
      box.innerHTML = `<span class="ok">Работает</span> · помощник ${esc(r.version)} · sing-box ${esc(r.core)}<br><code>${esc(r.corePath)}</code>`;
    }
  } catch (e) {
    box.textContent = e.message;
  }
}

function openSettings() {
  fillSettings();
  $('view-main').hidden = true;
  $('view-settings').hidden = false;
  loadHelperInfo();
}

function closeSettings() {
  $('view-settings').hidden = true;
  $('view-main').hidden = false;
}

// ---------- события ----------

$('power').addEventListener('click', async () => {
  try {
    if (status.state === 'on') await send('disconnect');
    else await send('connect');
  } catch (e) {
    onError(e);
  }
});

$('toggle-add').addEventListener('click', () => {
  const p = $('add-panel');
  p.hidden = !p.hidden;
  if (!p.hidden) $('add-input').focus();
});

$('add-submit').addEventListener('click', async () => {
  const text = $('add-input').value.trim();
  if (!text) return;
  const btn = $('add-submit');
  btn.disabled = true;
  btn.textContent = 'Загружаю…';
  try {
    const r = await send('add', { text });
    $('add-input').value = '';
    $('add-panel').hidden = true;
    toast(`Добавлено узлов: ${r.added}` + (r.errors?.length ? `, пропущено: ${r.errors.length}` : ''));
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Добавить';
  }
});

$('add-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('add-submit').click();
});

$('search').addEventListener('input', (e) => { filter = e.target.value.trim(); renderList(); });

$('test-all').addEventListener('click', (e) => busy(e.currentTarget, () => send('test', { group: null })));
$('update-all').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  await send('updateAll');
  toast('Подписки обновлены');
}));

$('list').addEventListener('click', async (e) => {
  const t = e.target.closest('[data-test],[data-update],[data-remove-sub],[data-del-manual],[data-node],[data-toggle]');
  if (!t) return;
  if (t.dataset.test) { e.stopPropagation(); return busy(t, () => send('test', { group: t.dataset.test })); }
  if (t.dataset.update) { e.stopPropagation(); return busy(t, async () => { await send('updateSub', { url: t.dataset.update }); toast('Подписка обновлена'); }); }
  if (t.dataset.removeSub) {
    e.stopPropagation();
    if (t.dataset.armed) return send('removeSub', { id: t.dataset.removeSub });
    t.dataset.armed = '1';
    t.title = 'Нажми ещё раз, чтобы удалить';
    toast('Нажми ещё раз, чтобы удалить подписку');
    setTimeout(() => { delete t.dataset.armed; }, 3000);
    return;
  }
  if (t.dataset.delManual) { e.stopPropagation(); return send('removeManual', { id: t.dataset.delManual }); }
  if (t.dataset.node) {
    if (t.classList.contains('unsupported')) return toast(t.title, true);
    return send('select', { id: t.dataset.node }).catch((err) => toast(err.message, true));
  }
  if (t.dataset.toggle) {
    const id = t.dataset.toggle;
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    saveCollapsed();
    renderList();
  }
});

$('list').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset?.node) { e.preventDefault(); e.target.click(); }
});

$('open-settings').addEventListener('click', openSettings);
$('mode-chip').addEventListener('click', openSettings);
$('close-settings').addEventListener('click', closeSettings);
$('mode-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b) return;
  e.preventDefault();
  settingsMode = b.dataset.mode;
  syncModeSeg();
});
$('save-settings').addEventListener('click', async () => {
  try {
    await send('saveSettings', {
      settings: {
        mode: settingsMode,
        exceptList: $('except-list').value,
        onlyList: $('only-list').value,
        port: $('port').value,
        updateHours: $('update-hours').value,
        userAgent: $('user-agent').value,
      },
    });
    toast('Сохранено');
    closeSettings();
  } catch (e) {
    toast(e.message, true);
  }
});

// ---------- загрузка и подписка на изменения ----------

async function load() {
  const local = await chrome.storage.local.get({
    subs: [], manual: [], selectedId: null, latency: {}, settings: {},
  });
  const session = await chrome.storage.session.get({ status: { state: 'off' }, testing: null });
  state = {
    ...local,
    settings: { mode: 'except', exceptList: '', onlyList: '', port: 10808, updateHours: 12, userAgent: BRAND.userAgent, ...local.settings },
  };
  status = session.status;
  testing = session.testing;
  render();
}

chrome.storage.onChanged.addListener(() => load());
$('brand-name').textContent = BRAND.name;
load();
