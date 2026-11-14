// Заглушка chrome.* для запуска настоящих background.js и popup.js в обычной странице.
// Хранилище, будильники и прокси — в памяти; connectNative идёт через tests/serve.py к настоящему помощнику.
// Управление из теста: window.__stub.helperAvailable, window.__stub.proxy, window.__stub.alarms.

export async function installChromeStub({ helperAvailable = true, platform = { os: 'mac', arch: 'arm64' }, local = {}, session = {}, tabUrl = 'https://www.youtube.com/watch?v=1', uiLang = 'ru' } = {}) {
  const manifest = await (await fetch('../extension/manifest.json')).json();
  const stub = { helperAvailable, proxy: null, webrtc: null, alarms: {}, badge: {}, ports: 0, tabUrl };
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const storageListeners = [];

  function area(name, data) {
    const emit = (changes) => {
      if (!Object.keys(changes).length) return;
      for (const l of [...storageListeners]) queueMicrotask(() => l(changes, name));
    };
    return {
      data,
      async get(keys) {
        if (keys == null) return clone(data);
        if (typeof keys === 'string') keys = [keys];
        const out = {};
        if (Array.isArray(keys)) {
          for (const k of keys) if (k in data) out[k] = clone(data[k]);
        } else {
          for (const [k, d] of Object.entries(keys)) out[k] = k in data ? clone(data[k]) : clone(d);
        }
        return out;
      },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: data[k], newValue: clone(v) };
          data[k] = clone(v);
        }
        emit(changes);
      },
      async remove(keys) {
        const changes = {};
        for (const k of [].concat(keys)) if (k in data) { changes[k] = { oldValue: data[k] }; delete data[k]; }
        emit(changes);
      },
    };
  }

  const event = () => {
    const ls = [];
    return { addListener: (f) => ls.push(f), fire: (...a) => ls.map((f) => f(...a)), ls };
  };
  const onMessage = event(), onInstalled = event(), onStartup = event(), onAlarm = event(), onProxyError = event();

  function connectNative(name) {
    const msgEvt = event(), discEvt = event();
    let id = null;
    let closed = false;
    stub.ports++;
    const port = {
      name,
      onMessage: msgEvt,
      onDisconnect: discEvt,
      postMessage(m) {
        if (closed) throw new Error('Attempting to use a disconnected port object');
        chain = chain.then(async (ok) => {
          if (ok && !closed) await fetch(`/native/${id}/send`, { method: 'POST', body: JSON.stringify(m) });
          return ok;
        });
      },
      disconnect() {
        if (closed) return;
        closed = true;
        chain.then(() => { if (id != null) fetch(`/native/${id}/close`, { method: 'POST' }); });
      },
    };
    const fail = (message) => {
      if (closed) return;
      closed = true;
      runtime.lastError = { message };
      discEvt.fire(port);
      runtime.lastError = undefined;
    };
    async function recvLoop() {
      while (!closed) {
        const r = await fetch(`/native/${id}/recv`);
        if (r.status === 410) { fail('Native host has exited.'); return; }
        for (const msg of await r.json()) if (!closed) msgEvt.fire(msg);
      }
    }
    let chain = (async () => {
      await null;
      if (!stub.helperAvailable || name !== 'com.mlink.helper') { fail('Specified native messaging host not found.'); return false; }
      const r = await fetch('/native/open', { method: 'POST' });
      if (!r.ok) { fail('Specified native messaging host not found.'); return false; }
      id = (await r.json()).id;
      recvLoop();
      return true;
    })();
    return port;
  }

  const runtime = {
    id: 'e2e',
    lastError: undefined,
    getManifest: () => manifest,
    getPlatformInfo: async () => platform,
    onMessage, onInstalled, onStartup,
    connectNative,
    sendMessage(msg) {
      return new Promise((resolve) => {
        let async = false;
        for (const l of onMessage.ls) {
          if (l(clone(msg), { id: 'e2e' }, (r) => resolve(clone(r))) === true) async = true;
        }
        if (!async) resolve(undefined);
      });
    },
  };

  window.chrome = {
    runtime,
    storage: {
      local: area('local', clone(local)),
      session: area('session', clone(session)),
      onChanged: { addListener: (f) => storageListeners.push(f) },
    },
    alarms: {
      create: (name, info) => { stub.alarms[name] = info; },
      clear: async (name) => { delete stub.alarms[name]; return true; },
      get: async (name) => (stub.alarms[name] ? { name, ...stub.alarms[name] } : undefined),
      onAlarm,
    },
    proxy: {
      settings: {
        get: async () => ({ levelOfControl: 'controllable_by_this_extension', value: stub.proxy || { mode: 'system' } }),
        set: async ({ value }) => { stub.proxy = clone(value); },
        clear: async () => { stub.proxy = null; },
      },
      onProxyError,
    },
    privacy: {
      network: {
        webRTCIPHandlingPolicy: {
          set: async ({ value }) => { stub.webrtc = value; },
          clear: async () => { stub.webrtc = null; },
        },
      },
    },
    tabs: { query: async () => [{ id: 1, url: stub.tabUrl }] },
    i18n: { getUILanguage: () => uiLang },
    action: {
      setBadgeText: async ({ text }) => { stub.badge.text = text; },
      setBadgeBackgroundColor: async ({ color }) => { stub.badge.color = color; },
      setTitle: async ({ title }) => { stub.badge.title = title; },
      setIcon: async ({ path }) => { stub.badge.icon = path; },
    },
  };
  stub.fireAlarm = (name) => onAlarm.fire({ name });
  stub.fireInstalled = () => onInstalled.fire({ reason: 'install' });
  window.__stub = stub;
  return stub;
}
