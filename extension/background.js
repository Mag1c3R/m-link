import { parseSubscription, parseUserInfo, parseProfileTitle, hashString } from './lib/parser.js';
import { buildRunConfig, buildPac, normalizeDomains, DEFAULT_EXCEPT } from './lib/singbox.js';
import { BRAND, compareVersions, sanitizePromo } from './config.js';

const TEST_URL = 'https://www.gstatic.com/generate_204';
const DEFAULT_UA = `${BRAND.name}/${chrome.runtime.getManifest().version}`;

const DEFAULT_SETTINGS = {
  port: 10808,
  mode: 'except', // all | except | only
  exceptList: DEFAULT_EXCEPT.join('\n'),
  onlyList: '',
  userAgent: DEFAULT_UA,
  updateHours: 12,
  sortByPing: true,
  showUnsupported: false,
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
    title: state === 'on' ? `${BRAND.name}: подключено (${extra.nodeName || ''})` : BRAND.name,
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

// Ошибки уровня «помощник недоступен». Возвращает null, если это обычная ошибка операции.
function hostError(msg) {
  if (/Access to the specified native messaging host is forbidden/i.test(msg)) {
    return { code: 'no_helper', error: 'Помощник установлен для другого расширения. Установи его заново.' };
  }
  if (/not found|not installed|Specified native messaging host/i.test(msg)) {
    return { code: 'no_helper', error: 'Помощник не установлен. Он нужен, чтобы работали VLESS, Hysteria2 и другие протоколы.' };
  }
  if (/неизвестная команда/i.test(msg)) {
    return { code: 'old_helper', error: 'Помощник устарел. Обнови его, и всё заработает.' };
  }
  if (/Native host has exited|Error when communicating with the native messaging host/i.test(msg)) {
    return { code: 'helper_crash', error: 'Помощник неожиданно завершился. Попробуй ещё раз.' };
  }
  return null;
}

function helperError(e, fallbackCode = 'helper') {
  const info = hostError(e.message) || { code: e.code || fallbackCode, error: e.message };
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
  created.onMessage.addListener(onHostMessage);
  created.onDisconnect.addListener(() => {
    const msg = chrome.runtime.lastError?.message || 'Помощник отключился';
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
  failPending('Соединение с помощником закрыто');
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
        reject(new Error('Помощник не ответил вовремя'));
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
    else p.reject(new Error(msg.error || 'Ошибка помощника'));
    return;
  }
  if (msg?.event === 'exited') {
    onCoreExited(msg.error || 'sing-box завершился');
  }
}

async function onCoreExited(error) {
  coreActive = false;
  const status = await getStatus();
  if (status.state === 'on' || status.state === 'connecting') {
    await clearProxy();
    await chrome.storage.local.set({ wantConnected: false });
    await setStatus('error', { code: 'core', error: 'Соединение оборвалось: ' + error });
  }
  releaseHelperIfIdle();
}

async function onHelperGone(msg) {
  coreActive = false;
  const status = await getStatus();
  if (status.state !== 'on' && status.state !== 'connecting') return;
  if (connectBusy) return; // ошибку покажет само подключение
  await clearProxy();
  await chrome.storage.local.set({ wantConnected: false });
  await setStatus('error', hostError(msg) || { code: 'helper', error: msg });
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
    throw new Error('Прокси сейчас контролирует другое расширение. Отключи его и попробуй снова.');
  }
  if (current.levelOfControl === 'not_controllable') {
    throw new Error('Настройки прокси заблокированы политикой браузера.');
  }
  const data = buildPac({ port: settings.port, mode: settings.mode, domains: proxyDomains(settings) });
  await chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript: { data } }, scope: 'regular' });
}

async function clearProxy() {
  try { await chrome.proxy.settings.clear({ scope: 'regular' }); } catch { /* ничего */ }
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
      if (info) throw new Error(`Нет серверов для подключения. Сообщение от сервиса: ${info.name}`);
      throw new Error(state.subs.length || state.manual.length ? 'В подписке нет серверов, к которым можно подключиться' : 'Сначала добавь подписку или узел');
    }
    await chrome.storage.local.set({ selectedId: node.id });
  }
  connectBusy++;
  try {
    await setStatus('connecting', { nodeId: node.id, nodeName: node.name });
    await chrome.storage.local.set({ wantConnected: true });
    const config = buildRunConfig(node.outbound, { port: state.settings.port, members: node.members });
    const res = await callHelper('start', { config, port: state.settings.port }, 25000);
    coreActive = true;
    await applyProxy(state.settings);
    await setStatus('on', {
      nodeId: node.id, nodeName: node.name, since: Date.now(), core: res.coreVersion || '',
    });
    return { ok: true };
  } catch (e) {
    const err = helperError(e, 'start');
    await clearProxy();
    await chrome.storage.local.set({ wantConnected: false });
    if (coreActive) {
      // Ядро запустилось, но прокси применить не удалось: останавливаем его.
      try { await callHelper('stop', {}, 5000); } catch { /* помощник уже недоступен */ }
      coreActive = false;
    }
    await setStatus('error', { code: err.code, error: err.message, nodeId: node.id, nodeName: node.name });
    throw err;
  } finally {
    connectBusy--;
    releaseHelperIfIdle();
  }
}

async function disconnect() {
  await chrome.storage.local.set({ wantConnected: false });
  await clearProxy();
  if (port) {
    try { await callHelper('stop', {}, 5000); } catch { /* всё равно закрываем */ }
  }
  coreActive = false;
  releaseHelperIfIdle();
  await setStatus('off');
}

// ---------- подписки ----------

function decodeChunks(chunks, count) {
  if (chunks.length !== count) throw new Error('Подписка пришла не полностью, попробуй ещё раз');
  const arrays = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (typeof chunks[i] !== 'string') throw new Error('Подписка пришла не полностью, попробуй ещё раз');
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
  if (status === 404) return 'Подписка не найдена (404). Проверь ссылку.';
  if (status === 401 || status === 403) return `Сервер подписки отказал в доступе (${status}). Возможно, подписка отключена.`;
  if (status >= 500) return `Сервер подписки временно не работает (${status}). Попробуй позже.`;
  return `Сервер подписки ответил ${status}`;
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
    throw new Error(errors[0] || 'В подписке не нашлось ни одного узла');
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
  if (!name) { try { name = new URL(url).hostname; } catch { name = 'Подписка'; } }
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
  if (!nodes.length) throw new Error(errors[0] || 'Не нашлось ни одной ссылки на узел или подписку');
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

async function testLatency(group) {
  const state = await loadState();
  let nodes;
  if (group === 'manual') nodes = state.manual;
  else if (group) nodes = state.subs.find((s) => s.id === group)?.nodes || [];
  else nodes = allNodes(state);
  // Группы «Авто» сами выбирают лучший узел внутри sing-box, отдельно их не меряем.
  nodes = nodes.filter((n) => usable(n) && !n.members);
  if (!nodes.length) return { results: {} };

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
      res = await withHelper(() => callHelper('test', {
        url: TEST_URL,
        timeoutMs: 5000,
        stream: true,
        nodes: nodes.map((n) => ({ id: n.id, outbound: n.outbound, server: n.server, port: n.port })),
      }, 180000, { onResult }));
    } catch (e) {
      throw helperError(e, 'test');
    }
    buffer = {};
    await flush();
    // Итог помощника полный: на случай, если какие-то промежуточные сообщения потерялись.
    const fresh = await loadState();
    await chrome.storage.local.set({ latency: { ...fresh.latency, ...res.results } });
    const alive = Object.values(res.results).filter((ms) => ms > 0).length;
    return { tested: nodes.length, alive, method: res.method };
  } finally {
    clearTimeout(flushTimer);
    await flushing.catch(() => {});
    await chrome.storage.session.set({ testing: null });
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
  if (!['all', 'except', 'only'].includes(settings.mode)) settings.mode = DEFAULT_SETTINGS.mode;
  await chrome.storage.local.set({ settings });
  scheduleAlarms(settings);
  const status = await getStatus();
  if (status.state === 'on') {
    if (settings.port !== state.settings.port) await connect();
    else await applyProxy(settings);
  }
  return { settings };
}

async function selectNode(id) {
  await chrome.storage.local.set({ selectedId: id });
  const status = await getStatus();
  if (status.state === 'on' || status.state === 'connecting') await connect();
}

// ---------- помощник: наличие и версия ----------

async function helperInfo() {
  const { remote } = await chrome.storage.local.get({ remote: null });
  const remoteMin = remote?.helper?.min;
  const minVer = remoteMin && compareVersions(remoteMin, BRAND.minHelper) > 0 ? remoteMin : BRAND.minHelper;
  const latest = remote?.helper?.latest || null;
  try {
    const res = await withHelper(() => callHelper('hello', {}, 5000));
    return {
      installed: true,
      version: res.version,
      core: res.coreVersion,
      corePath: res.corePath,
      coreError: res.coreError,
      outdated: compareVersions(res.version, minVer) < 0,
      latest,
      updateAvailable: !!latest && compareVersions(res.version, latest) < 0,
    };
  } catch (e) {
    const info = hostError(e.message) || { code: 'helper', error: e.message };
    return { installed: false, ...info };
  }
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
    };
    await chrome.storage.local.set({ remote: next });
    return next;
  } catch {
    return remote; // нет сети или файла — остаёмся на том, что есть
  }
}

async function scheduleAlarms(settings) {
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
  helperInfo: () => helperInfo(),
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
  if (a.name === 'remote-config') refreshRemote(true);
});

chrome.proxy.onProxyError.addListener((e) => {
  console.warn('proxy error', e);
});

chrome.runtime.onInstalled.addListener(async () => {
  const state = await loadState();
  await scheduleAlarms(state.settings);
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
  }
  if (!(await chrome.alarms.get('update-subs'))) await scheduleAlarms(state.settings);
  refreshRemote();
})();
