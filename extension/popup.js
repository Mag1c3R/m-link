import { BRAND, sanitizePromo } from './config.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const VERSION = chrome.runtime.getManifest().version;
const DEFAULT_UA = `${BRAND.name}/${VERSION}`;

let state = null;
let status = { state: 'off' };
let testing = null; // { group, count } во время замера пинга
let filter = '';
let timerId = null;
let helper = null; // ответ helperInfo: установлен ли помощник и какой версии
let platform = null; // { os, arch }
// Порядок узлов на момент запуска замера: пока пинг приходит, строки не прыгают.
const orderSnapshot = new Map();
const collapsed = new Set(readStored('collapsed', []));

function readStored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; }
}
function writeStored(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ничего */ }
}

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload }).then((r) => {
    if (!r) throw new Error('Нет ответа от расширения');
    if (!r.ok) throw Object.assign(new Error(r.error), { code: r.code });
    return r;
  });
}

// Ошибки «нет помощника» и «помощник устарел» показываем карточкой установки, остальные — всплывающим сообщением.
function onError(e) {
  if (e.code === 'no_helper') {
    helper = { installed: false, code: e.code, error: e.message };
    renderSetup();
    renderHero();
  } else if (e.code === 'old_helper') {
    helper = { ...(helper || {}), installed: true, outdated: true };
    renderSetup();
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

function promo() {
  const remote = sanitizePromo(state?.remote?.promo);
  return remote || BRAND.promo;
}

// Какую карточку про помощник показывать: install | required | core | update | null
function setupMode() {
  if (!helper) return null;
  if (!helper.installed) return 'install';
  if (helper.outdated) return 'required';
  if (helper.coreError) return 'core';
  if (helper.updateAvailable && readStored('dismissedHelper', '') !== helper.latest) return 'update';
  return null;
}

function archiveName() {
  if (!platform) return null;
  if (platform.os === 'win') return 'm-link-helper-windows-amd64.zip';
  const arch = platform.arch === 'arm64' ? 'arm64' : platform.arch === 'x86-64' ? 'amd64' : null;
  if (!arch) return null;
  if (platform.os === 'mac') return `m-link-helper-darwin-${arch}.tar.gz`;
  if (platform.os === 'linux') return `m-link-helper-linux-${arch}.tar.gz`;
  return null;
}

function installSteps() {
  const file = archiveName();
  const url = file ? `${BRAND.downloadBase}/${file}` : BRAND.releasesUrl;
  if (platform?.os === 'win') {
    return `<ol class="steps">
        <li>Скачай архив и распакуй его целиком</li>
        <li>Запусти <b>install.bat</b> из распакованной папки</li>
      </ol>
      <div class="actions">
        <a class="btn primary small" href="${esc(url)}" target="_blank" rel="noopener">Скачать для Windows</a>
        <button class="btn small" data-check>Проверить</button>
      </div>`;
  }
  if (platform?.os === 'mac' || platform?.os === 'linux') {
    return `<p>Открой «Терминал», вставь команду и нажми Enter:</p>
      <div class="cmd"><code id="install-cmd">${esc(BRAND.installCommand)}</code></div>
      <div class="actions">
        <button class="btn primary small" data-copy>Скопировать команду</button>
        <button class="btn small" data-check>Проверить</button>
        ${file ? `<a class="link" href="${esc(url)}" target="_blank" rel="noopener">или скачать архив</a>` : ''}
      </div>`;
  }
  return `<p>Помощник есть для Windows, macOS и Linux.</p>
    <div class="actions">
      <a class="btn primary small" href="${esc(BRAND.releasesUrl)}" target="_blank" rel="noopener">Открыть страницу загрузки</a>
      <button class="btn small" data-check>Проверить</button>
    </div>`;
}

function renderSetup() {
  const box = $('setup');
  const mode = setupMode();
  if (!mode) { box.hidden = true; return; }
  let head;
  if (mode === 'install') {
    const other = helper.code && helper.code !== 'no_helper' ? `<div class="err">${esc(helper.error || '')}</div>` : '';
    head = `<h4>Установи помощник</h4>
      <p>Браузер сам не умеет VLESS, Hysteria2 и другие протоколы. Их обслуживает небольшая программа с открытым кодом. Ставится один раз.</p>${other}`;
  } else if (mode === 'required') {
    head = `<h4>Обнови помощник</h4>
      <p>${helper.version ? `Установлена версия ${esc(helper.version)}, а` : 'Установленная версия устарела:'} этой версии расширения нужна ${esc(BRAND.minHelper)} или новее. Установи помощник заново:</p>`;
  } else if (mode === 'core') {
    head = `<h4>Не найден sing-box</h4>
      <p>Помощник установлен, но рядом с ним нет ядра sing-box. Установи помощник заново, ядро входит в комплект:</p>`;
  } else {
    head = `<button class="icon-btn close" data-dismiss title="Скрыть" aria-label="Скрыть">${ICON.x}</button>
      <h4>Доступен помощник ${esc(helper.latest)}</h4>
      <p>У тебя версия ${esc(helper.version)}. Чтобы обновить, установи помощник заново тем же способом:</p>`;
  }
  box.className = 'setup' + (mode === 'update' ? ' light' : '');
  box.innerHTML = head + installSteps();
  box.hidden = false;
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

  // Про отсутствие помощника рассказывает карточка установки, дублировать это красным баннером не нужно.
  const banner = $('banner');
  const helperIssue = status.code === 'no_helper' || status.code === 'old_helper';
  if (st === 'error' && status.error && !(helperIssue && setupMode())) {
    banner.hidden = false;
    banner.textContent = status.error;
  } else {
    banner.hidden = true;
  }
}

function nodeRow(n, canDelete, groupId) {
  if (n.info) {
    return `<div class="node info" title="Сообщение от сервиса">
      <span class="info-ic">${ICON.info}</span>
      <span class="node-name">${esc(n.name)}</span>
    </div>`;
  }
  const ms = state.latency[n.id];
  const waiting = ms == null && isTesting(groupId) && !n.unsupported && !n.members;
  const sel = n.id === state.selectedId;
  const cls = ['node', sel && 'selected', sel && status.state === 'on' && 'active', n.unsupported && 'unsupported']
    .filter(Boolean).join(' ');
  const title = n.unsupported ? n.unsupported : n.members ? 'Сам выбирает самый быстрый сервер из группы' : `${n.server}:${n.port}`;
  return `<div class="${cls}" role="button" tabindex="0" data-node="${esc(n.id)}" title="${esc(title)}">
    <span class="dot"></span>
    <span class="node-name">${esc(n.name)}</span>
    <span class="badge">${esc(n.unsupported ? 'не поддерж.' : n.label)}</span>
    <span class="ping ${waiting ? 'wait' : pingClass(ms)}">${waiting ? '…' : pingText(ms)}</span>
    ${canDelete ? `<button class="icon-btn del" data-del-manual="${esc(n.id)}" title="Удалить узел" aria-label="Удалить узел">${ICON.x}</button>` : ''}
  </div>`;
}

const ICON = {
  chev: '<svg class="chev" viewBox="0 0 24 24" width="16" height="16"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="13" height="13"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6 6 18"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 11v5M12 8h.01"/></svg>',
};

function matches(n) {
  if (!filter) return true;
  const q = filter.toLowerCase();
  return n.name.toLowerCase().includes(q) || (n.label || '').toLowerCase().includes(q) || (n.server || '').includes(q);
}

// Порядок и видимость узлов в группе: сообщения сервиса сверху, неподдерживаемые скрыты,
// после замера быстрые узлы выше. Во время замера держим порядок, который был до него.
function visibleNodes(nodes, groupId) {
  const s = state.settings;
  let list = nodes.map((n, i) => ({ n, i }));
  if (!s.showUnsupported) list = list.filter(({ n }) => !n.unsupported || n.id === state.selectedId);
  list = list.filter(({ n }) => n.info || matches(n));
  const snap = isTesting(groupId) ? orderSnapshot.get(groupId) : null;
  if (snap) {
    const pos = new Map(snap.map((id, k) => [id, k]));
    const at = ({ n, i }) => (n.info ? -1 : pos.has(n.id) ? pos.get(n.id) : snap.length + i);
    list.sort((a, b) => at(a) - at(b));
  } else if (s.sortByPing) {
    const rank = ({ n }) => {
      if (n.info) return -2; // сообщения сервиса — самыми первыми
      if (n.members) return -1; // группы «Авто» всегда сверху
      if (n.unsupported) return 4e6;
      const ms = state.latency[n.id];
      if (ms == null) return 2e6; // ещё не меряли: после живых, в исходном порядке
      if (ms < 0) return 3e6; // недоступные — в конец
      return ms;
    };
    list.sort((a, b) => rank(a) - rank(b) || a.i - b.i);
  }
  return list.map((x) => x.n);
}

function countText(nodes) {
  const bad = nodes.filter((n) => n.unsupported).length;
  const good = nodes.filter((n) => !n.unsupported && !n.info).length;
  return `${good} узл.` + (bad && !state.settings.showUnsupported ? ` (+${bad} не поддерж.)` : '');
}

function groupHtml({ id, name, meta, nodes, traffic, canDelete, actions, announce }) {
  const shown = visibleNodes(nodes, id);
  if (filter && !shown.some((n) => !n.info)) return '';
  const isCollapsed = collapsed.has(id) && !filter;
  const body = shown.length
    ? shown.map((n) => nodeRow(n, canDelete, id)).join('')
    : `<div class="node unsupported"><span class="node-name">${nodes.length ? 'Нет узлов, которые поддерживает расширение' : 'Сервис не прислал ни одного сервера'}</span></div>`;
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
    ${announce ? `<div class="announce">${esc(announce)}</div>` : ''}
    <div class="nodes">${body}</div>
  </div>`;
}

function subMeta(sub) {
  const parts = [countText(sub.nodes)];
  const ui = sub.userinfo;
  if (ui && (ui.total || ui.download || ui.upload)) {
    const used = (ui.upload || 0) + (ui.download || 0);
    parts.push(ui.total ? `${fmtBytes(used)} из ${fmtBytes(ui.total)}` : fmtBytes(used));
  }
  if (ui?.expire) parts.push('до ' + fmtDate(ui.expire));
  if (sub.error) return esc(parts.join(' · ')) + ` · <span class="err" title="${esc(sub.error)}">ошибка обновления</span>`;
  parts.push(fmtAgo(sub.updatedAt));
  return esc(parts.join(' · '));
}

function isTesting(group) {
  return !!testing && (testing.group === group || testing.group === 'all');
}

function renderList() {
  const list = $('list');
  const groups = [];
  for (const sub of state.subs) {
    const ui = sub.userinfo;
    const traffic = ui?.total ? (((ui.upload || 0) + (ui.download || 0)) / ui.total) * 100 : null;
    groups.push(groupHtml({
      id: sub.id,
      name: sub.name,
      meta: subMeta(sub),
      nodes: sub.nodes,
      traffic,
      announce: sub.announce,
      canDelete: false,
      actions: `
        <button class="icon-btn ${isTesting(sub.id) ? 'spin' : ''}" data-test="${esc(sub.id)}" title="Проверить задержку" aria-label="Проверить задержку">${ICON.bolt}</button>
        <button class="icon-btn" data-update="${esc(sub.url)}" title="Обновить" aria-label="Обновить">${ICON.refresh}</button>
        <button class="icon-btn danger" data-remove-sub="${esc(sub.id)}" title="Удалить подписку" aria-label="Удалить подписку">${ICON.trash}</button>`,
    }));
  }
  if (state.manual.length) {
    groups.push(groupHtml({
      id: 'manual',
      name: 'Мои узлы',
      meta: esc(`${countText(state.manual)} · добавлены вручную`),
      nodes: state.manual,
      canDelete: true,
      actions: `<button class="icon-btn ${isTesting('manual') ? 'spin' : ''}" data-test="manual" title="Проверить задержку" aria-label="Проверить задержку">${ICON.bolt}</button>`,
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
  $('test-all').classList.toggle('spin', isTesting('all'));
}

function promoCard() {
  const p = promo();
  if (!p.enabled) return '';
  return `<div class="promo">
    <b>${esc(p.title)}</b>
    <p>${esc(p.text)}</p>
    <a class="btn primary small" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.button)}</a>
  </div>`;
}

function renderFoot() {
  const p = promo();
  const hasAny = state.subs.length || state.manual.length;
  const left = testing
    ? `Замер пинга: ${testing.done || 0} из ${testing.count}`
    : `${allNodes().filter((n) => !n.unsupported && !n.info).length} узлов`;
  const right = p.enabled && hasAny ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.button)} →</a>` : '';
  $('foot').innerHTML = `<span>${esc(left)}</span>${right}`;
}

function render() {
  if (!state) return;
  renderHero();
  renderSetup();
  renderList();
  renderFoot();
}

// ---------- помощник ----------

async function checkHelper(announce = false) {
  try {
    helper = await send('helperInfo');
  } catch (e) {
    helper = { installed: false, code: 'helper', error: e.message };
  }
  if (!state) return;
  renderSetup();
  renderHero();
  renderHelperBox();
  if (!announce) return;
  if (helper.installed && !helper.outdated && !helper.coreError) toast('Помощник работает');
  else if (helper.installed && helper.outdated) toast('Найдена старая версия помощника. Установи новую.', true);
  else if (helper.installed) toast('Помощник есть, но не найден sing-box', true);
  else toast('Помощник пока не отвечает. Если только что установил его, перезапусти браузер.', true);
}

function renderHelperBox() {
  const box = $('helper-box');
  if (!box) return;
  const h = helper;
  if (!h) { box.textContent = 'Проверяю…'; return; }
  if (!h.installed) {
    box.innerHTML = `<span class="no">Не установлен.</span> ${esc(h.error || '')}<br>Как установить, показано на главном экране.`;
  } else if (h.coreError) {
    box.innerHTML = `<span class="ok">Помощник ${esc(h.version)}</span>, но <span class="no">ядро sing-box не найдено</span>: ${esc(h.coreError)}`;
  } else {
    const upd = h.outdated ? ' · <span class="no">нужно обновить</span>'
      : h.updateAvailable ? ` · <span class="warn">доступна версия ${esc(h.latest)}</span>` : '';
    box.innerHTML = `<span class="ok">Работает</span> · помощник ${esc(h.version)}${upd} · sing-box ${esc(h.core)}<br><code>${esc(h.corePath)}</code>`;
  }
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
  $('sort-by-ping').checked = !!s.sortByPing;
  $('show-unsupported').checked = !!s.showUnsupported;
  $('about').innerHTML = `${esc(BRAND.name)} ${esc(VERSION)} · <a href="${esc(BRAND.repoUrl)}" target="_blank" rel="noopener">Исходный код</a> · <a href="${esc(BRAND.repoUrl)}/blob/main/PRIVACY.md" target="_blank" rel="noopener">Конфиденциальность</a>`;
  syncModeSeg();
}

function syncModeSeg() {
  for (const b of $('mode-seg').querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === settingsMode);
  $('except-field').hidden = settingsMode !== 'except';
  $('only-field').hidden = settingsMode !== 'only';
}

function openSettings() {
  fillSettings();
  $('view-main').hidden = true;
  $('view-settings').hidden = false;
  renderHelperBox();
  checkHelper();
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
    if (!r.added && r.messages?.length) toast(`Серверов нет. Сообщение от сервиса: ${r.messages[0]}`, true);
    else toast(`Добавлено узлов: ${r.added}` + (r.unsupported ? `. Ещё ${r.unsupported} не поддерживаются` : ''));
  } catch (e) {
    onError(e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Добавить';
  }
});

$('add-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('add-submit').click();
});

$('search').addEventListener('input', (e) => { filter = e.target.value.trim(); renderList(); });

// Запоминаем текущий порядок строк, чтобы он не менялся, пока приходят результаты.
function snapshotOrder(group) {
  for (const el of $('list').querySelectorAll('.group[data-group]')) {
    const gid = el.dataset.group;
    if (group && gid !== group) continue;
    orderSnapshot.set(gid, [...el.querySelectorAll('.node[data-node]')].map((r) => r.dataset.node));
  }
}

async function runTest(group) {
  snapshotOrder(group);
  try {
    const r = await send('test', { group });
    if (r.tested) toast(`Работают ${r.alive} из ${r.tested}`);
  } finally {
    if (group) orderSnapshot.delete(group); else orderSnapshot.clear();
    renderList();
  }
}

$('test-all').addEventListener('click', (e) => busy(e.currentTarget, () => runTest(null)));
$('update-all').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const r = await send('updateAll');
  toast(r.failed ? `Обновлено: ${r.updated}, с ошибкой: ${r.failed}` : 'Подписки обновлены', !!r.failed);
}));

$('list').addEventListener('click', async (e) => {
  const t = e.target.closest('[data-test],[data-update],[data-remove-sub],[data-del-manual],[data-node],[data-toggle]');
  if (!t) return;
  if (t.dataset.test) { e.stopPropagation(); return busy(t, () => runTest(t.dataset.test)); }
  if (t.dataset.update) { e.stopPropagation(); return busy(t, async () => { await send('updateSub', { url: t.dataset.update }); toast('Подписка обновлена'); }); }
  if (t.dataset.removeSub) {
    e.stopPropagation();
    if (t.dataset.armed) return send('removeSub', { id: t.dataset.removeSub }).catch(onError);
    t.dataset.armed = '1';
    t.title = 'Нажми ещё раз, чтобы удалить';
    toast('Нажми ещё раз, чтобы удалить подписку');
    setTimeout(() => { delete t.dataset.armed; }, 3000);
    return;
  }
  if (t.dataset.delManual) { e.stopPropagation(); return send('removeManual', { id: t.dataset.delManual }).catch(onError); }
  if (t.dataset.node) {
    if (t.classList.contains('unsupported')) return toast(t.title, true);
    return send('select', { id: t.dataset.node }).catch(onError);
  }
  if (t.dataset.toggle) {
    const id = t.dataset.toggle;
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    writeStored('collapsed', [...collapsed]);
    renderList();
  }
});

$('list').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset?.node) { e.preventDefault(); e.target.click(); }
});

$('setup').addEventListener('click', async (e) => {
  const t = e.target.closest('[data-copy],[data-check],[data-dismiss]');
  if (!t) return;
  if (t.dataset.copy !== undefined) {
    try {
      await navigator.clipboard.writeText(BRAND.installCommand);
      toast('Команда скопирована. Вставь её в Терминал.');
    } catch {
      // Буфер обмена недоступен: выделяем текст, чтобы его можно было скопировать вручную.
      const range = document.createRange();
      range.selectNodeContents($('install-cmd'));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      toast('Скопируй выделенную команду: Cmd+C или Ctrl+C');
    }
  } else if (t.dataset.check !== undefined) {
    busy(t, () => checkHelper(true));
  } else if (t.dataset.dismiss !== undefined) {
    writeStored('dismissedHelper', helper?.latest || '');
    renderSetup();
  }
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
        sortByPing: $('sort-by-ping').checked,
        showUnsupported: $('show-unsupported').checked,
      },
    });
    toast('Сохранено');
    closeSettings();
  } catch (e) {
    onError(e);
  }
});

// ---------- загрузка и подписка на изменения ----------

async function load() {
  const local = await chrome.storage.local.get({
    subs: [], manual: [], selectedId: null, latency: {}, settings: {}, remote: null,
  });
  const session = await chrome.storage.session.get({ status: { state: 'off' }, testing: null });
  state = {
    ...local,
    settings: {
      mode: 'except', exceptList: '', onlyList: '', port: 10808, updateHours: 12, userAgent: DEFAULT_UA,
      sortByPing: true, showUnsupported: false, ...local.settings,
    },
  };
  status = session.status;
  testing = session.testing && typeof session.testing === 'object' ? session.testing : null;
  render();
}

chrome.storage.onChanged.addListener(() => load());
$('brand-name').textContent = BRAND.name;
load().then(() => {
  chrome.runtime.getPlatformInfo().then((p) => { platform = p; renderSetup(); }).catch(() => {});
  checkHelper();
  // Подписки старше 30 минут обновляются в фоне, пока popup открыт: так заморозка
  // или новые серверы видны сразу, а не через несколько часов.
  if (state.subs.length) send('refreshStale').catch(() => {});
});
