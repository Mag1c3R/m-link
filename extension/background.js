import { parseSubscription, parseUserInfo, parseProfileTitle, hashString } from './lib/parser.js';
import { buildNodeConfig, buildPac, normalizeDomains, normalizeRules, DEFAULT_EXCEPT } from './lib/singbox.js';
import { BRAND, compareVersions, sanitizePromo } from './config.js';
import { t, tHelper, setLang, detectLang } from './lib/i18n.js';

const TEST_URL = 'https://www.gstatic.com/generate_204';
const DEFAULT_UA = `${BRAND.name}/${chrome.runtime.getManifest().version}`;

const DEFAULT_SETTINGS = {
  port: 10808,
  mode: 'except', // all | except | only
  exceptList: DEFAULT_EXCEPT.join('\n'),
  onlyList: '',
  siteRules: {}, // { "youtube.com": "proxy" | "direct" } — важнее режима
  userAgent: DEFAULT_UA,
  updateHours: 12,
  sortByPing: true,
  showUnsupported: false,
  webrtcProtect: true, // не давать WebRTC показывать настоящий IP в обход прокси
  killSwitch: false, // при обрыве не пускать сайты мимо VPN
  lang: 'auto', // auto | ru | en
};

const DEFAULTS = {
  subs: [],
  manual: [],
  selectedId: null,
  wantConnected: false,
  latency: {},
  settings: DEFAULT_SETTINGS,
};

async function loadState() {
  const s = await chrome.storage.local.get(DEFAULTS);
  s.settings = { ...DEFAULT_SETTINGS, ...s.settings };
  // User-Agent по умолчанию от прошлых версий заменяем текущим, свой собственный не трогаем.
  if (/^M-(Client|Link)\/[\d.]+$/.test(s.settings.userAgent || '')) s.settings.userAgent = DEFAULT_UA;
  setLang(detectLang(s.settings.lang));
  return s;
}

function allNodes(state) {
  return [...state.subs.flatMap((s) => s.nodes || []), ...state.manual];
}

// Узел, к которому можно подключиться: не сообщение панели и не неподдерживаемый.
function usable(n) {
  return !!n && !n.unsupported && !n.info;
}

function findNode(state, id) {
  return allNodes(state).find((n) => n.id === id && usable(n)) || null;
}

// ---------- статус и значок ----------

async function setStatus(state, extra = {}) {
  const status = { state, at: Date.now(), ...extra };
  await chrome.storage.session.set({ status });
  const badge = {
    on: ['', '#16a34a'],
    connecting: ['…', '#64748b'],
    error: ['!', '#dc2626'],
    off: ['', '#64748b'],
  }[state] || ['', '#64748b'];
  await chrome.action.setBadgeBackgroundColor({ color: badge[1] });
  await chrome.action.setBadgeText({ text: badge[0] });
  await chrome.action.setTitle({
    title: state === 'on' ? t('{0}: подключено ({1})', BRAND.name, extra.nodeName || '') : BRAND.name,
  });
  await setIcon(state === 'on');
}

async function setIcon(on) {
  const sizes = [16, 32, 48];
  const path = Object.fromEntries(sizes.map((s) => [s, `icons/${on ? 'on-' : ''}${s}.png`]));
  try { await chrome.action.setIcon({ path }); } catch { /* иконки могли не собраться */ }
}

async function getStatus() {
  const { status } = await chrome.storage.session.get({ status: { state: 'off' } });
  return status;
}

// ---------- связь с помощником (native messaging) ----------

let port = null;
let seq = 0;
const pending = new Map();
let helperUsers = 0; // сколько операций сейчас пользуются помощником
let connectBusy = 0; // идёт подключение
let coreActive = false; // ядро запущено нашим подключением
let caps = null; // что умеет установленный помощник: { version, features: Set }
let capsStale = true; // помощник мог смениться (новое соединение, обновление)

// Ошибки уровня «помощник недоступен». Возвращает null, если это обычная ошибка операции.
function hostError(msg) {
  if (/Access to the specified native messaging host is forbidden/i.test(msg)) {
    return { code: 'no_helper', error: t('Помощник установлен для другого расширения. Установи его заново.') };
  }
  if (/not found|not installed|Specified native messaging host/i.test(msg)) {
    return { code: 'no_helper', error: t('Помощник не установлен. Он нужен, чтобы работали VLESS, Hysteria2 и другие протоколы.') };
  }
  if (/неизвестная команда/i.test(msg)) {
    return { code: 'old_helper', error: t('Помощник устарел. Обнови его, и всё заработает.') };
  }
  if (/Native host has exited|Error when communicating with the native messaging host/i.test(msg)) {
    return { code: 'helper_crash', error: t('Помощник неожиданно завершился. Попробуй ещё раз.') };
  }
  return null;
}

function helperError(e, fallbackCode = 'helper') {
  const info = hostError(e.message) || { code: e.code || fallbackCode, error: tHelper(e.message) };
  return Object.assign(new Error(info.error), { code: info.code });
}

function failPending(msg) {
  const list = [...pending.values()];
  pending.clear();
  for (const p of list) p.reject(new Error(msg));
}

function ensurePort() {
  if (port) return port;
  const created = chrome.runtime.connectNative(BRAND.helperName);
  port = created;
  capsStale = true;
  created.onMessage.addListener(onHostMessage);
  created.onDisconnect.addListener(() => {
    const msg = chrome.runtime.lastError?.message || t('Помощник отключился');
    if (port === created) port = null;
    failPending(msg);
    onHelperGone(msg);
  });
  return port;
}

function closePort() {
  if (!port) return;
  try { port.disconnect(); } catch { /* уже закрыт */ }
  port = null;
  failPending(t('Соединение с помощником закрыто'));
}

// Закрывает помощник, когда он никому не нужен: без подключения он не должен висеть в памяти.
function releaseHelperIfIdle() {
  if (!helperUsers && !connectBusy && !coreActive) closePort();
}

async function withHelper(fn) {
  helperUsers++;
  try {
    return await fn();
  } finally {
    helperUsers--;
    releaseHelperIfIdle();
  }
}

function callHelper(cmd, args = {}, timeoutMs = 15000, { onResult } = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(t('Помощник не ответил вовремя')));
      }, timeoutMs);
    };
    arm();
    pending.set(id, {
      parts: [],
      touch: arm,
      onResult,
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try {
      ensurePort().postMessage({ id, cmd, ...args });
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

function onHostMessage(msg) {
  const p = msg && msg.id ? pending.get(msg.id) : null;
  if (p) {
    // Большие ответы (подписки) помощник присылает частями: Chrome не принимает сообщения больше 1 МБ.
    if (msg.part !== undefined) {
      p.parts[msg.part] = msg.data;
      p.touch();
      return;
    }
    // Промежуточный результат замера пинга по одному узлу.
    if (Array.isArray(msg.result)) {
      p.touch();
      try { p.onResult?.(msg.result[0], msg.result[1]); } catch { /* не мешаем замеру */ }
      return;
    }
    pending.delete(msg.id);
    if (msg.ok) p.resolve({ ...msg, chunks: p.parts });
    else p.reject(new Error(msg.error || t('Ошибка помощника')));
    return;
  }
  if (msg?.event === 'exited') {
    onCoreExited(msg.error || t('ядро завершилось'));
  }
}

// Что умеет помощник. У версий до 1.1 нет списка возможностей: считаем, что только базовые.
async function ensureCaps() {
  if (caps && !capsStale) return caps;
  const res = await callHelper('hello', {}, 5000);
  caps = {
    version: res.version,
    features: new Set(Array.isArray(res.features) ? res.features : []),
    core: res.coreVersion,
    corePath: res.corePath,
    coreError: res.coreError,
    xrayVersion: res.xrayVersion,
  };
  capsStale = false;
  return caps;
}

function needsUpdateError(what) {
  return Object.assign(new Error(t('{0} нужен помощник новее. Обнови его, это займёт минуту.', what)), { code: 'helper_feature' });
}

// ---------- прокси в браузере ----------

function proxyDomains(settings) {
  if (settings.mode === 'except') return normalizeDomains(settings.exceptList);
  if (settings.mode === 'only') return normalizeDomains(settings.onlyList);
  return [];
}

async function applyProxy(settings) {
  const current = await chrome.proxy.settings.get({});
  if (current.levelOfControl === 'controlled_by_other_extensions') {
    throw new Error(t('Прокси сейчас контролирует другое расширение. Отключи его и попробуй снова.'));
  }
  if (current.levelOfControl === 'not_controllable') {
    throw new Error(t('Настройки прокси заблокированы политикой браузера.'));
  }
  const data = buildPac({
    port: settings.port, mode: settings.mode, domains: proxyDomains(settings), rules: normalizeRules(settings.siteRules),
  });
  await chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript: { data } }, scope: 'regular' });
}

async function clearProxy() {
  try { await chrome.proxy.settings.clear({ scope: 'regular' }); } catch { /* ничего */ }
}

// Наш прокси сейчас включён в браузере (нужно kill switch'у, чтобы не снимать его при обрыве).
async function ourProxyActive() {
  try {
    const cur = await chrome.proxy.settings.get({});
    return cur.levelOfControl === 'controlled_by_this_extension' && cur.value?.mode === 'pac_script';
  } catch {
    return false;
  }
}

// WebRTC может узнать настоящий IP в обход прокси. Политика disable_non_proxied_udp
// пускает WebRTC только через прокси.
async function applyWebRTC(settings) {
  if (!settings.webrtcProtect) return clearWebRTC();
  try {
    await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: 'disable_non_proxied_udp' });
  } catch { /* политика браузера может запрещать — подключение это не ломает */ }
}

async function clearWebRTC() {
  try { await chrome.privacy.network.webRTCIPHandlingPolicy.clear({}); } catch { /* ничего */ }
}

// ---------- подключение ----------

let connectChain = Promise.resolve();

function connect() {
  connectChain = connectChain.then(doConnect, doConnect);
  return connectChain;
}

async function doConnect() {
  const state = await loadState();
  let node = findNode(state, state.selectedId);
  if (!node) {
    node = allNodes(state).find(usable);
    if (!node) {
      const info = allNodes(state).find((n) => n.info);
      if (info) throw new Error(t('Нет серверов для подключения. Сообщение от сервиса: {0}', info.name));
      throw new Error(state.subs.length || state.manual.length ? t('В подписке нет серверов, к которым можно подключиться') : t('Сначала добавь подписку или узел'));
    }
    await chrome.storage.local.set({ selectedId: node.id });
  }
  connectBusy++;
  try {
    await setStatus('connecting', { nodeId: node.id, nodeName: node.name });
    await chrome.storage.local.set({ wantConnected: true });
    if (node.core === 'xray') {
      const c = await ensureCaps();
      if (!c.features.has('xray')) throw needsUpdateError(t('Для серверов {0}', node.label));
    }
    const { core, config } = buildNodeConfig(node, { port: state.settings.port });
    const res = await callHelper('start', { config, port: state.settings.port, core }, 25000);
    coreActive = true;
    await applyProxy(state.settings);
    await applyWebRTC(state.settings);
    stopReconnect();
    await setStatus('on', {
      nodeId: node.id, nodeName: node.name, since: Date.now(), core: res.core || 'sing-box', coreVersion: res.coreVersion || '',
    });
    return { ok: true };
  } catch (e) {
    const err = helperError(e, 'start');
    if (coreActive) {
      // Ядро запустилось, но прокси применить не удалось: останавливаем его.
      try { await callHelper('stop', {}, 5000); } catch { /* помощник уже недоступен */ }
      coreActive = false;
    }
    if (state.settings.killSwitch && (await ourProxyActive())) {
      // Kill switch: прокси был включён (переподключение или смена узла) — оставляем его,
      // чтобы сайты не открылись мимо VPN, и пробуем переподключиться.
      await setKillSwitchStatus(err.message, node);
      scheduleReconnect();
    } else {
      await clearProxy();
      await clearWebRTC();
      await chrome.storage.local.set({ wantConnected: false });
      await setStatus('error', { code: err.code, error: err.message, nodeId: node.id, nodeName: node.name });
    }
    throw err;
  } finally {
    connectBusy--;
    releaseHelperIfIdle();
  }
}

async function disconnect() {
  stopReconnect();
  await chrome.storage.local.set({ wantConnected: false });
  await clearProxy();
  await clearWebRTC();
  if (port) {
    try { await callHelper('stop', {}, 5000); } catch { /* всё равно закрываем */ }
  }
  coreActive = false;
  releaseHelperIfIdle();
  await setStatus('off');
}

// Соединение оборвалось само (ядро упало, помощник закрылся).
async function connectionLost(info) {
  coreActive = false;
  const status = await getStatus();
  if (status.state !== 'on' && status.state !== 'connecting') return;
  const state = await loadState();
  if (state.settings.killSwitch) {
    await setKillSwitchStatus(info.error, { id: status.nodeId, name: status.nodeName });
    scheduleReconnect();
  } else {
    await clearProxy();
    await clearWebRTC();
    await chrome.storage.local.set({ wantConnected: false });
    await setStatus('error', info);
  }
  releaseHelperIfIdle();
}

async function setKillSwitchStatus(detail, node) {
  await setStatus('error', {
    code: 'killswitch',
    error: t('Соединение оборвалось. Сайты через VPN не откроются, пока оно не восстановится: включена защита от утечки.'),
    detail,
    nodeId: node?.id,
    nodeName: node?.name,
  });
}

async function onCoreExited(error) {
  await connectionLost({ code: 'core', error: t('Соединение оборвалось: {0}', tHelper(error)) });
}

async function onHelperGone(msg) {
  if (connectBusy) return; // ошибку покажет само подключение
  await connectionLost(hostError(msg) || { code: 'helper', error: msg });
}

// Переподключение при включённом kill switch: сначала быстро, потом раз в минуту.
let reconnectTimer = null;

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => tryReconnect(), 3000);
  chrome.alarms.create('reconnect', { periodInMinutes: 1 });
}

function stopReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  chrome.alarms.clear('reconnect');
}

async function tryReconnect() {
  const state = await loadState();
  const status = await getStatus();
  if (!state.wantConnected || status.state === 'on') { stopReconnect(); return; }
  if (status.state === 'connecting') return;
  connect().catch(() => {});
}

// ---------- подписки ----------

function decodeChunks(chunks, count) {
  if (chunks.length !== count) throw new Error(t('Подписка пришла не полностью, попробуй ещё раз'));
  const arrays = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (typeof chunks[i] !== 'string') throw new Error(t('Подписка пришла не полностью, попробуй ещё раз'));
    const bin = atob(chunks[i]);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    arrays.push(arr);
    total += arr.length;
  }
  // Части склеиваем как байты: граница части может пройти посреди символа UTF-8.
  const all = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { all.set(a, off); off += a.length; }
  return new TextDecoder('utf-8').decode(all);
}

function statusMessage(status) {
  if (status === 404) return t('Подписка не найдена (404). Проверь ссылку.');
  if (status === 401 || status === 403) return t('Сервер подписки отказал в доступе ({0}). Возможно, подписка отключена.', status);
  if (status >= 500) return t('Сервер подписки временно не работает ({0}). Попробуй позже.', status);
  return t('Сервер подписки ответил {0}', status);
}

async function fetchSubscription(url, settings) {
  let res;
  try {
    res = await withHelper(() => callHelper('fetch', { url, userAgent: settings.userAgent || DEFAULT_UA }, 40000));
  } catch (e) {
    throw helperError(e, 'fetch');
  }
  if (res.status < 200 || res.status >= 300) throw new Error(statusMessage(res.status));
  const text = decodeChunks(res.chunks, res.parts || 0);
  const { nodes, errors } = parseSubscription(text);
  // Пустой ответ с кодом 200 — это ответ панели (например, подписка заморожена), а не сбой:
  // старый список серверов в таком случае показывать нельзя.
  if (!nodes.length && text.trim()) {
    throw new Error(errors[0] || t('В подписке не нашлось ни одного узла'));
  }
  const h = res.headers || {};
  return {
    nodes,
    errors,
    title: parseProfileTitle(h['profile-title']),
    userinfo: parseUserInfo(h['subscription-userinfo']),
    supportUrl: h['support-url'] || '',
    webPage: h['profile-web-page-url'] || '',
    updateHours: parseInt(h['profile-update-interval'] || '', 10) || null,
    announce: parseProfileTitle(h['announce']).slice(0, 500),
  };
}

// После изменения списка узлов убираем замеры пинга для узлов, которых больше нет.
async function tidyAfterNodesChange() {
  const state = await loadState();
  const nodes = allNodes(state);
  const ids = new Set(nodes.map((n) => n.id));
  const latency = Object.fromEntries(Object.entries(state.latency).filter(([id]) => ids.has(id)));
  const patch = { latency };
  // Если узел ещё не выбран, выбираем первый рабочий (обычно это группа «Авто»).
  if (!state.selectedId || !ids.has(state.selectedId)) {
    const status = await getStatus();
    if (status.state !== 'on' && status.state !== 'connecting') {
      patch.selectedId = nodes.find(usable)?.id || null;
    }
  }
  await chrome.storage.local.set(patch);
}

async function addOrUpdateSubscription(url) {
  const state = await loadState();
  const id = hashString(url);
  const data = await fetchSubscription(url, state.settings);
  const fresh = await loadState();
  const prev = fresh.subs.find((s) => s.id === id);
  let name = data.title || prev?.name;
  if (!name) { try { name = new URL(url).hostname; } catch { name = t('Подписка'); } }
  const sub = {
    id, url, name,
    nodes: data.nodes,
    userinfo: data.userinfo,
    supportUrl: data.supportUrl,
    webPage: data.webPage,
    updateHours: data.updateHours,
    announce: data.announce || '',
    skipped: data.errors.length,
    updatedAt: Date.now(),
    error: null,
  };
  const subs = prev ? fresh.subs.map((s) => (s.id === id ? sub : s)) : [...fresh.subs, sub];
  await chrome.storage.local.set({ subs });
  await tidyAfterNodesChange();
  return { sub, ...countNodes(data.nodes) };
}

function countNodes(nodes) {
  return {
    added: nodes.filter(usable).length,
    unsupported: nodes.filter((n) => n.unsupported).length,
    messages: nodes.filter((n) => n.info).map((n) => n.name),
  };
}

async function addInput(text) {
  const lines = String(text || '').split(/\s+/).map((s) => s.trim()).filter(Boolean);
  const urls = lines.filter((l) => /^https?:\/\//i.test(l));
  if (urls.length && urls.length === lines.length) {
    let added = 0;
    let unsupported = 0;
    let ok = 0;
    const messages = [];
    let firstError = null;
    for (const url of urls) {
      try {
        const r = await addOrUpdateSubscription(url);
        added += r.added;
        unsupported += r.unsupported;
        messages.push(...r.messages);
        ok++;
      } catch (e) {
        firstError = firstError || e;
      }
    }
    if (!ok && firstError) throw firstError;
    return { added, unsupported, messages };
  }
  const { nodes, errors } = parseSubscription(text);
  if (!nodes.length) throw new Error(errors[0] || t('Не нашлось ни одной ссылки на узел или подписку'));
  const state = await loadState();
  const known = new Set(state.manual.map((n) => n.id));
  const manual = [...state.manual, ...nodes.filter((n) => !known.has(n.id))];
  await chrome.storage.local.set({ manual });
  await tidyAfterNodesChange();
  return countNodes(nodes);
}

// Как часто обновлять подписку: интервал из настроек, но не реже, чем просит сама панель
// (заголовок profile-update-interval), иначе о заморозке или новых серверах узнаем поздно.
function subIntervalMs(sub, settings) {
  const hours = Math.min(settings.updateHours, sub.updateHours || Infinity);
  return Math.max(1, hours) * 3600e3;
}

let updatingAll = null;

// onlyStale: обновлять только устаревшие подписки (по интервалу или старше maxAgeMs).
function updateAllSubscriptions({ onlyStale = false, maxAgeMs = null } = {}) {
  if (updatingAll) return updatingAll; // уже идёт обновление: не запускаем второе параллельно
  updatingAll = doUpdateAll(onlyStale, maxAgeMs).finally(() => { updatingAll = null; });
  return updatingAll;
}

async function doUpdateAll(onlyStale, maxAgeMs) {
  const state = await loadState();
  const now = Date.now();
  const subs = state.subs.filter((sub) => {
    if (!onlyStale) return true;
    const age = now - (sub.updatedAt || 0);
    return age >= subIntervalMs(sub, state.settings) || (maxAgeMs != null && age >= maxAgeMs);
  });
  if (!subs.length) return { updated: 0, failed: 0 };
  let failed = 0;
  let lastError = null;
  // Держим помощник открытым на всё обновление, чтобы не запускать его заново для каждой подписки.
  await withHelper(async () => {
    for (const sub of subs) {
      try {
        await addOrUpdateSubscription(sub.url);
      } catch (e) {
        failed++;
        lastError = e;
        const fresh = await loadState();
        // Время попытки запоминаем, чтобы не повторять её при каждом открытии popup.
        await chrome.storage.local.set({
          subs: fresh.subs.map((s) => (s.id === sub.id ? { ...s, error: e.message, updatedAt: Date.now() } : s)),
        });
        if (e.code === 'no_helper' || e.code === 'old_helper') break; // остальные упадут так же
      }
    }
  });
  if (!onlyStale && failed && failed === subs.length && lastError) throw lastError;
  return { updated: subs.length - failed, failed };
}

async function removeSubscription(id) {
  const state = await loadState();
  await chrome.storage.local.set({ subs: state.subs.filter((s) => s.id !== id) });
  await tidyAfterNodesChange();
}

async function removeManual(id) {
  const state = await loadState();
  await chrome.storage.local.set({ manual: state.manual.filter((n) => n.id !== id) });
  await tidyAfterNodesChange();
}

// ---------- замер задержки ----------

let testingNow = false;

async function testLatency(group) {
  const state = await loadState();
  let nodes;
  if (group === 'manual') nodes = state.manual;
  else if (group) nodes = state.subs.find((s) => s.id === group)?.nodes || [];
  else nodes = allNodes(state);
  // Группы «Авто» сами выбирают лучший узел внутри sing-box, отдельно их не меряем.
  nodes = nodes.filter((n) => usable(n) && !n.members);
  if (!nodes.length) return { results: {} };

  testingNow = true;
  try {
    return await withHelper(async () => {
      // Узлы xray меряем, только если помощник умеет xray: иначе он принял бы их за sing-box,
      // и замер всех узлов откатился бы на простой TCP-пинг.
      let c;
      try { c = await ensureCaps(); } catch (e) { throw helperError(e, 'test'); }
      const skipped = c.features.has('xray') ? 0 : nodes.filter((n) => n.core === 'xray').length;
      if (skipped) nodes = nodes.filter((n) => n.core !== 'xray');
      if (!nodes.length) return { tested: 0, alive: 0, skipped };
      return await runTest(group, nodes, skipped);
    });
  } finally {
    testingNow = false;
  }
}

async function runTest(group, nodes, skipped) {
  // Старые значения убираем, чтобы было видно, какие узлы уже перемерены.
  const ids = new Set(nodes.map((n) => n.id));
  const start = await loadState();
  const cleared = Object.fromEntries(Object.entries(start.latency).filter(([id]) => !ids.has(id)));
  await chrome.storage.local.set({ latency: cleared });
  const testing = { group: group || 'all', count: nodes.length, done: 0 };
  await chrome.storage.session.set({ testing });

  // Результаты приходят по одному; сохраняем их пачками, чтобы popup показывал пинг сразу,
  // но не перерисовывался сотни раз в секунду.
  let buffer = {};
  let flushTimer = null;
  let flushing = Promise.resolve();
  const flush = () => {
    clearTimeout(flushTimer);
    flushTimer = null;
    const batch = buffer;
    buffer = {};
    if (!Object.keys(batch).length) return flushing;
    testing.done += Object.keys(batch).length;
    flushing = flushing.then(async () => {
      const fresh = await loadState();
      await chrome.storage.local.set({ latency: { ...fresh.latency, ...batch } });
      await chrome.storage.session.set({ testing: { ...testing } });
    });
    return flushing;
  };
  const onResult = (id, ms) => {
    if (!ids.has(id)) return;
    buffer[id] = ms;
    if (!flushTimer) flushTimer = setTimeout(flush, 250);
  };

  try {
    let res;
    try {
      res = await callHelper('test', {
        url: TEST_URL,
        timeoutMs: 5000,
        stream: true,
        nodes: nodes.map((n) => ({
          id: n.id, outbound: n.outbound, core: n.core || 'sing-box', xray: n.xray, server: n.server, port: n.port,
        })),
      }, 180000, { onResult });
    } catch (e) {
      throw helperError(e, 'test');
    }
    buffer = {};
    await flush();
    // Итог помощника полный: на случай, если какие-то промежуточные сообщения потерялись.
    const fresh = await loadState();
    await chrome.storage.local.set({ latency: { ...fresh.latency, ...res.results } });
    const alive = Object.values(res.results).filter((ms) => ms > 0).length;
    return { tested: nodes.length, alive, method: res.method, skipped };
  } finally {
    clearTimeout(flushTimer);
    await flushing.catch(() => {});
    await chrome.storage.session.set({ testing: null });
  }
}

// ---------- скорость соединения ----------

async function connectionStats() {
  const status = await getStatus();
  if (status.state !== 'on' || !port) return { available: false };
  try {
    const c = await ensureCaps();
    if (!c.features.has('stats')) return { available: false };
    const r = await callHelper('stats', {}, 3000);
    return { available: !!r.available, down: r.down || 0, up: r.up || 0, at: Date.now() };
  } catch {
    return { available: false };
  }
}

// ---------- настройки ----------

async function saveSettings(patch) {
  const state = await loadState();
  const settings = { ...state.settings, ...patch };
  settings.port = Math.min(65535, Math.max(1024, parseInt(settings.port, 10) || DEFAULT_SETTINGS.port));
  settings.updateHours = Math.min(168, Math.max(1, parseInt(settings.updateHours, 10) || DEFAULT_SETTINGS.updateHours));
  settings.userAgent = String(settings.userAgent || '').trim().slice(0, 200) || DEFAULT_UA;
  settings.sortByPing = !!settings.sortByPing;
  settings.showUnsupported = !!settings.showUnsupported;
  settings.webrtcProtect = !!settings.webrtcProtect;
  settings.killSwitch = !!settings.killSwitch;
  settings.siteRules = normalizeRules(settings.siteRules);
  if (!['auto', 'ru', 'en'].includes(settings.lang)) settings.lang = 'auto';
  if (!['all', 'except', 'only'].includes(settings.mode)) settings.mode = DEFAULT_SETTINGS.mode;
  await chrome.storage.local.set({ settings });
  setLang(detectLang(settings.lang));
  scheduleAlarms(settings);
  const status = await getStatus();
  if (status.state === 'on') {
    if (settings.port !== state.settings.port) await connect();
    else {
      await applyProxy(settings);
      await applyWebRTC(settings);
    }
  }
  return { settings };
}

// Правило «этот сайт через VPN / напрямую». route = null убирает правило.
async function setSiteRule(domain, route) {
  const state = await loadState();
  const rules = { ...normalizeRules(state.settings.siteRules) };
  const key = Object.keys(normalizeRules({ [domain]: 'proxy' }))[0];
  if (!key) throw new Error(t('Не удалось определить сайт'));
  if (route === 'proxy' || route === 'direct') rules[key] = route;
  else delete rules[key];
  return saveSettings({ siteRules: rules });
}

async function selectNode(id) {
  await chrome.storage.local.set({ selectedId: id });
  const status = await getStatus();
  if (status.state === 'on' || status.state === 'connecting') await connect();
}

// ---------- помощник: наличие, версия, обновление ----------

async function helperInfo() {
  const { remote } = await chrome.storage.local.get({ remote: null });
  const remoteMin = remote?.helper?.min;
  const minVer = remoteMin && compareVersions(remoteMin, BRAND.minHelper) > 0 ? remoteMin : BRAND.minHelper;
  const latest = remote?.helper?.latest || null;
  try {
    const c = await withHelper(() => { capsStale = true; return ensureCaps(); });
    const updateAvailable = !!latest && compareVersions(c.version, latest) < 0;
    if (updateAvailable) maybeAutoUpdate().catch(() => {});
    return {
      installed: true,
      version: c.version,
      core: c.core,
      corePath: c.corePath,
      coreError: c.coreError,
      xray: c.xrayVersion || null,
      features: [...c.features],
      canSelfUpdate: c.features.has('update'),
      outdated: compareVersions(c.version, minVer) < 0,
      latest,
      updateAvailable,
    };
  } catch (e) {
    const info = hostError(e.message) || { code: 'helper', error: e.message };
    return { installed: false, ...info };
  }
}

let helperUpdating = null;

// Обновление помощника: он сам скачивает новую версию с GitHub и ставит её.
// Помощник до 1.1 этого не умеет — тогда пользователь обновляет его вручную.
function updateHelper() {
  if (helperUpdating) return helperUpdating;
  helperUpdating = doUpdateHelper().finally(() => { helperUpdating = null; });
  return helperUpdating;
}

async function doUpdateHelper() {
  const status = await getStatus();
  if (status.state === 'on' || status.state === 'connecting') {
    throw new Error(t('Сначала отключи VPN: помощник обновляется, когда соединение выключено.'));
  }
  await chrome.storage.local.set({ helperUpdate: { state: 'running', at: Date.now() } });
  try {
    const r = await withHelper(async () => {
      const c = await ensureCaps();
      if (!c.features.has('update')) throw Object.assign(new Error(t('Эта версия помощника не умеет обновляться сама. Установи новую вручную.')), { code: 'old_helper' });
      return callHelper('update', {}, 300000);
    });
    // Работающий процесс помощника — ещё старый: закрываем его, следующий запуск будет новым.
    closePort();
    capsStale = true;
    caps = null;
    const result = { state: r.updated ? 'done' : 'current', version: r.version, from: r.previous || null, at: Date.now() };
    await chrome.storage.local.set({ helperUpdate: result });
    return result;
  } catch (e) {
    const err = helperError(e, 'update');
    await chrome.storage.local.set({ helperUpdate: { state: 'error', error: err.message, at: Date.now() } });
    throw err;
  }
}

// Тихое обновление в фоне: только когда VPN выключен, помощник ничем не занят
// и после неудачи прошло хотя бы 6 часов.
async function maybeAutoUpdate() {
  if (helperUpdating || helperUsers || connectBusy || testingNow) return;
  const status = await getStatus();
  if (status.state === 'on' || status.state === 'connecting') return;
  const { remote, helperUpdate } = await chrome.storage.local.get({ remote: null, helperUpdate: null });
  const latest = remote?.helper?.latest;
  if (!latest) return;
  if (helperUpdate?.state === 'error' && Date.now() - helperUpdate.at < 6 * 3600e3) return;
  let c;
  try { c = await withHelper(() => ensureCaps()); } catch { return; }
  if (!c.features.has('update') || compareVersions(c.version, latest) >= 0) return;
  await updateHelper().catch(() => {});
}

// ---------- удалённый конфиг: версия помощника и рекламный блок ----------

async function refreshRemote(force = false) {
  const { remote } = await chrome.storage.local.get({ remote: null });
  const { remoteTriedAt } = await chrome.storage.session.get({ remoteTriedAt: 0 });
  const fresh = remote && Date.now() - remote.fetchedAt < 20 * 3600e3;
  if (!force && (fresh || Date.now() - remoteTriedAt < 3600e3)) return remote;
  await chrome.storage.session.set({ remoteTriedAt: Date.now() });
  try {
    const resp = await fetch(BRAND.remoteConfigUrl, { cache: 'no-store', credentials: 'omit' });
    if (!resp.ok) throw new Error(String(resp.status));
    const j = await resp.json();
    const ver = (v) => (typeof v === 'string' && /^\d+(\.\d+){0,3}$/.test(v) ? v : null);
    const next = {
      fetchedAt: Date.now(),
      helper: { latest: ver(j?.helper?.latest), min: ver(j?.helper?.min) },
      promo: sanitizePromo(j?.promo),
      promoEn: sanitizePromo(j?.promoEn),
    };
    await chrome.storage.local.set({ remote: next });
    return next;
  } catch {
    return remote; // нет сети или файла — остаёмся на том, что есть
  }
}

async function scheduleAlarms() {
  // Раз в час проверяем, какие подписки пора обновить (у каждой свой интервал).
  if ((await chrome.alarms.get('update-subs'))?.periodInMinutes !== 60) {
    chrome.alarms.create('update-subs', { periodInMinutes: 60 });
  }
  if (!(await chrome.alarms.get('remote-config'))) {
    chrome.alarms.create('remote-config', { periodInMinutes: 24 * 60 });
  }
}

// ---------- сообщения от popup ----------

const handlers = {
  connect: () => connect(),
  disconnect: () => disconnect(),
  add: (m) => addInput(m.text),
  updateSub: (m) => addOrUpdateSubscription(m.url),
  updateAll: () => updateAllSubscriptions(),
  // Popup открыли: обновляем подписки старше 30 минут, не задерживая ответ.
  refreshStale: () => { updateAllSubscriptions({ onlyStale: true, maxAgeMs: 30 * 60e3 }).catch(() => {}); return {}; },
  removeSub: (m) => removeSubscription(m.id),
  removeManual: (m) => removeManual(m.id),
  select: (m) => selectNode(m.id),
  test: (m) => testLatency(m.group),
  saveSettings: (m) => saveSettings(m.settings),
  setSiteRule: (m) => setSiteRule(m.domain, m.route),
  helperInfo: () => helperInfo(),
  updateHelper: () => updateHelper(),
  stats: () => connectionStats(),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = handlers[msg?.type];
  if (!fn) return false;
  Promise.resolve()
    .then(() => fn(msg))
    .then((r) => sendResponse({ ok: true, ...(r || {}) }))
    .catch((e) => sendResponse({ ok: false, error: e.message, code: e.code }));
  return true;
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'update-subs') updateAllSubscriptions({ onlyStale: true }).catch(() => {});
  if (a.name === 'remote-config') refreshRemote(true).then(() => maybeAutoUpdate()).catch(() => {});
  if (a.name === 'reconnect') tryReconnect();
});

chrome.proxy.onProxyError.addListener((e) => {
  console.warn('proxy error', e);
});

chrome.runtime.onInstalled.addListener(async () => {
  await loadState();
  await scheduleAlarms();
});

// Пустой обработчик нужен, чтобы service worker запускался вместе с браузером:
// тогда код ниже восстановит подключение, а не оставит браузер с прокси на выключенное ядро.
chrome.runtime.onStartup.addListener(() => {});

// Каждый запуск service worker: если пользователь хотел быть подключён, а связи с помощником нет — восстанавливаем.
(async () => {
  const state = await loadState();
  if (state.wantConnected && !port) {
    connect().catch(() => {});
  } else if (!state.wantConnected) {
    const status = await getStatus();
    if (status.state === 'on' || status.state === 'connecting') await setStatus('off');
    await clearProxy();
    await clearWebRTC();
  }
  if (!(await chrome.alarms.get('update-subs'))) await scheduleAlarms();
  refreshRemote().then(() => maybeAutoUpdate()).catch(() => {});
})();
