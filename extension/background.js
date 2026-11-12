import { parseSubscription, parseUserInfo, parseProfileTitle, hashString } from './lib/parser.js';
import { buildRunConfig, buildPac, normalizeDomains, DEFAULT_EXCEPT } from './lib/singbox.js';
import { BRAND } from './config.js';

const TEST_URL = 'https://www.gstatic.com/generate_204';

const DEFAULT_SETTINGS = {
  port: 10808,
  mode: 'except', // all | except | only
  exceptList: DEFAULT_EXCEPT.join('\n'),
  onlyList: '',
  userAgent: BRAND.userAgent,
  updateHours: 12,
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
  if (s.settings.userAgent === 'M-Client/0.1') s.settings.userAgent = BRAND.userAgent; // старое имя по умолчанию
  return s;
}

function allNodes(state) {
  return [...state.subs.flatMap((s) => s.nodes || []), ...state.manual];
}

function findNode(state, id) {
  return allNodes(state).find((n) => n.id === id && !n.unsupported) || null;
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

function friendlyHostError(msg) {
  if (/not found|not installed|Specified native messaging host/i.test(msg)) {
    return { code: 'no_helper', error: 'Помощник не установлен. Он нужен, чтобы работали VLESS, Hysteria2 и другие протоколы.' };
  }
  if (/Access to the specified native messaging host is forbidden/i.test(msg)) {
    return { code: 'no_helper', error: 'Помощник установлен для другого ID расширения. Переустанови его.' };
  }
  if (/exited|Native host has exited/i.test(msg)) {
    return { code: 'helper_crash', error: 'Помощник неожиданно завершился.' };
  }
  return { code: 'helper', error: msg };
}

function ensurePort() {
  if (port) return port;
  port = chrome.runtime.connectNative(BRAND.helperName);
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    const msg = chrome.runtime.lastError?.message || 'Помощник отключился';
    port = null;
    for (const p of pending.values()) p.reject(new Error(msg));
    pending.clear();
    onHelperGone(msg);
  });
  return port;
}

function closePort() {
  if (!port) return;
  try { port.disconnect(); } catch { /* уже закрыт */ }
  port = null;
}

function callHelper(cmd, args = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Помощник не ответил вовремя'));
    }, timeoutMs);
    pending.set(id, {
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
  if (msg && msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.error || 'Ошибка помощника'));
    return;
  }
  if (msg?.event === 'exited') {
    onCoreExited(msg.error || 'sing-box завершился');
  }
}

async function onCoreExited(error) {
  const status = await getStatus();
  if (status.state !== 'on' && status.state !== 'connecting') return;
  await clearProxy();
  await chrome.storage.local.set({ wantConnected: false });
  await setStatus('error', { code: 'core', error: 'Ядро остановилось: ' + error });
}

async function onHelperGone(msg) {
  const status = await getStatus();
  if (status.state !== 'on' && status.state !== 'connecting') return;
  await clearProxy();
  await chrome.storage.local.set({ wantConnected: false });
  await setStatus('error', friendlyHostError(msg));
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
    node = allNodes(state).find((n) => !n.unsupported);
    if (!node) throw new Error('Сначала добавь подписку или узел');
    await chrome.storage.local.set({ selectedId: node.id });
  }
  await setStatus('connecting', { nodeId: node.id, nodeName: node.name });
  await chrome.storage.local.set({ wantConnected: true });
  try {
    const config = buildRunConfig(node.outbound, { port: state.settings.port, members: node.members });
    const res = await callHelper('start', { config, port: state.settings.port }, 25000);
    await applyProxy(state.settings);
    await setStatus('on', {
      nodeId: node.id, nodeName: node.name, since: Date.now(), core: res.coreVersion || '',
    });
    return { ok: true };
  } catch (e) {
    await clearProxy();
    await chrome.storage.local.set({ wantConnected: false });
    const info = e.message.includes('native') || e.message.includes('host')
      ? friendlyHostError(e.message)
      : { code: 'start', error: e.message };
    await setStatus('error', { ...info, nodeId: node.id, nodeName: node.name });
    throw Object.assign(new Error(info.error), { code: info.code });
  }
}

async function disconnect() {
  await chrome.storage.local.set({ wantConnected: false });
  await clearProxy();
  if (port) {
    try { await callHelper('stop', {}, 5000); } catch { /* всё равно закрываем */ }
  }
  closePort();
  await setStatus('off');
}

// ---------- подписки ----------

async function applyUserAgent(ua) {
  const value = (ua || BRAND.userAgent).trim() || BRAND.userAgent;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'user-agent', operation: 'set', value }] },
      condition: { initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest', 'other'] },
    }],
  });
}

async function fetchSubscription(url, settings) {
  await applyUserAgent(settings.userAgent);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let resp;
  try {
    resp = await fetch(url, { cache: 'no-store', signal: ctrl.signal, credentials: 'omit' });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Сервер подписки не ответил за 20 секунд' : 'Не удалось скачать подписку: ' + e.message);
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw new Error(`Сервер подписки ответил ${resp.status}`);
  const text = await resp.text();
  const { nodes, errors } = parseSubscription(text);
  if (!nodes.length) {
    throw new Error(errors[0] || 'В подписке не нашлось ни одного узла');
  }
  return {
    nodes,
    errors,
    title: parseProfileTitle(resp.headers.get('profile-title')),
    userinfo: parseUserInfo(resp.headers.get('subscription-userinfo')),
    supportUrl: resp.headers.get('support-url') || '',
    webPage: resp.headers.get('profile-web-page-url') || '',
    updateHours: parseInt(resp.headers.get('profile-update-interval') || '', 10) || null,
  };
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
    skipped: data.errors.length,
    updatedAt: Date.now(),
    error: null,
  };
  const subs = prev ? fresh.subs.map((s) => (s.id === id ? sub : s)) : [...fresh.subs, sub];
  await chrome.storage.local.set({ subs });
  return { sub, added: data.nodes.length };
}

async function addInput(text) {
  const lines = String(text || '').split(/\s+/).map((s) => s.trim()).filter(Boolean);
  const urls = lines.filter((l) => /^https?:\/\//i.test(l));
  if (urls.length && urls.length === lines.length) {
    let added = 0;
    const errors = [];
    for (const url of urls) {
      try { added += (await addOrUpdateSubscription(url)).added; } catch (e) { errors.push(e.message); }
    }
    if (!added && errors.length) throw new Error(errors[0]);
    return { added, errors };
  }
  const { nodes, errors } = parseSubscription(text);
  if (!nodes.length) throw new Error(errors[0] || 'Не нашлось ни одной ссылки на узел или подписку');
  const state = await loadState();
  const known = new Set(state.manual.map((n) => n.id));
  const manual = [...state.manual, ...nodes.filter((n) => !known.has(n.id))];
  await chrome.storage.local.set({ manual });
  return { added: nodes.length, errors };
}

async function updateAllSubscriptions() {
  const state = await loadState();
  for (const sub of state.subs) {
    try {
      await addOrUpdateSubscription(sub.url);
    } catch (e) {
      const fresh = await loadState();
      await chrome.storage.local.set({
        subs: fresh.subs.map((s) => (s.id === sub.id ? { ...s, error: e.message } : s)),
      });
    }
  }
}

async function removeSubscription(id) {
  const state = await loadState();
  await chrome.storage.local.set({ subs: state.subs.filter((s) => s.id !== id) });
}

async function removeManual(id) {
  const state = await loadState();
  await chrome.storage.local.set({ manual: state.manual.filter((n) => n.id !== id) });
}

// ---------- замер задержки ----------

async function testLatency(group) {
  const state = await loadState();
  let nodes;
  if (group === 'manual') nodes = state.manual;
  else if (group) nodes = state.subs.find((s) => s.id === group)?.nodes || [];
  else nodes = allNodes(state);
  // Группы «Авто» сами выбирают лучший узел внутри sing-box, отдельно их не меряем.
  nodes = nodes.filter((n) => !n.unsupported && !n.members);
  if (!nodes.length) return { results: {} };
  await chrome.storage.session.set({ testing: group || 'all' });
  try {
    let res;
    try {
      res = await callHelper('test', {
        url: TEST_URL,
        timeoutMs: 5000,
        nodes: nodes.map((n) => ({ id: n.id, outbound: n.outbound, server: n.server, port: n.port })),
      }, 180000);
    } catch (e) {
      // Пинг меряет помощник, поэтому без него показываем понятную причину, а не сырую ошибку Chrome.
      const info = friendlyHostError(e.message);
      throw Object.assign(new Error(info.error), { code: info.code });
    }
    const fresh = await loadState();
    await chrome.storage.local.set({ latency: { ...fresh.latency, ...res.results } });
    return res;
  } finally {
    await chrome.storage.session.set({ testing: null });
    if ((await getStatus()).state !== 'on') closePort();
  }
}

// ---------- настройки ----------

async function saveSettings(patch) {
  const state = await loadState();
  const settings = { ...state.settings, ...patch };
  settings.port = Math.min(65535, Math.max(1024, parseInt(settings.port, 10) || DEFAULT_SETTINGS.port));
  settings.updateHours = Math.max(1, parseInt(settings.updateHours, 10) || DEFAULT_SETTINGS.updateHours);
  await chrome.storage.local.set({ settings });
  scheduleUpdates(settings);
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

async function helperInfo() {
  try {
    const res = await callHelper('hello', {}, 5000);
    return { installed: true, version: res.version, core: res.coreVersion, corePath: res.corePath, coreError: res.coreError };
  } catch (e) {
    return { installed: false, ...friendlyHostError(e.message) };
  } finally {
    if ((await getStatus()).state !== 'on') closePort();
  }
}

function scheduleUpdates(settings) {
  chrome.alarms.create('update-subs', { periodInMinutes: settings.updateHours * 60 });
}

// ---------- сообщения от popup ----------

const handlers = {
  connect: () => connect(),
  disconnect: () => disconnect(),
  add: (m) => addInput(m.text),
  updateSub: (m) => addOrUpdateSubscription(m.url),
  updateAll: () => updateAllSubscriptions(),
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
  if (a.name === 'update-subs') updateAllSubscriptions();
});

chrome.proxy.onProxyError.addListener((e) => {
  console.warn('proxy error', e);
});

chrome.runtime.onInstalled.addListener(async () => {
  const state = await loadState();
  scheduleUpdates(state.settings);
  await applyUserAgent(state.settings.userAgent);
});

// Каждый запуск service worker: если пользователь хотел быть подключён, а связи с помощником нет — восстанавливаем.
(async () => {
  const state = await loadState();
  await applyUserAgent(state.settings.userAgent).catch(() => {});
  if (state.wantConnected && !port) {
    connect().catch(() => {});
  } else if (!state.wantConnected) {
    const status = await getStatus();
    if (status.state === 'on' || status.state === 'connecting') await setStatus('off');
    await clearProxy();
  }
})();
