// Языки интерфейса: русский (исходные строки) и английский.
// Ключ перевода — сама русская строка, поэтому в коде пишем t('Отключено') и t('Работают {0} из {1}', a, b).
import EN from './i18n-en.js';

let lang = 'ru';

export function getLang() {
  return lang;
}

export function setLang(l) {
  lang = l === 'en' ? 'en' : 'ru';
}

// pref: 'auto' | 'ru' | 'en'. Для «авто» русский выбираем по языку браузера, включая соседние языки,
// для которых русский понятнее английского.
export function detectLang(pref) {
  if (pref === 'ru' || pref === 'en') return pref;
  let ui = 'ru';
  try { ui = (chrome.i18n?.getUILanguage?.() || navigator.language || 'ru').toLowerCase(); } catch { /* по умолчанию ru */ }
  return /^(ru|uk|be|kk|ky|uz|tg|hy|az|ka|tk|mo)/.test(ui) ? 'ru' : 'en';
}

export function t(s, ...args) {
  let out = lang === 'en' ? (EN[s] ?? s) : s;
  args.forEach((a, i) => { out = out.split(`{${i}}`).join(String(a)); });
  return out;
}

// Сообщения помощника приходят на русском: переводим известные шаблоны.
const HELPER_PATTERNS = [
  [/^сервер подписки не найден \(проверь ссылку\)$/, 'Subscription server not found (check the link)'],
  [/^сервер подписки не ответил вовремя$/, 'Subscription server did not respond in time'],
  [/^сервер подписки отклонил соединение$/, 'Subscription server refused the connection'],
  [/^у сервера подписки проблема с сертификатом$/, 'Subscription server has a certificate problem'],
  [/^не удалось скачать подписку: (.*)$/, 'Could not download the subscription: $1'],
  [/^ссылка должна начинаться с http:\/\/ или https:\/\/$/, 'The link must start with http:// or https://'],
  [/^ответ слишком большой$/, 'The response is too large'],
  [/^порт (\d+) уже занят другой программой; поменяй порт в настройках$/, 'Port $1 is used by another program; change the port in settings'],
  [/^(sing-box|xray) не запустился: ([\s\S]*)$/, '$1 failed to start: $2'],
  [/^(sing-box|xray) не открыл локальный порт за 10 секунд$/, '$1 did not open the local port in 10 seconds'],
  [/^не удалось запустить (\S+): (.*)$/, 'Could not start $1: $2'],
  [/^не найдено ядро xray: установи помощник заново, оно входит в комплект$/, 'xray core not found: reinstall the helper, it is included'],
  [/^не найден sing-box: .*$/, 'sing-box not found: reinstall the helper, it is included'],
  [/^сначала отключи VPN: во время обновления ядро должно быть остановлено$/, 'Turn off the VPN first: the core must be stopped during the update'],
  [/^не удалось узнать последнюю версию: (.*)$/, 'Could not check the latest version: $1'],
  [/^контрольная сумма архива не совпала, обновление отменено$/, 'Archive checksum mismatch, update cancelled'],
  [/^GitHub не сообщил контрольную сумму архива, обновление отменено$/, 'GitHub did not provide the archive checksum, update cancelled'],
  [/^не удалось скачать обновление: (.*)$/, 'Could not download the update: $1'],
  [/^в релизе (\S+) нет архива для этой системы \((.*)\)$/, 'Release $1 has no archive for this system ($2)'],
  [/^установщик обновления завершился с ошибкой: (.*)$/, 'The update installer failed: $1'],
];

export function tHelper(msg) {
  if (lang !== 'en' || !msg) return msg;
  for (const [re, en] of HELPER_PATTERNS) {
    if (re.test(msg)) return msg.replace(re, en);
  }
  return msg;
}

// Переводит статичный текст страницы (popup.html): текстовые узлы и подсказки.
export function translateDom(root) {
  if (lang !== 'en') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const raw = n.nodeValue;
    const key = raw.trim();
    if (key && EN[key]) n.nodeValue = raw.replace(key, EN[key]);
  }
  for (const el of root.querySelectorAll('[placeholder],[title],[aria-label]')) {
    for (const attr of ['placeholder', 'title', 'aria-label']) {
      const v = el.getAttribute(attr);
      if (v && EN[v]) el.setAttribute(attr, EN[v]);
    }
  }
}
