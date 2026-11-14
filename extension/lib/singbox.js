// Сборка конфигов ядер (sing-box и xray) и PAC-скрипта для браузера.
// Маршрутизация «какие сайты через прокси» делается в браузере через PAC,
// поэтому конфиг ядра минимальный: локальный вход -> выбранный узел.

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

// Конфиг xray для узлов, которых нет в sing-box (XHTTP и др.). Браузер ходит в него по SOCKS5.
export function buildXrayRunConfig(xrayOutbound, { port }) {
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      { tag: 'in', listen: '127.0.0.1', port, protocol: 'socks', settings: { auth: 'noauth', udp: true } },
    ],
    outbounds: [
      { ...xrayOutbound, tag: 'proxy' },
      { protocol: 'freedom', tag: 'direct' },
    ],
  };
}

// Конфиг для узла любого типа и команда, каким ядром его запускать.
export function buildNodeConfig(node, { port }) {
  if (node.core === 'xray') return { core: 'xray', config: buildXrayRunConfig(node.xray, { port }) };
  return { core: 'sing-box', config: buildRunConfig(node.outbound, { port, members: node.members }) };
}

function toHostname(line) {
  line = line.trim().toLowerCase();
  if (!line || line.startsWith('#')) return '';
  line = line.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/^\*?\./, '');
  try {
    // Для одиночной зоны вроде "рф" добавляем фиктивный поддомен, чтобы получить punycode.
    return line.includes('.')
      ? new URL('http://' + line).hostname
      : new URL('http://x.' + line).hostname.slice(2);
  } catch { return ''; }
}

// Нормализует список доменов: убирает схемы, пути, точки в начале; IDN -> punycode.
export function normalizeDomains(text) {
  const out = [];
  for (const line of String(text || '').split(/[\s,]+/)) {
    const h = toHostname(line);
    if (h) out.push(h);
  }
  return [...new Set(out)];
}

// Правила для отдельных сайтов: { "youtube.com": "proxy", "example.org": "direct" }.
export function normalizeRules(rules) {
  const out = {};
  for (const [d, v] of Object.entries(rules || {})) {
    const h = toHostname(d);
    if (h && (v === 'proxy' || v === 'direct')) out[h] = v;
  }
  return out;
}

function matchDomain(host, d) {
  return host === d || host.endsWith('.' + d);
}

// Тот же выбор маршрута, что и в PAC: нужен popup, чтобы показать, как откроется текущий сайт.
// Возвращает { route: 'proxy' | 'direct', by: 'rule' | 'list' | 'mode' | 'local', match }.
export function routeForHost(host, { mode, domains = [], rules = {} }) {
  host = String(host || '').toLowerCase();
  if (!host.includes('.') || host === 'localhost' || /^(127|10)\./.test(host) || /^192\.168\./.test(host)) {
    return { route: 'direct', by: 'local' };
  }
  let best = null;
  for (const d of Object.keys(rules)) {
    if (matchDomain(host, d) && (!best || d.length > best.length)) best = d;
  }
  if (best) return { route: rules[best], by: 'rule', match: best };
  const inList = domains.find((d) => matchDomain(host, d));
  if (mode === 'only') return inList ? { route: 'proxy', by: 'list', match: inList } : { route: 'direct', by: 'mode' };
  if (mode === 'except') return inList ? { route: 'direct', by: 'list', match: inList } : { route: 'proxy', by: 'mode' };
  return { route: 'proxy', by: 'mode' };
}

// Домен для правила «этот сайт через VPN»: m.youtube.com -> youtube.com, bbc.co.uk -> bbc.co.uk.
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'msk', 'spb']);
export function siteDomain(host) {
  const parts = String(host || '').toLowerCase().replace(/^www\./, '').split('.');
  if (parts.length <= 2 || /^\d+$/.test(parts[parts.length - 1])) return parts.join('.');
  const take = SECOND_LEVEL.has(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-take).join('.');
}

// mode: 'all' | 'except' | 'only'; rules — правила для отдельных сайтов, они важнее режима.
export function buildPac({ port, mode, domains, rules = {} }) {
  const proxy = `SOCKS5 127.0.0.1:${port}; SOCKS 127.0.0.1:${port}`;
  return `
var PROXY = ${JSON.stringify(proxy)};
var LIST = ${JSON.stringify(domains || [])};
var RULES = ${JSON.stringify(rules || {})};
var MODE = ${JSON.stringify(mode)};
function match(host, d) {
  return host === d || dnsDomainIs(host, "." + d);
}
function inList(host) {
  for (var i = 0; i < LIST.length; i++) {
    if (match(host, LIST[i])) return true;
  }
  return false;
}
function ruleFor(host) {
  var best = "";
  for (var d in RULES) {
    if (match(host, d) && d.length > best.length) best = d;
  }
  return best ? RULES[best] : "";
}
function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (isPlainHostName(host) || host === "localhost" || shExpMatch(host, "127.*") ||
      shExpMatch(host, "10.*") || shExpMatch(host, "192.168.*") || host === "[::1]") {
    return "DIRECT";
  }
  var rule = ruleFor(host);
  if (rule === "proxy") return PROXY;
  if (rule === "direct") return "DIRECT";
  if (MODE === "only") return inList(host) ? PROXY : "DIRECT";
  if (MODE === "except") return inList(host) ? "DIRECT" : PROXY;
  return PROXY;
}`;
}

export const DEFAULT_EXCEPT = ['ru', 'su', 'рф', 'by'];
