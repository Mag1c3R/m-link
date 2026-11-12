// Сборка конфигов sing-box и PAC-скрипта для браузера.
// Маршрутизация «какие сайты через прокси» делается в браузере через PAC,
// поэтому конфиг sing-box минимальный: локальный SOCKS/HTTP вход -> выбранный узел.

// members — узлы группы «Авто» (urltest), у обычного узла их нет.
export function buildRunConfig(outbound, { port, members = [] }) {
  return {
    log: { level: 'warn', timestamp: true },
    inbounds: [
      { type: 'mixed', tag: 'in', listen: '127.0.0.1', listen_port: port },
    ],
    outbounds: [
      { ...outbound, tag: 'proxy' },
      ...members,
      { type: 'direct', tag: 'direct' },
    ],
    route: { final: 'proxy' },
  };
}

// Нормализует список доменов: убирает схемы, пути, точки в начале; IDN -> punycode.
export function normalizeDomains(text) {
  const out = [];
  for (let line of String(text || '').split(/[\s,]+/)) {
    line = line.trim().toLowerCase();
    if (!line || line.startsWith('#')) continue;
    line = line.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/^\*?\./, '');
    try {
      // Для одиночной зоны вроде "рф" добавляем фиктивный поддомен, чтобы получить punycode.
      line = line.includes('.')
        ? new URL('http://' + line).hostname
        : new URL('http://x.' + line).hostname.slice(2);
    } catch { continue; }
    if (line) out.push(line);
  }
  return [...new Set(out)];
}

// mode: 'all' | 'except' | 'only'
export function buildPac({ port, mode, domains }) {
  const proxy = `SOCKS5 127.0.0.1:${port}; SOCKS 127.0.0.1:${port}`;
  const list = JSON.stringify(domains || []);
  return `
var PROXY = ${JSON.stringify(proxy)};
var LIST = ${list};
var MODE = ${JSON.stringify(mode)};
function inList(host) {
  for (var i = 0; i < LIST.length; i++) {
    var d = LIST[i];
    if (host === d || dnsDomainIs(host, "." + d)) return true;
  }
  return false;
}
function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (isPlainHostName(host) || host === "localhost" || shExpMatch(host, "127.*") ||
      shExpMatch(host, "10.*") || shExpMatch(host, "192.168.*") || host === "[::1]") {
    return "DIRECT";
  }
  if (MODE === "only") return inList(host) ? PROXY : "DIRECT";
  if (MODE === "except") return inList(host) ? "DIRECT" : PROXY;
  return PROXY;
}`;
}

export const DEFAULT_EXCEPT = ['ru', 'su', 'рф', 'by'];
