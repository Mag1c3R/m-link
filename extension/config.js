// Всё, что относится к бренду, ссылкам и рекламе, собрано здесь.
const REPO = 'Mag1c3R/m-link';

export const BRAND = {
  name: 'M-Link',
  helperName: 'com.mlink.helper',
  // Минимальная версия помощника, с которой работает это расширение (нужна команда скачивания подписок).
  minHelper: '1.0.0',

  repoUrl: `https://github.com/${REPO}`,
  releasesUrl: `https://github.com/${REPO}/releases/latest`,
  // Прямые ссылки на архивы последнего релиза: <downloadBase>/m-link-helper-<платформа>.<zip|tar.gz>
  downloadBase: `https://github.com/${REPO}/releases/latest/download`,
  // Установка помощника одной командой на macOS и Linux.
  installCommand: `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | sh`,
  // Данные, которые можно менять без выпуска новой версии: актуальная версия помощника и рекламный блок.
  remoteConfigUrl: `https://raw.githubusercontent.com/${REPO}/main/remote-config.json`,

  // Рекламный блок по умолчанию; remote-config.json может его заменить или выключить.
  promo: {
    enabled: true,
    title: 'Нет своей подписки?',
    text: 'M-VPN: подписка через Telegram-бота. Получи ссылку и вставь её сюда кнопкой «+».',
    button: 'Открыть бота M-VPN',
    // ?start=mclient: бот получит /start mclient и сможет посчитать, сколько людей пришло из расширения.
    url: 'https://t.me/mag1c3r_vpn_bot?start=mclient',
  },
};

// Сравнение версий вида 1.2.3: отрицательное число, если a < b.
export function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Проверяет рекламный блок из удалённого конфига: только текст и https-ссылка.
export function sanitizePromo(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.enabled === false) return { enabled: false };
  const str = (v, max) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);
  const title = str(p.title, 80), text = str(p.text, 240), button = str(p.button, 40), url = str(p.url, 300);
  if (!title || !text || !button || !url || !/^https:\/\//i.test(url)) return null;
  return { enabled: true, title, text, button, url };
}
