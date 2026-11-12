// Разбор ссылок на узлы и подписок в outbound'ы sing-box.
// Поддержка: vless, vmess, trojan, ss, hysteria2/hy2, hysteria, tuic, anytls, socks,
// подписки в виде base64, простого списка ссылок и JSON sing-box.

const SUPPORTED_SINGBOX_TYPES = new Set([
  'vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2', 'hysteria',
  'tuic', 'anytls', 'socks', 'http',
]);

// ---------- утилиты ----------

export function decodeBase64(input) {
  let s = String(input).trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function looksLikeBase64(s) {
  const t = s.trim().replace(/\s+/g, '');
  return t.length >= 8 && /^[A-Za-z0-9+/_-]+=*$/.test(t);
}

function dec(s) {
  if (!s) return '';
  try { return decodeURIComponent(s); } catch { return s; }
}

export function hashString(str) {
  let h1 = 0xdeadbeef ^ str.length, h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

// Свой разбор URI: new URL() для нестандартных схем ведёт себя по-разному в разных версиях Chrome.
export function splitUri(uri) {
  const m = String(uri).trim().match(/^([a-z0-9+.-]+):\/\/(.*)$/is);
  if (!m) throw new Error('Не похоже на ссылку');
  const scheme = m[1].toLowerCase();
  let rest = m[2];
  let name = '';
  const hi = rest.indexOf('#');
  if (hi >= 0) { name = dec(rest.slice(hi + 1)); rest = rest.slice(0, hi); }
  let query = '';
  const qi = rest.indexOf('?');
  if (qi >= 0) { query = rest.slice(qi + 1); rest = rest.slice(0, qi); }
  const at = rest.lastIndexOf('@');
  const userinfo = at >= 0 ? rest.slice(0, at) : '';
  let hostport = at >= 0 ? rest.slice(at + 1) : rest;
  let path = '';
  const pi = hostport.indexOf('/');
  if (pi >= 0) { path = hostport.slice(pi); hostport = hostport.slice(0, pi); }
  let host = hostport, port = '';
  if (hostport.startsWith('[')) {
    const end = hostport.indexOf(']');
    host = hostport.slice(1, end);
    port = hostport.slice(end + 1).replace(/^:/, '');
  } else {
    const ci = hostport.indexOf(':');
    if (ci >= 0) { host = hostport.slice(0, ci); port = hostport.slice(ci + 1); }
  }
  return {
    scheme, userinfo, rawUserinfo: userinfo, host: dec(host), port, path,
    params: new URLSearchParams(query), name, authorityRaw: rest,
  };
}

function toPort(p, fallback) {
  const n = parseInt(String(p), 10);
  if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  if (fallback) return fallback;
  throw new Error('Неверный порт: ' + p);
}

function truthy(v) {
  return v === '1' || v === 'true' || v === 'True' || v === 'yes';
}

function splitList(v) {
  return (v || '').split(',').map((x) => x.trim()).filter(Boolean);
}

class Unsupported extends Error {}

// ---------- TLS и транспорт (формат ссылок xray / v2rayN) ----------

function buildTls(p, { security, defaultSni, forceTls = false }) {
  const sec = (security || '').toLowerCase();
  if (!forceTls && (sec === '' || sec === 'none')) return undefined;
  const tls = { enabled: true };
  const sni = p.get('sni') || p.get('peer') || p.get('serverName') || defaultSni;
  if (sni) tls.server_name = sni;
  if (truthy(p.get('allowInsecure')) || truthy(p.get('insecure')) || truthy(p.get('allow_insecure'))) {
    tls.insecure = true;
  }
  const alpn = splitList(p.get('alpn'));
  if (alpn.length) tls.alpn = alpn;
  const fp = p.get('fp');
  if (fp && fp !== 'none') tls.utls = { enabled: true, fingerprint: fp === 'random' ? 'randomized' : fp };
  if (sec === 'reality') {
    const pbk = p.get('pbk');
    if (!pbk) throw new Error('Reality без pbk');
    tls.reality = { enabled: true, public_key: pbk, short_id: p.get('sid') || '' };
    if (!tls.utls) tls.utls = { enabled: true, fingerprint: 'chrome' };
    delete tls.insecure;
  }
  return tls;
}

function buildTransport(p, { type, host, path, serviceName }) {
  const t = (type || 'tcp').toLowerCase();
  switch (t) {
    case 'tcp':
    case 'raw':
    case '':
      if ((p.get('headerType') || '').toLowerCase() === 'http') {
        throw new Unsupported('TCP с HTTP-обфускацией не поддерживается sing-box');
      }
      return undefined;
    case 'ws': {
      const tr = { type: 'ws' };
      let wsPath = path || '/';
      const ed = wsPath.match(/[?&]ed=(\d+)/);
      if (ed) {
        tr.max_early_data = parseInt(ed[1], 10);
        tr.early_data_header_name = 'Sec-WebSocket-Protocol';
        wsPath = wsPath.replace(/[?&]ed=\d+/, '').replace(/\?$/, '');
      }
      tr.path = wsPath;
      if (host) tr.headers = { Host: host };
      return tr;
    }
    case 'grpc':
      return { type: 'grpc', service_name: serviceName || '' };
    case 'http':
    case 'h2': {
      const tr = { type: 'http' };
      const hosts = splitList(host);
      if (hosts.length) tr.host = hosts;
      if (path) tr.path = path;
      return tr;
    }
    case 'httpupgrade': {
      const tr = { type: 'httpupgrade', path: path || '/' };
      if (host) tr.host = host;
      return tr;
    }
    case 'xhttp':
    case 'splithttp':
      throw new Unsupported('Транспорт XHTTP есть только в xray, sing-box его не умеет');
    default:
      throw new Unsupported('Транспорт ' + t + ' не поддерживается');
  }
}

function commonStreamFromParams(p, server) {
  const type = p.get('type') || p.get('net') || 'tcp';
  const transport = buildTransport(p, {
    type,
    host: p.get('host') || '',
    path: dec(p.get('path') || ''),
    serviceName: dec(p.get('serviceName') || p.get('service_name') || ''),
  });
  return { transport, type };
}

// ---------- протоколы ----------

function parseVless(u) {
  const p = u.params;
  const ob = {
    type: 'vless',
    server: u.host,
    server_port: toPort(u.port, 443),
    uuid: dec(u.userinfo),
  };
  const flow = p.get('flow');
  if (flow) ob.flow = flow.startsWith('xtls-rprx-vision') ? 'xtls-rprx-vision' : flow;
  const tls = buildTls(p, { security: p.get('security'), defaultSni: u.host });
  if (tls) ob.tls = tls;
  const { transport } = commonStreamFromParams(p, u.host);
  if (transport) ob.transport = transport;
  ob.packet_encoding = 'xudp';
  return ob;
}

function parseVmess(uri) {
  const body = uri.slice('vmess://'.length).split('#')[0];
  if (!looksLikeBase64(body)) {
    // Новый формат vmess://uuid@host:port?... как у vless
    const u = splitUri(uri);
    const ob = parseVless(u);
    ob.type = 'vmess';
    delete ob.flow;
    ob.security = u.params.get('encryption') || 'auto';
    ob.alter_id = 0;
    return { ob, name: u.name, host: u.host, port: ob.server_port };
  }
  const j = JSON.parse(decodeBase64(body));
  const p = new URLSearchParams();
  if (j.sni) p.set('sni', j.sni);
  if (j.alpn) p.set('alpn', j.alpn);
  if (j.fp) p.set('fp', j.fp);
  if (j.allowInsecure || j.insecure) p.set('allowInsecure', '1');
  if (j.type === 'http' && (j.net || 'tcp') === 'tcp') p.set('headerType', 'http');
  const server = String(j.add || '').trim();
  const ob = {
    type: 'vmess',
    server,
    server_port: toPort(j.port, 443),
    uuid: j.id,
    security: j.scy || 'auto',
    alter_id: parseInt(j.aid || 0, 10) || 0,
  };
  const sec = j.tls === true ? 'tls' : String(j.tls || '').toLowerCase();
  const tls = buildTls(p, { security: sec, defaultSni: j.host || server });
  if (tls) ob.tls = tls;
  const transport = buildTransport(p, {
    type: j.net || 'tcp',
    host: j.host || '',
    path: j.path || '',
    serviceName: j.path || j.serviceName || '',
  });
  if (transport) ob.transport = transport;
  ob.packet_encoding = 'xudp';
  return { ob, name: j.ps || '', host: server, port: ob.server_port };
}

function parseTrojan(u) {
  const p = u.params;
  const ob = {
    type: 'trojan',
    server: u.host,
    server_port: toPort(u.port, 443),
    password: dec(u.userinfo),
  };
  const sec = p.get('security') || 'tls';
  const tls = buildTls(p, { security: sec, defaultSni: u.host });
  if (tls) ob.tls = tls;
  const { transport } = commonStreamFromParams(p, u.host);
  if (transport) ob.transport = transport;
  return ob;
}

function parseShadowsocks(uri) {
  let u = splitUri(uri);
  let method, password;
  if (!u.rawUserinfo) {
    // Старый формат: ss://base64(method:password@host:port)#name
    const decoded = decodeBase64(u.authorityRaw.replace(/\/$/, ''));
    const tail = uri.includes('#') ? '#' + uri.split('#').slice(1).join('#') : '';
    u = splitUri('ss://' + decoded + tail);
  }
  const info = dec(u.rawUserinfo);
  if (info.includes(':')) {
    const i = info.indexOf(':');
    method = info.slice(0, i);
    password = info.slice(i + 1);
  } else {
    const d = decodeBase64(info);
    const i = d.indexOf(':');
    if (i < 0) throw new Error('Не удалось разобрать ss userinfo');
    method = d.slice(0, i);
    password = d.slice(i + 1);
  }
  const ob = {
    type: 'shadowsocks',
    server: u.host,
    server_port: toPort(u.port),
    method,
    password,
  };
  const plugin = u.params.get('plugin');
  if (plugin) {
    const parts = plugin.split(';');
    let name = parts.shift();
    if (name === 'simple-obfs') name = 'obfs-local';
    if (name !== 'obfs-local' && name !== 'v2ray-plugin') {
      throw new Unsupported('Плагин ' + name + ' не поддерживается');
    }
    ob.plugin = name;
    ob.plugin_opts = parts.join(';');
  }
  return { ob, name: u.name, host: u.host, port: ob.server_port };
}

function parsePortSpec(spec) {
  // "443", "443,20000-30000", "20000-30000"
  const parts = String(spec).split(',').map((s) => s.trim()).filter(Boolean);
  let first = null;
  const ranges = [];
  for (const part of parts) {
    const [a, b] = part.split('-').map((x) => parseInt(x, 10));
    if (!Number.isFinite(a)) continue;
    if (first === null) first = a;
    ranges.push(`${a}:${Number.isFinite(b) ? b : a}`);
  }
  return { first, ranges, multi: parts.length > 1 || String(spec).includes('-') };
}

function parseHysteria2(u) {
  const p = u.params;
  const ports = parsePortSpec(u.port || '443');
  const ob = {
    type: 'hysteria2',
    server: u.host,
    server_port: toPort(ports.first, 443),
    password: dec(u.userinfo),
  };
  const mport = p.get('mport');
  if (ports.multi || mport) {
    const extra = mport ? parsePortSpec(mport).ranges : [];
    ob.server_ports = [...new Set([...(ports.multi ? ports.ranges : []), ...extra])];
  }
  const tls = buildTls(p, { security: 'tls', defaultSni: u.host, forceTls: true });
  delete tls.utls;
  if (!tls.alpn) tls.alpn = ['h3'];
  ob.tls = tls;
  const obfs = p.get('obfs');
  if (obfs && obfs !== 'none') {
    ob.obfs = { type: obfs, password: p.get('obfs-password') || p.get('obfs_password') || '' };
  }
  const up = parseInt(p.get('upmbps') || p.get('up') || '', 10);
  const down = parseInt(p.get('downmbps') || p.get('down') || '', 10);
  if (up) ob.up_mbps = up;
  if (down) ob.down_mbps = down;
  return ob;
}

function parseHysteria1(u) {
  const p = u.params;
  const ob = {
    type: 'hysteria',
    server: u.host,
    server_port: toPort(u.port, 443),
    up_mbps: parseInt(p.get('upmbps') || '50', 10),
    down_mbps: parseInt(p.get('downmbps') || '100', 10),
  };
  const auth = p.get('auth') || dec(u.userinfo);
  if (auth) ob.auth_str = auth;
  if (p.get('obfsParam') || p.get('obfs')) ob.obfs = p.get('obfsParam') || p.get('obfs');
  const tls = buildTls(p, { security: 'tls', defaultSni: u.host, forceTls: true });
  delete tls.utls;
  if (!tls.alpn) tls.alpn = ['hysteria'];
  ob.tls = tls;
  return ob;
}

function parseTuic(u) {
  const p = u.params;
  const info = dec(u.userinfo);
  const i = info.indexOf(':');
  const ob = {
    type: 'tuic',
    server: u.host,
    server_port: toPort(u.port, 443),
    uuid: i >= 0 ? info.slice(0, i) : info,
    password: i >= 0 ? info.slice(i + 1) : (p.get('password') || ''),
    congestion_control: p.get('congestion_control') || p.get('congestion-control') || 'bbr',
    udp_relay_mode: p.get('udp_relay_mode') || p.get('udp-relay-mode') || 'native',
  };
  const tls = buildTls(p, { security: 'tls', defaultSni: u.host, forceTls: true });
  delete tls.utls;
  if (!tls.alpn) tls.alpn = ['h3'];
  if (truthy(p.get('disable_sni'))) tls.disable_sni = true;
  ob.tls = tls;
  return ob;
}

function parseAnyTls(u) {
  const p = u.params;
  const ob = {
    type: 'anytls',
    server: u.host,
    server_port: toPort(u.port, 443),
    password: dec(u.userinfo),
  };
  ob.tls = buildTls(p, { security: 'tls', defaultSni: u.host, forceTls: true });
  return ob;
}

function parseSocks(u) {
  const ob = { type: 'socks', server: u.host, server_port: toPort(u.port, 1080), version: '5' };
  if (u.userinfo) {
    let info = dec(u.userinfo);
    if (!info.includes(':') && looksLikeBase64(info)) info = decodeBase64(info);
    const i = info.indexOf(':');
    ob.username = i >= 0 ? info.slice(0, i) : info;
    if (i >= 0) ob.password = info.slice(i + 1);
  }
  return ob;
}

const PROTO_LABEL = {
  vless: 'VLESS', vmess: 'VMess', trojan: 'Trojan', shadowsocks: 'SS',
  hysteria2: 'Hy2', hysteria: 'Hy', tuic: 'TUIC', anytls: 'AnyTLS', socks: 'SOCKS', http: 'HTTP',
};

export function protoLabel(ob) {
  let label = PROTO_LABEL[ob.type] || ob.type;
  if (ob.tls?.reality?.enabled) label += ' Reality';
  else if (ob.transport?.type) label += ' ' + ob.transport.type.toUpperCase();
  return label;
}

function makeNode(raw, ob, name, host, port) {
  return {
    id: hashString(raw),
    name: (name || '').trim() || `${host}:${port}`,
    type: ob.type,
    label: protoLabel(ob),
    server: host,
    port,
    outbound: ob,
  };
}

function makeUnsupported(raw, scheme, name, reason) {
  return {
    id: hashString(raw),
    name: (name || '').trim() || scheme + ' узел',
    type: scheme,
    label: scheme.toUpperCase(),
    unsupported: reason,
  };
}

// Разбирает одну ссылку. Возвращает узел или узел с полем unsupported.
export function parseLink(raw) {
  const link = raw.trim();
  const scheme = (link.match(/^([a-z0-9+.-]+):\/\//i) || [])[1]?.toLowerCase();
  if (!scheme) throw new Error('Не похоже на ссылку');
  let name = '';
  try {
    if (scheme === 'vmess') {
      const r = parseVmess(link);
      return makeNode(link, r.ob, r.name, r.host, r.port);
    }
    if (scheme === 'ss') {
      const r = parseShadowsocks(link);
      return makeNode(link, r.ob, r.name, r.host, r.port);
    }
    const u = splitUri(link);
    name = u.name;
    let ob;
    switch (scheme) {
      case 'vless': ob = parseVless(u); break;
      case 'trojan': ob = parseTrojan(u); break;
      case 'hysteria2':
      case 'hy2': ob = parseHysteria2(u); break;
      case 'hysteria': ob = parseHysteria1(u); break;
      case 'tuic': ob = parseTuic(u); break;
      case 'anytls': ob = parseAnyTls(u); break;
      case 'socks':
      case 'socks5': ob = parseSocks(u); break;
      default:
        return makeUnsupported(link, scheme, name, 'Протокол ' + scheme + ' пока не поддерживается');
    }
    return makeNode(link, ob, u.name, ob.server, ob.server_port);
  } catch (e) {
    if (e instanceof Unsupported) return makeUnsupported(link, scheme, name, e.message);
    throw e;
  }
}

const LINK_RE = /^(vless|vmess|trojan|ss|hysteria2|hy2|hysteria|tuic|anytls|socks5?|wireguard|wg|ssr):\/\//i;

export function isProxyLink(s) {
  return LINK_RE.test(s.trim());
}

function fromSingboxJson(obj) {
  const list = Array.isArray(obj) ? obj : obj.outbounds;
  if (!Array.isArray(list)) return null;
  const nodes = [];
  for (const o of list) {
    if (!o || !SUPPORTED_SINGBOX_TYPES.has(o.type) || !o.server) continue;
    const ob = { ...o };
    const name = ob.tag;
    delete ob.tag;
    delete ob.detour;
    delete ob.domain_strategy;
    nodes.push(makeNode(JSON.stringify(ob), ob, name, ob.server, ob.server_port));
  }
  return nodes;
}

// ---------- xray JSON (Remnawave / Marzban отдают так подписку для Happ, v2rayNG и др.) ----------

const XRAY_SKIP = new Set(['freedom', 'blackhole', 'dns', 'loopback']);

function xrayServer(settings) {
  // Старый формат: vnext/servers[0]; новый (xray 25+): поля прямо в settings.
  const s = settings?.vnext?.[0] || settings?.servers?.[0] || settings || {};
  return { address: s.address, port: s.port, user: s.users?.[0] || s, raw: s };
}

// Переводит streamSettings xray в параметры ссылки, чтобы переиспользовать buildTls/buildTransport.
function xrayStreamParams(ss = {}) {
  const p = new URLSearchParams();
  const security = ss.security || 'none';
  const tls = security === 'reality' ? ss.realitySettings || {} : ss.tlsSettings || {};
  p.set('security', security);
  if (tls.serverName) p.set('sni', tls.serverName);
  if (tls.fingerprint) p.set('fp', tls.fingerprint);
  if (tls.alpn?.length) p.set('alpn', [].concat(tls.alpn).join(','));
  if (tls.allowInsecure) p.set('allowInsecure', '1');
  if (security === 'reality') {
    if (tls.publicKey) p.set('pbk', tls.publicKey);
    if (tls.shortId) p.set('sid', tls.shortId);
  }
  const net = ss.network || 'tcp';
  const tcpHeader = (ss.tcpSettings || ss.rawSettings)?.header?.type;
  if (tcpHeader) p.set('headerType', tcpHeader);
  const o = ss[net + 'Settings'] || {};
  const host = o.host || o.headers?.Host || o.headers?.host || '';
  return {
    p, security, net,
    host: Array.isArray(host) ? host.join(',') : host,
    path: o.path || '',
    serviceName: o.serviceName || '',
  };
}

function xrayOutboundToSingbox(o) {
  const proto = o.protocol;
  const srv = xrayServer(o.settings);
  if (!srv.address || !srv.port) throw new Error('нет адреса сервера');
  const st = xrayStreamParams(o.streamSettings);

  if (proto === 'hysteria' || proto === 'hysteria2') {
    const hs = o.streamSettings?.hysteriaSettings || {};
    const ver = o.settings?.version || hs.version || (proto === 'hysteria2' ? 2 : 1);
    if (ver !== 2) throw new Unsupported('Hysteria v1 в формате xray не поддерживается');
    const ob = {
      type: 'hysteria2', server: srv.address, server_port: toPort(srv.port, 443),
      password: hs.auth || o.settings?.password || '',
    };
    const tls = buildTls(st.p, { security: 'tls', defaultSni: srv.address, forceTls: true });
    delete tls.utls;
    if (!tls.alpn) tls.alpn = ['h3'];
    ob.tls = tls;
    const hop = hs.udphop?.port || hs.udpHop?.port;
    if (hop) ob.server_ports = parsePortSpec(hop).ranges;
    const obfs = hs.obfs || o.settings?.obfs;
    if (obfs?.type && obfs.type !== 'none') ob.obfs = { type: obfs.type, password: obfs.password || '' };
    return ob;
  }

  const base = { server: srv.address, server_port: toPort(srv.port) };
  let ob;
  if (proto === 'vless') {
    ob = { type: 'vless', ...base, uuid: srv.user.id };
    const flow = srv.user.flow;
    if (flow) ob.flow = flow.startsWith('xtls-rprx-vision') ? 'xtls-rprx-vision' : flow;
    ob.packet_encoding = 'xudp';
  } else if (proto === 'vmess') {
    ob = { type: 'vmess', ...base, uuid: srv.user.id, security: srv.user.security || 'auto', alter_id: srv.user.alterId || 0, packet_encoding: 'xudp' };
  } else if (proto === 'trojan') {
    ob = { type: 'trojan', ...base, password: srv.raw.password };
  } else if (proto === 'shadowsocks') {
    ob = { type: 'shadowsocks', ...base, method: srv.raw.method, password: srv.raw.password };
  } else if (proto === 'socks' || proto === 'http') {
    ob = { type: proto, ...base };
    if (proto === 'socks') ob.version = '5';
    const u = srv.raw.users?.[0];
    if (u?.user) { ob.username = u.user; ob.password = u.pass || ''; }
  } else {
    throw new Unsupported('Протокол ' + proto + ' не поддерживается');
  }

  if (proto !== 'shadowsocks') {
    const tls = buildTls(st.p, { security: st.security, defaultSni: srv.address });
    if (tls) ob.tls = tls;
    const tr = buildTransport(st.p, { type: st.net, host: st.host, path: st.path, serviceName: st.serviceName });
    if (tr) ob.transport = tr;
  }
  return ob;
}

function fromXrayJson(list) {
  const configs = Array.isArray(list) ? list : [list];
  // У xray в outbounds поле "protocol", у sing-box — "type"; так их и различаем.
  const isXray = (c) => c && Array.isArray(c.outbounds) && c.outbounds.some((o) => o && typeof o.protocol === 'string');
  if (!configs.length || !configs.every(isXray)) return null;
  const nodes = [];
  const errors = [];
  for (const cfg of configs) {
    const name = cfg.remarks || '';
    const proxies = cfg.outbounds.filter((o) => o && !XRAY_SKIP.has(o.protocol));
    if (!proxies.length) continue;
    const raw = JSON.stringify(proxies) + name;

    if (proxies.length === 1) {
      try {
        const ob = xrayOutboundToSingbox(proxies[0]);
        nodes.push(makeNode(raw, ob, name, ob.server, ob.server_port));
      } catch (e) {
        if (e instanceof Unsupported) nodes.push(makeUnsupported(raw, proxies[0].protocol, name, e.message));
        else nodes.push(makeUnsupported(raw, proxies[0].protocol, name, 'Не удалось разобрать: ' + e.message));
      }
      continue;
    }

    // Несколько узлов в одном конфиге (балансировщик «Авто») -> группа urltest в sing-box.
    const members = [];
    for (const o of proxies) {
      try { members.push({ ...xrayOutboundToSingbox(o), tag: 'm' + members.length }); } catch { /* пропускаем неподдерживаемые */ }
    }
    if (!members.length) {
      nodes.push(makeUnsupported(raw, 'group', name, 'В группе нет узлов, которые умеет sing-box'));
      continue;
    }
    const obs = cfg.burstObservatory?.pingConfig || cfg.observatory || {};
    nodes.push({
      id: hashString(raw),
      name: name || 'Авто',
      type: 'urltest',
      label: `Авто · ${members.length}`,
      server: members[0].server,
      port: members[0].server_port,
      outbound: {
        type: 'urltest',
        outbounds: members.map((m) => m.tag),
        url: obs.destination || 'https://www.gstatic.com/generate_204',
        interval: '3m',
        tolerance: 50,
      },
      members,
    });
  }
  return { nodes, errors };
}

// Разбирает тело подписки: base64, список ссылок, JSON sing-box или xray JSON.
export function parseSubscription(text) {
  const body = String(text || '').trim();
  if (!body) return { nodes: [], errors: [] };

  if (body.startsWith('{') || body.startsWith('[')) {
    let json = null;
    try { json = JSON.parse(body); } catch { /* не JSON */ }
    if (json) {
      const xray = fromXrayJson(json);
      if (xray) return xray;
      const nodes = fromSingboxJson(json);
      if (nodes) return { nodes, errors: [] };
    }
  }

  let content = body;
  if (!/:\/\//.test(body) && looksLikeBase64(body)) {
    try { content = decodeBase64(body); } catch { /* оставим как есть */ }
  }
  if (/^\s*(proxies|proxy-groups|mixed-port|port):/m.test(content)) {
    return { nodes: [], errors: ['Формат Clash YAML пока не поддерживается. Попробуй ссылку подписки для v2rayN / sing-box.'] };
  }

  const nodes = [];
  const errors = [];
  const seen = new Set();
  for (const line of content.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || !isProxyLink(l)) continue;
    try {
      const n = parseLink(l);
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      nodes.push(n);
    } catch (e) {
      errors.push(`${l.slice(0, 40)}…: ${e.message}`);
    }
  }
  return { nodes, errors };
}

// Заголовок subscription-userinfo: upload=1; download=2; total=3; expire=1700000000
export function parseUserInfo(header) {
  if (!header) return null;
  const out = {};
  for (const part of header.split(';')) {
    const [k, v] = part.split('=').map((s) => s && s.trim());
    if (k && v && /^\d+$/.test(v)) out[k.toLowerCase()] = Number(v);
  }
  return Object.keys(out).length ? out : null;
}

// Заголовок profile-title может быть обычным текстом или "base64:...".
export function parseProfileTitle(header) {
  if (!header) return '';
  const h = header.trim();
  if (h.toLowerCase().startsWith('base64:')) {
    try { return decodeBase64(h.slice(7)); } catch { return ''; }
  }
  return dec(h);
}
