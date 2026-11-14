import { BRAND, sanitizePromo } from './config.js';
import { t, setLang, detectLang, getLang, translateDom } from './lib/i18n.js';
import { routeForHost, siteDomain, normalizeDomains, normalizeRules } from './lib/singbox.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const VERSION = chrome.runtime.getManifest().version;
const DEFAULT_UA = `${BRAND.name}/${VERSION}`;

let state = null;
let status = { state: 'off' };
let testing = null; // { group, count, done } во время замера пинга
let filter = '';
let timerId = null;
let helper = null; // ответ helperInfo: установлен ли помощник и какой версии
let helperUpdate = null; // ход обновления помощника: { state, version, error }
let platform = null; // { os, arch }
let tabHost = null; // сайт в текущей вкладке
let speed = null; // { down, up } байт/с
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
    if (!r) throw new Error(t('Нет ответа от расширения'));
    if (!r.ok) throw Object.assign(new Error(r.error), { code: r.code });
    return r;
  });
}

// Ошибки «нет помощника» и «помощник устарел» показываем карточкой установки, остальные — всплывающим сообщением.
function onError(e) {
  if (e.code === 'no_helper') {
    helper = { installed: false, code: e.code, error: e.message };
  } else if (e.code === 'old_helper') {
    helper = { ...(helper || {}), installed: true, outdated: true };
  } else if (e.code === 'helper_feature') {
    helper = { ...(helper || {}), installed: true, featureNeeded: e.message };
  } else {
    toast(e.message, true);
    return;
  }
  renderSetup();
  renderHero();
}

function toast(text, isError = false) {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, isError ? 5000 : 2500);
}

async function busy(btn, fn) {
  btn.disabled = true;
  btn.classList.add('spin');
  try { return await fn(); }
  catch (e) { onError(e); }
  finally { btn.disabled = false; btn.classList.remove('spin'); }
}

// ---------- форматирование ----------

function units() {
  return getLang() === 'en' ? ['B', 'KB', 'MB', 'GB', 'TB'] : ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
}
function fmtBytes(n) {
  if (!n) return '0';
  const u = units();
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
}
function fmtRate(n) {
  return fmtBytes(Math.max(0, Math.round(n))) + t('/с');
}
function locale() {
  return getLang() === 'en' ? 'en-GB' : 'ru-RU';
}
function fmtDate(sec) {
  return new Date(sec * 1000).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDay(sec) {
  return new Date(sec * 1000).toLocaleDateString(locale(), { day: 'numeric', month: 'long' });
}
function fmtAgo(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return t('только что');
  if (m < 60) return t('{0} мин назад', m);
  const h = Math.round(m / 60);
  if (h < 24) return t('{0} ч назад', h);
  return t('{0} дн назад', Math.round(h / 24));
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
  if (ms < 0) return t('нет');
  return t('{0} мс', ms);
}

function modeText(mode) {
  return {
    all: t('Все сайты через прокси'),
    except: t('Все сайты, кроме исключений'),
    only: t('Только выбранные сайты'),
  }[mode] || t('Все сайты через прокси');
}

// ---------- отрисовка ----------

function allNodes() {
  return [...state.subs.flatMap((s) => s.nodes || []), ...state.manual];
}

function promo() {
  if (getLang() === 'en') return sanitizePromo(state?.remote?.promoEn) || BRAND.promoEn;
  return sanitizePromo(state?.remote?.promo) || BRAND.promo;
}

// Какую карточку про помощник показывать: install | required | feature | core | update | null
function setupMode() {
  if (!helper) return null;
  if (!helper.installed) return 'install';
  if (helper.outdated) return 'required';
  if (helper.featureNeeded) return 'feature';
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
        <li>${t('Скачай архив и распакуй его целиком')}</li>
        <li>${t('Запусти <b>install.bat</b> из распакованной папки')}</li>
      </ol>
      <div class="actions">
        <a class="btn primary small" href="${esc(url)}" target="_blank" rel="noopener">${t('Скачать для Windows')}</a>
        <button class="btn small" data-check>${t('Проверить')}</button>
      </div>`;
  }
  if (platform?.os === 'mac' || platform?.os === 'linux') {
    return `<p>${t('Открой «Терминал», вставь команду и нажми Enter:')}</p>
      <div class="cmd"><code id="install-cmd">${esc(BRAND.installCommand)}</code></div>
      <div class="actions">
        <button class="btn primary small" data-copy>${t('Скопировать команду')}</button>
        <button class="btn small" data-check>${t('Проверить')}</button>
        ${file ? `<a class="link" href="${esc(url)}" target="_blank" rel="noopener">${t('или скачать архив')}</a>` : ''}
      </div>`;
  }
  return `<p>${t('Помощник есть для Windows, macOS и Linux.')}</p>
    <div class="actions">
      <a class="btn primary small" href="${esc(BRAND.releasesUrl)}" target="_blank" rel="noopener">${t('Открыть страницу загрузки')}</a>
      <button class="btn small" data-check>${t('Проверить')}</button>
    </div>`;
}

// Помощник 1.1+ обновляется сам: вместо инструкции показываем одну кнопку.
function selfUpdateBlock() {
  if (helperUpdate?.state === 'running') {
    return `<div class="actions"><button class="btn primary small" disabled>${t('Обновляю…')}</button></div>`;
  }
  const err = helperUpdate?.state === 'error' ? `<div class="err">${esc(helperUpdate.error)}</div>` : '';
  return `${err}<div class="actions">
      <button class="btn primary small" data-self-update>${t('Обновить автоматически')}</button>
      ${helperUpdate?.state === 'error' ? `<a class="link" href="${esc(BRAND.releasesUrl)}" target="_blank" rel="noopener">${t('скачать вручную')}</a>` : ''}
    </div>`;
}

function renderSetup() {
  const box = $('setup');
  const mode = setupMode();
  if (!mode) { box.hidden = true; return; }
  const canSelf = !!helper.canSelfUpdate;
  let head;
  if (mode === 'install') {
    const other = helper.code && helper.code !== 'no_helper' ? `<div class="err">${esc(helper.error || '')}</div>` : '';
    head = `<h4>${t('Установи помощник')}</h4>
      <p>${t('Браузер сам не умеет VLESS, Hysteria2 и другие протоколы. Их обслуживает небольшая программа с открытым кодом. Ставится один раз.')}</p>${other}`;
  } else if (mode === 'required') {
    head = `<h4>${t('Обнови помощник')}</h4>
      <p>${t('Установленная версия помощника устарела для этой версии расширения.')}</p>`;
  } else if (mode === 'feature') {
    head = `<button class="icon-btn close" data-dismiss-feature title="${t('Скрыть')}" aria-label="${t('Скрыть')}">${ICON.x}</button>
      <h4>${t('Обнови помощник')}</h4><p>${esc(helper.featureNeeded)}</p>`;
  } else if (mode === 'core') {
    head = `<h4>${t('Не найден sing-box')}</h4>
      <p>${t('Помощник установлен, но рядом с ним нет ядра sing-box. Установи помощник заново, ядро входит в комплект:')}</p>`;
  } else {
    head = `<button class="icon-btn close" data-dismiss title="${t('Скрыть')}" aria-label="${t('Скрыть')}">${ICON.x}</button>
      <h4>${t('Доступен помощник {0}', esc(helper.latest))}</h4>
      <p>${canSelf ? t('У тебя версия {0}. Обновление займёт полминуты.', esc(helper.version)) : t('У тебя версия {0}. Чтобы обновить, установи помощник заново тем же способом:', esc(helper.version))}</p>`;
  }
  const body = mode !== 'install' && mode !== 'core' && canSelf ? selfUpdateBlock() : installSteps();
  box.className = 'setup' + (mode === 'update' ? ' light' : '');
  box.innerHTML = head + body;
  box.hidden = false;
}

function renderHero() {
  const hero = $('hero');
  const st = status.state;
  hero.className = 'hero ' + st;
  const selected = allNodes().find((n) => n.id === state.selectedId);
  const nodeName = status.nodeName && st !== 'off' ? status.nodeName : selected?.name;

  const titles = { off: t('Отключено'), connecting: t('Подключение…'), on: t('Подключено'), error: t('Ошибка') };
  if (status.code === 'killswitch') titles.error = t('Защита включена');
  $('status-text').textContent = titles[st] || t('Отключено');
  if (st === 'on' && status.since) $('status-text').textContent += ' · ' + fmtDuration(Date.now() - status.since);

  const selLabel = selected ? (selected.members ? t('Авто · {0}', selected.members.length) : selected.label) : '';
  // У групп «Авто» название уже говорит само за себя, метку не дублируем.
  const showLabel = selLabel && !(selected?.members && nodeName && nodeName.toLowerCase().includes(selLabel.split(' ')[0].toLowerCase()));
  $('node-line').textContent = nodeName ? nodeName + (showLabel ? ' · ' + selLabel : '') : t('Узел не выбран');
  $('power').setAttribute('aria-label', st === 'on' ? t('Отключить') : t('Подключить'));
  $('power').disabled = st === 'connecting';
  $('mode-chip').textContent = modeText(state.settings.mode);

  const sp = $('speed');
  if (st === 'on' && speed) {
    sp.innerHTML = `<span>↓ <b>${esc(fmtRate(speed.down))}</b></span><span>↑ <b>${esc(fmtRate(speed.up))}</b></span>`;
    sp.hidden = false;
  } else {
    sp.hidden = true;
  }

  clearInterval(timerId);
  if (st === 'on') timerId = setInterval(renderHero, 1000);

  // Про отсутствие помощника рассказывает карточка установки, дублировать это красным баннером не нужно.
  const banner = $('banner');
  const helperIssue = ['no_helper', 'old_helper', 'helper_feature'].includes(status.code);
  if (st === 'error' && status.code === 'killswitch') {
    banner.hidden = false;
    banner.innerHTML = `${esc(status.error)}${status.detail ? `<div class="hint-small">${esc(status.detail)}</div>` : ''}
      <div class="actions-row"><button class="btn small" data-off>${t('Отключить VPN')}</button></div>`;
  } else if (st === 'error' && status.error && !(helperIssue && setupMode())) {
    banner.hidden = false;
    banner.textContent = status.error;
  } else {
    banner.hidden = true;
  }
}

// ---------- текущий сайт: через VPN или напрямую ----------

function siteRoute(host) {
  const s = state.settings;
  const domains = s.mode === 'except' ? normalizeDomains(s.exceptList) : s.mode === 'only' ? normalizeDomains(s.onlyList) : [];
  return { rules: normalizeRules(s.siteRules), domains, mode: s.mode, ...routeForHost(host, { mode: s.mode, domains, rules: normalizeRules(s.siteRules) }) };
}

function renderSite() {
  const box = $('site');
  if (!tabHost || !(state.subs.length || state.manual.length)) { box.hidden = true; return; }
  const r = siteRoute(tabHost);
  if (r.by === 'local') { box.hidden = true; return; }
  const note = r.by === 'rule'
    ? t('правило для {0}', r.match)
    : r.by === 'list'
      ? (r.route === 'direct' ? t('в списке исключений: {0}', r.match) : t('в списке сайтов: {0}', r.match))
      : (r.route === 'proxy' ? t('по режиму: все сайты через VPN') : t('по режиму: напрямую'));
  box.innerHTML = `<div class="site-info">
      <div class="site-host">${esc(tabHost)}</div>
      <div class="site-note">${esc(note)}</div>
    </div>
    <div class="segmented">
      <button data-route="proxy" class="${r.route === 'proxy' ? 'active proxy' : ''}">VPN</button>
      <button data-route="direct" class="${r.route === 'direct' ? 'active' : ''}">${t('Напрямую')}</button>
    </div>`;
  box.hidden = false;
}

async function setSiteRoute(route) {
  const r = siteRoute(tabHost);
  if (r.route === route) return;
  const domain = siteDomain(tabHost);
  // Если без правила сайт и так пойдёт нужным путём, правило не нужно — убираем его.
  const rulesWithout = { ...r.rules };
  for (const d of Object.keys(rulesWithout)) if (tabHost === d || tabHost.endsWith('.' + d)) delete rulesWithout[d];
  const base = routeForHost(tabHost, { mode: r.mode, domains: r.domains, rules: rulesWithout });
  // Правила для поддоменов (m.youtube.com) мешали бы новому правилу для всего сайта.
  for (const d of Object.keys(r.rules)) {
    if (d !== domain && (tabHost === d || tabHost.endsWith('.' + d)) && d.endsWith('.' + domain)) {
      await send('setSiteRule', { domain: d, route: null });
    }
  }
  await send('setSiteRule', { domain, route: base.route === route && base.by !== 'rule' ? null : route });
  toast(route === 'proxy' ? t('{0} открывается через VPN', domain) : t('{0} открывается напрямую', domain));
}

// ---------- напоминание о подписке ----------

const DAY = 86400e3;

function reminderFor(sub) {
  const ui = sub.userinfo;
  if (!ui) return null;
  const link = sub.webPage || sub.supportUrl || promo().url;
  if (ui.expire) {
    const left = ui.expire * 1000 - Date.now();
    if (left <= 0) return { key: `exp:${sub.id}:${ui.expire}`, cls: 'expired', text: t('Подписка «{0}» закончилась', sub.name), link };
    if (left < 3 * DAY) return { key: `exp:${sub.id}:${ui.expire}`, text: t('Подписка «{0}» закончится {1}', sub.name, fmtDay(ui.expire)), link };
  }
  if (ui.total) {
    const used = (ui.upload || 0) + (ui.download || 0);
    if (used >= ui.total) return { key: `traffic:${sub.id}:${ui.total}`, cls: 'expired', text: t('В подписке «{0}» закончился трафик', sub.name), link };
    if (used >= ui.total * 0.9) return { key: `traffic:${sub.id}:${ui.total}`, text: t('В подписке «{0}» осталось {1} трафика', sub.name, fmtBytes(ui.total - used)), link };
  }
  return null;
}

function renderReminder() {
  const box = $('reminder');
  const dismissed = readStored('dismissedReminders', []);
  const r = state.subs.map(reminderFor).find((x) => x && !dismissed.includes(x.key));
  if (!r) { box.hidden = true; return; }
  box.className = 'reminder' + (r.cls ? ' ' + r.cls : '');
  box.innerHTML = `<span class="txt">${esc(r.text)}</span>
    ${/^https:\/\//i.test(r.link) ? `<a class="btn primary small" href="${esc(r.link)}" target="_blank" rel="noopener">${t('Продлить')}</a>` : ''}
    <button class="icon-btn" data-dismiss-reminder="${esc(r.key)}" title="${t('Скрыть')}" aria-label="${t('Скрыть')}">${ICON.x}</button>`;
  box.hidden = false;
}

// ---------- список узлов ----------

function nodeRow(n, canDelete, groupId) {
  if (n.info) {
    return `<div class="node info" title="${t('Сообщение от сервиса')}">
      <span class="info-ic">${ICON.info}</span>
      <span class="node-name">${esc(n.name)}</span>
    </div>`;
  }
  const ms = state.latency[n.id];
  const waiting = ms == null && isTesting(groupId) && !n.unsupported && !n.members;
  const sel = n.id === state.selectedId;
  const cls = ['node', sel && 'selected', sel && status.state === 'on' && 'active', n.unsupported && 'unsupported']
    .filter(Boolean).join(' ');
  const title = n.unsupported ? n.unsupported : n.members ? t('Сам выбирает самый быстрый сервер из группы') : `${n.server}:${n.port}`;
  const label = n.members ? t('Авто · {0}', n.members.length) : n.label;
  return `<div class="${cls}" role="button" tabindex="0" data-node="${esc(n.id)}" title="${esc(title)}">
    <span class="dot"></span>
    <span class="node-name">${esc(n.name)}</span>
    <span class="badge">${esc(n.unsupported ? t('не поддерж.') : label)}</span>
    <span class="ping ${waiting ? 'wait' : pingClass(ms)}">${waiting ? '…' : pingText(ms)}</span>
    ${canDelete ? `<button class="icon-btn del" data-del-manual="${esc(n.id)}" title="${t('Удалить узел')}" aria-label="${t('Удалить узел')}">${ICON.x}</button>` : ''}
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
  return t('{0} узл.', good) + (bad && !state.settings.showUnsupported ? t(' (+{0} не поддерж.)', bad) : '');
}

function groupHtml({ id, name, meta, nodes, traffic, canDelete, actions, announce }) {
  const shown = visibleNodes(nodes, id);
  if (filter && !shown.some((n) => !n.info)) return '';
  const isCollapsed = collapsed.has(id) && !filter;
  const body = shown.length
    ? shown.map((n) => nodeRow(n, canDelete, id)).join('')
    : `<div class="node unsupported"><span class="node-name">${nodes.length ? t('Нет узлов, которые поддерживает расширение') : t('Сервис не прислал ни одного сервера')}</span></div>`;
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
    parts.push(ui.total ? t('{0} из {1}', fmtBytes(used), fmtBytes(ui.total)) : fmtBytes(used));
  }
  if (ui?.expire) parts.push(t('до {0}', fmtDate(ui.expire)));
  if (sub.error) return esc(parts.join(' · ')) + ` · <span class="err" title="${esc(sub.error)}">${t('ошибка обновления')}</span>`;
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
        <button class="icon-btn ${isTesting(sub.id) ? 'spin' : ''}" data-test="${esc(sub.id)}" title="${t('Проверить задержку')}" aria-label="${t('Проверить задержку')}">${ICON.bolt}</button>
        <button class="icon-btn" data-update="${esc(sub.url)}" title="${t('Обновить')}" aria-label="${t('Обновить')}">${ICON.refresh}</button>
        <button class="icon-btn danger" data-remove-sub="${esc(sub.id)}" title="${t('Удалить подписку')}" aria-label="${t('Удалить подписку')}">${ICON.trash}</button>`,
    }));
  }
  if (state.manual.length) {
    groups.push(groupHtml({
      id: 'manual',
      name: t('Мои узлы'),
      meta: esc(`${countText(state.manual)} · ${t('добавлены вручную')}`),
      nodes: state.manual,
      canDelete: true,
      actions: `<button class="icon-btn ${isTesting('manual') ? 'spin' : ''}" data-test="manual" title="${t('Проверить задержку')}" aria-label="${t('Проверить задержку')}">${ICON.bolt}</button>`,
    }));
  }

  const hasAny = state.subs.length || state.manual.length;
  if (!hasAny) {
    list.innerHTML = `<div class="empty">
      <h3>${t('Пока пусто')}</h3>
      <p>${t('Добавь ссылку на подписку или узел кнопкой «+»')}</p>
    </div>${promoCard()}`;
  } else {
    const html = groups.join('');
    list.innerHTML = html || `<div class="empty"><p>${t('Ничего не найдено')}</p></div>`;
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
    ? t('Замер пинга: {0} из {1}', testing.done || 0, testing.count)
    : t('{0} узлов', allNodes().filter((n) => !n.unsupported && !n.info).length);
  const right = p.enabled && hasAny ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.button)} →</a>` : '';
  $('foot').innerHTML = `<span>${esc(left)}</span>${right}`;
}

function render() {
  if (!state) return;
  renderHero();
  renderSetup();
  renderSite();
  renderReminder();
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
  if (helper.installed && !helper.outdated && !helper.coreError) toast(t('Помощник работает'));
  else if (helper.installed && helper.outdated) toast(t('Найдена старая версия помощника. Установи новую.'), true);
  else if (helper.installed) toast(t('Помощник есть, но не найден sing-box'), true);
  else toast(t('Помощник пока не отвечает. Если только что установил его, перезапусти браузер.'), true);
}

function renderHelperBox() {
  const box = $('helper-box');
  if (!box) return;
  const h = helper;
  if (!h) { box.textContent = t('Проверяю…'); return; }
  if (!h.installed) {
    box.innerHTML = `<span class="no">${t('Не установлен.')}</span> ${esc(h.error || '')}<br>${t('Как установить, показано на главном экране.')}`;
  } else if (h.coreError) {
    box.innerHTML = `<span class="ok">${t('Помощник {0}', esc(h.version))}</span>, ${t('но')} <span class="no">${t('ядро sing-box не найдено')}</span>: ${esc(h.coreError)}`;
  } else {
    const upd = h.outdated ? ` · <span class="no">${t('нужно обновить')}</span>`
      : h.updateAvailable ? ` · <span class="warn">${t('доступна версия {0}', esc(h.latest))}</span>` : '';
    const xr = h.xray ? ` · xray ${esc(h.xray)}` : '';
    box.innerHTML = `<span class="ok">${t('Работает')}</span> · ${t('помощник {0}', esc(h.version))}${upd} · sing-box ${esc(h.core)}${xr}<br><code>${esc(h.corePath)}</code>`;
  }
}

// ---------- скорость ----------

let statsTimer = null;
let lastStats = null;

async function pollStats() {
  if (status.state !== 'on') { speed = null; lastStats = null; return; }
  try {
    const r = await send('stats');
    if (!r.available) { speed = null; lastStats = null; renderHero(); return; }
    if (lastStats && r.at > lastStats.at) {
      const dt = (r.at - lastStats.at) / 1000;
      speed = { down: (r.down - lastStats.down) / dt, up: (r.up - lastStats.up) / dt };
      renderHero();
    }
    lastStats = r;
  } catch { /* помощник занят — пропускаем отсчёт */ }
}

function syncStatsTimer() {
  if (status.state === 'on' && !statsTimer) {
    pollStats();
    statsTimer = setInterval(pollStats, 1000);
  } else if (status.state !== 'on' && statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
    speed = null;
    lastStats = null;
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
  $('webrtc-protect').checked = s.webrtcProtect !== false;
  $('kill-switch').checked = !!s.killSwitch;
  $('lang').value = s.lang || 'auto';
  renderRules();
  $('about').innerHTML = `${esc(BRAND.name)} ${esc(VERSION)} · <a href="${esc(BRAND.repoUrl)}" target="_blank" rel="noopener">${t('Исходный код')}</a> · <a href="${esc(BRAND.repoUrl)}/blob/main/PRIVACY.md" target="_blank" rel="noopener">${t('Конфиденциальность')}</a>`;
  syncModeSeg();
}

function renderRules() {
  const rules = normalizeRules(state.settings.siteRules);
  const entries = Object.entries(rules).sort(([a], [b]) => a.localeCompare(b));
  $('rules-field').hidden = !entries.length;
  $('rules-list').innerHTML = entries.map(([d, r]) => `<div class="rule">
      <span class="rh">${esc(d)}</span>
      <span class="rr ${r}">${r === 'proxy' ? 'VPN' : t('напрямую')}</span>
      <button class="icon-btn" data-del-rule="${esc(d)}" title="${t('Удалить правило')}" aria-label="${t('Удалить правило')}">${ICON.x}</button>
    </div>`).join('');
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
    if (status.state === 'on' || status.code === 'killswitch') await send('disconnect');
    else await send('connect');
  } catch (e) {
    onError(e);
  }
});

$('banner').addEventListener('click', (e) => {
  if (e.target.closest('[data-off]')) send('disconnect').catch(onError);
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
  btn.textContent = t('Загружаю…');
  try {
    const r = await send('add', { text });
    $('add-input').value = '';
    $('add-panel').hidden = true;
    if (!r.added && r.messages?.length) toast(t('Серверов нет. Сообщение от сервиса: {0}', r.messages[0]), true);
    else toast(t('Добавлено узлов: {0}', r.added) + (r.unsupported ? t('. Ещё {0} не поддерживаются', r.unsupported) : ''));
  } catch (e) {
    onError(e);
  } finally {
    btn.disabled = false;
    btn.textContent = t('Добавить');
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
    if (r.tested) toast(t('Работают {0} из {1}', r.alive, r.tested) + (r.skipped ? t('. {0} серверов XHTTP: обнови помощник', r.skipped) : ''));
    else if (r.skipped) onError({ code: 'helper_feature', message: t('Чтобы проверять серверы XHTTP, обнови помощник.') });
  } finally {
    if (group) orderSnapshot.delete(group); else orderSnapshot.clear();
    renderList();
  }
}

$('test-all').addEventListener('click', (e) => busy(e.currentTarget, () => runTest(null)));
$('update-all').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const r = await send('updateAll');
  toast(r.failed ? t('Обновлено: {0}, с ошибкой: {1}', r.updated, r.failed) : t('Подписки обновлены'), !!r.failed);
}));

$('list').addEventListener('click', async (e) => {
  const el = e.target.closest('[data-test],[data-update],[data-remove-sub],[data-del-manual],[data-node],[data-toggle]');
  if (!el) return;
  if (el.dataset.test) { e.stopPropagation(); return busy(el, () => runTest(el.dataset.test)); }
  if (el.dataset.update) { e.stopPropagation(); return busy(el, async () => { await send('updateSub', { url: el.dataset.update }); toast(t('Подписка обновлена')); }); }
  if (el.dataset.removeSub) {
    e.stopPropagation();
    if (el.dataset.armed) return send('removeSub', { id: el.dataset.removeSub }).catch(onError);
    el.dataset.armed = '1';
    el.title = t('Нажми ещё раз, чтобы удалить');
    toast(t('Нажми ещё раз, чтобы удалить подписку'));
    setTimeout(() => { delete el.dataset.armed; }, 3000);
    return;
  }
  if (el.dataset.delManual) { e.stopPropagation(); return send('removeManual', { id: el.dataset.delManual }).catch(onError); }
  if (el.dataset.node) {
    if (el.classList.contains('unsupported')) return toast(el.title, true);
    return send('select', { id: el.dataset.node }).catch(onError);
  }
  if (el.dataset.toggle) {
    const id = el.dataset.toggle;
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    writeStored('collapsed', [...collapsed]);
    renderList();
  }
});

$('list').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset?.node) { e.preventDefault(); e.target.click(); }
});

$('site').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-route]');
  if (b) setSiteRoute(b.dataset.route).catch(onError);
});

$('reminder').addEventListener('click', (e) => {
  const b = e.target.closest('[data-dismiss-reminder]');
  if (!b) return;
  writeStored('dismissedReminders', [...readStored('dismissedReminders', []), b.dataset.dismissReminder].slice(-20));
  renderReminder();
});

$('setup').addEventListener('click', async (e) => {
  const el = e.target.closest('[data-copy],[data-check],[data-dismiss],[data-dismiss-feature],[data-self-update]');
  if (!el) return;
  if (el.dataset.copy !== undefined) {
    try {
      await navigator.clipboard.writeText(BRAND.installCommand);
      toast(t('Команда скопирована. Вставь её в Терминал.'));
    } catch {
      // Буфер обмена недоступен: выделяем текст, чтобы его можно было скопировать вручную.
      const range = document.createRange();
      range.selectNodeContents($('install-cmd'));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      toast(t('Скопируй выделенную команду: Cmd+C или Ctrl+C'));
    }
  } else if (el.dataset.check !== undefined) {
    busy(el, () => checkHelper(true));
  } else if (el.dataset.dismiss !== undefined) {
    writeStored('dismissedHelper', helper?.latest || '');
    renderSetup();
  } else if (el.dataset.dismissFeature !== undefined) {
    if (helper) delete helper.featureNeeded;
    renderSetup();
  } else if (el.dataset.selfUpdate !== undefined) {
    busy(el, async () => {
      const r = await send('updateHelper');
      if (r.state === 'current') toast(t('У тебя уже последняя версия помощника'));
      if (helper) delete helper.featureNeeded;
      await checkHelper();
    });
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
$('rules-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-del-rule]');
  if (b) send('setSiteRule', { domain: b.dataset.delRule, route: null }).then(() => { renderRules(); }).catch(onError);
});
$('save-settings').addEventListener('click', async () => {
  const langBefore = state.settings.lang || 'auto';
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
        webrtcProtect: $('webrtc-protect').checked,
        killSwitch: $('kill-switch').checked,
        lang: $('lang').value,
      },
    });
    // Язык поменяли: перезагружаем popup, чтобы перевести и статичный текст.
    if ($('lang').value !== langBefore) { location.reload(); return; }
    toast(t('Сохранено'));
    closeSettings();
  } catch (e) {
    onError(e);
  }
});

// ---------- загрузка и подписка на изменения ----------

async function load() {
  const local = await chrome.storage.local.get({
    subs: [], manual: [], selectedId: null, latency: {}, settings: {}, remote: null, helperUpdate: null,
  });
  const session = await chrome.storage.session.get({ status: { state: 'off' }, testing: null });
  state = {
    ...local,
    settings: {
      mode: 'except', exceptList: '', onlyList: '', port: 10808, updateHours: 12, userAgent: DEFAULT_UA,
      sortByPing: true, showUnsupported: false, webrtcProtect: true, killSwitch: false, lang: 'auto', siteRules: {},
      ...local.settings,
    },
  };
  const prevUpdate = helperUpdate;
  helperUpdate = local.helperUpdate;
  if (prevUpdate?.state === 'running' && helperUpdate?.state === 'done') {
    toast(t('Помощник обновлён до {0}', helperUpdate.version));
    checkHelper();
  }
  status = session.status;
  testing = session.testing && typeof session.testing === 'object' ? session.testing : null;
  syncStatsTimer();
  render();
}

async function readTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const u = new URL(tab?.url || '');
    if (u.protocol === 'http:' || u.protocol === 'https:') tabHost = u.hostname.toLowerCase();
  } catch { /* нет вкладки или нет доступа — переключатель не показываем */ }
}

chrome.storage.onChanged.addListener(() => load());

(async () => {
  // Язык выбираем до первой отрисовки, чтобы не было мигания русского текста.
  const { settings } = await chrome.storage.local.get({ settings: {} });
  setLang(detectLang(settings.lang));
  document.documentElement.lang = getLang();
  translateDom(document.body);
  $('brand-name').textContent = BRAND.name;
  await readTab();
  await load();
  chrome.runtime.getPlatformInfo().then((p) => { platform = p; renderSetup(); }).catch(() => {});
  checkHelper();
  // Подписки старше 30 минут обновляются в фоне, пока popup открыт: так заморозка
  // или новые серверы видны сразу, а не через несколько часов.
  if (state.subs.length) send('refreshStale').catch(() => {});
})();
