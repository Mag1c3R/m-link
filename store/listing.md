# Тексты для карточки в Chrome Web Store

Версия расширения 1.1.0. Всё ниже копируется в кабинет разработчика как есть.

Версия 1.0 была отклонена за «злоупотребление ключевыми словами» (Yellow Argon): магазин считает перечни протоколов и названия чужих программ набором ключевых слов. Поэтому в описаниях протоколы упоминаются только в обычных предложениях, а полный список — на GitHub. Не добавляй их обратно списком.

## Название и короткое описание

Берутся из `extension/manifest.json`, отдельно вводить не нужно.

Название и описание теперь двуязычные (папка `extension/_locales`): русскоязычным пользователям Chrome показывает русский вариант, остальным английский.

## Категория и язык

- Категория: «Защита и безопасность»
- Язык: русский

## Описание

```
M-Link подключает браузер к твоей VPN-подписке. Вставь ссылку, которую дал тебе VPN-сервис, выбери страну и включи VPN одним нажатием.

ЧТО УМЕЕТ
• Работает с подписками большинства VPN-сервисов и с отдельными серверами, включая современные протоколы VLESS с Reality и Hysteria2. Полный список — на странице проекта.
• Показывает, сколько трафика осталось и до какого числа действует подписка, и сам обновляет её.
• Режим «Авто» сам выбирает самый быстрый сервер.
• Проверяет скорость всех серверов одним нажатием и ставит быстрые наверх.
• Показывает текущую скорость загрузки и отдачи.
• Можно выбрать, какие сайты открывать через VPN: все, все кроме российских или только нужные. Для открытого сайта — одним переключателем прямо в окне расширения.
• Защищает от утечки настоящего IP через WebRTC.
• По желанию не пускает сайты мимо VPN, если соединение оборвалось, и само переподключается.
• Напоминает за 3 дня до конца подписки.
• Русский и английский интерфейс, светлая и тёмная тема.

КАК ЭТО РАБОТАЕТ
Браузер сам не умеет подключаться по современным VPN-протоколам. Поэтому вместе с расширением работает небольшая программа-помощник с открытым исходным кодом. Она запускается на твоём компьютере, и через неё идёт трафик браузера. Другие программы на компьютере работают как обычно. Помощник обновляется сам.

УСТАНОВКА
1. Установи расширение и открой его: оно покажет, как поставить помощник на твою систему.
2. На macOS и Linux это одна команда в Терминале, на Windows — архив с файлом install.bat.
3. Нажми «Проверить», затем «+» и вставь ссылку на подписку.
Подробная инструкция: https://github.com/Mag1c3R/m-link

КОНФИДЕНЦИАЛЬНОСТЬ
• Расширению не нужен доступ к содержимому сайтов, которые ты открываешь.
• Подписки и настройки хранятся только на твоём компьютере.
• Расширение ничего не отправляет разработчику: ни историю, ни адреса сайтов, ни статистику.
• Исходный код открыт: https://github.com/Mag1c3R/m-link

ОГРАНИЧЕНИЯ
• VPN работает только в браузере, остальные программы идут напрямую.

НЕТ ПОДПИСКИ?
Получи подписку M-VPN в Telegram-боте @mag1c3r_vpn_bot.

Вопросы и ошибки: https://github.com/Mag1c3R/m-link/issues
```

## Описание на английском

Если в кабинете добавишь английскую версию карточки, вставь туда этот текст.

```
M-Link connects your browser to your VPN subscription. Paste the link your VPN service gave you, pick a country and turn the VPN on with one click.

WHAT IT DOES
• Works with subscriptions from most VPN services and with single servers, including modern protocols such as VLESS with Reality and Hysteria2. The full list is on the project page.
• Shows how much traffic is left and when the subscription ends, and refreshes it automatically.
• "Auto" mode picks the fastest server for you.
• Checks the speed of all servers with one click and moves the fastest to the top.
• Shows the current download and upload speed.
• Choose which sites go through the VPN: all of them, all except local ones, or only selected sites. For the open site, use the switch right in the extension window.
• Protects your real IP from leaking through WebRTC.
• Optionally blocks sites from opening outside the VPN if the connection drops, and reconnects automatically.
• Reminds you 3 days before the subscription ends.
• English and Russian interface, light and dark theme.

HOW IT WORKS
Browsers can't connect over modern VPN protocols on their own, so the extension works with a small open-source helper app. It runs on your computer and carries the browser's traffic. Other apps on your computer are not affected. The helper updates itself.

SETUP
1. Install the extension and open it: it shows how to install the helper on your system.
2. On macOS and Linux it's one Terminal command, on Windows a zip with install.bat.
3. Click "Check", then "+", and paste your subscription link.
Full instructions: https://github.com/Mag1c3R/m-link

PRIVACY
• The extension has no access to the content of the sites you visit.
• Subscriptions and settings are stored only on your computer.
• Nothing is sent to the developer: no history, no site addresses, no statistics.
• The source code is open: https://github.com/Mag1c3R/m-link

LIMITATIONS
• The VPN covers only the browser; other apps connect directly.

Questions and bug reports: https://github.com/Mag1c3R/m-link/issues
```

## Дополнительные поля

- URL главной страницы: `https://github.com/Mag1c3R/m-link`
- URL службы поддержки: `https://github.com/Mag1c3R/m-link/issues`
- Только для взрослых: выключено

## Конфиденциальность

**Единственное назначение:**

```
M-Link connects the browser to the user's own proxy servers. The user adds a subscription link or server links (for example VLESS or Hysteria2), picks a server, and the extension routes browser traffic through it using a local helper app (open source, runs sing-box or xray). It also lets the user choose which sites go through the proxy and measures server latency.
```

**Обоснование разрешений.** В версии 1.1 добавились `privacy` и `activeTab`. Из-за `privacy` Chrome при обновлении попросит у пользователей подтвердить новое право, а до подтверждения отключит расширение.

- `proxy`:
  ```
  Required to route browser traffic through the local proxy (127.0.0.1) started by the helper app, using a PAC script that applies the user's per-site rules.
  ```
- `nativeMessaging`:
  ```
  Communicates with the M-Link helper app installed by the user (open source: github.com/Mag1c3R/m-link). The helper starts/stops the sing-box or xray core, measures server latency, reports connection speed, downloads the user's subscriptions and updates itself from the project's GitHub releases, because browsers cannot connect via VLESS, Hysteria2 and similar protocols themselves.
  ```
- `storage`:
  ```
  Stores the user's subscriptions, server list, selected server and settings locally on the device.
  ```
- `unlimitedStorage`:
  ```
  Subscriptions can contain hundreds of servers with full connection settings (over 1 MB per subscription), which may exceed the default local storage quota.
  ```
- `privacy`:
  ```
  While the VPN is on, sets webRTCIPHandlingPolicy to "disable_non_proxied_udp" so WebRTC can't reveal the user's real IP address outside the proxy. The setting is cleared when the VPN is turned off. This protection can be turned off in the extension settings.
  ```
- `activeTab`:
  ```
  When the user opens the extension popup, reads the address of the current tab to show a switch that sends this site through the VPN or directly. The address is not stored or sent anywhere.
  ```
- `alarms`:
  ```
  Periodically refreshes the user's subscriptions (as often as the subscription provider asks, at most every 12 hours by default), checks once a day whether a newer helper version is available, and retries the connection when the optional kill switch is on.
  ```

**Удалённый код:** «Нет, я не использую удалённый код». Расширение раз в сутки читает с GitHub файл `remote-config.json`, но это данные (номер версии помощника и текст рекламного блока), а не код.

**Сбор данных:** не отмечать ни одного типа данных. Поставить все три галочки-подтверждения.

**Политика конфиденциальности:** `https://github.com/Mag1c3R/m-link/blob/main/PRIVACY.md`

## Инструкции для тестирования

Логин и пароль оставить пустыми. В «Дополнительные инструкции» вставить текст ниже, заменив `ССЫЛКА` на тестовую подписку (отдельный ключ без лимита устройств). Без ссылки в тексте 391 символ, лимит поля — 500.

```
1) Open the extension: it shows how to install the open-source helper app (macOS/Linux: one Terminal command; Windows: zip with install.bat). Source: github.com/Mag1c3R/m-link. Install it and click «Проверить». 2) Press +, paste this test subscription, click «Добавить»: ССЫЛКА 3) Press the round power button. 4) Open https://api.ipify.org - the IP changes. The lightning button measures latency.
```

## Картинки

- Значок магазина: `store/icon-128.png`
- Скриншоты 1280×800: `store/images/screenshot-1.png` … `screenshot-5.png`
- Маленькое рекламное изображение: `store/images/promo-small-440x280.png`
- Очень большое рекламное изображение: `store/images/promo-marquee-1400x560.png`
