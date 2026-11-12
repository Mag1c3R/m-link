# Тексты для карточки в Chrome Web Store

Версия расширения 1.0. Всё ниже копируется в кабинет разработчика как есть.

## Название и короткое описание

Берутся из `extension/manifest.json`, отдельно вводить не нужно.

## Категория и язык

- Категория: «Защита и безопасность»
- Язык: русский

## Описание

```
M-Link — клиент для твоих VPN-подписок прямо в браузере. Вставь ссылку на подписку или сервер, выбери страну и подключайся одним нажатием. Подходят подписки любых сервисов и панелей: Remnawave, Marzban, 3x-ui и других.

ЧТО УМЕЕТ
• Протоколы: VLESS (Reality, Vision, WebSocket, gRPC, HTTP/2, HTTPUpgrade), VMess, Trojan, Shadowsocks (включая 2022), Hysteria2, Hysteria, TUIC, AnyTLS, SOCKS5.
• Все популярные форматы подписок: ссылки vless://, hy2:// и другие, base64, JSON для sing-box и xray (тот же формат, что получают Happ и v2rayNG).
• Показывает остаток трафика и дату окончания подписки, сам обновляет подписки.
• Группы «Авто» сами выбирают самый быстрый сервер.
• Пинг всех серверов одним нажатием, включая Hysteria2 и TUIC. Быстрые серверы поднимаются наверх.
• Выбор сайтов: все через VPN, все кроме российских (.ru, .рф) или только нужные.
• Если соединение оборвалось, браузер не останется без интернета.
• Светлая и тёмная тема.

КАК ЭТО РАБОТАЕТ
Браузер сам не умеет подключаться по VLESS, Hysteria2 и другим современным протоколам. Поэтому вместе с расширением работает небольшая программа-помощник с открытым исходным кодом. Она запускает на твоём компьютере ядро sing-box, и через него идёт трафик браузера. Другие программы на компьютере работают как обычно.

УСТАНОВКА
1. Установи расширение и открой его: оно покажет, как поставить помощник на твою систему.
2. macOS и Linux: одна команда в Терминале. Windows: скачай архив и запусти install.bat.
3. Нажми «Проверить», затем «+» и вставь ссылку на подписку.
Подробная инструкция: https://github.com/Mag1c3R/m-link

КОНФИДЕНЦИАЛЬНОСТЬ
• Расширению не нужен доступ к сайтам, которые ты открываешь.
• Подписки и настройки хранятся только на твоём компьютере.
• Расширение ничего не отправляет разработчику: ни историю, ни адреса сайтов, ни статистику.
• Исходный код открыт: https://github.com/Mag1c3R/m-link

ОГРАНИЧЕНИЯ
• Работает только для браузера, остальные программы идут напрямую.
• Серверы на транспорте XHTTP пока не поддерживаются.

НЕТ ПОДПИСКИ?
Получи подписку M-VPN в Telegram-боте @mag1c3r_vpn_bot.

Вопросы и ошибки: https://github.com/Mag1c3R/m-link/issues
```

## Дополнительные поля

- URL главной страницы: `https://github.com/Mag1c3R/m-link`
- URL службы поддержки: `https://github.com/Mag1c3R/m-link/issues`
- Только для взрослых: выключено

## Конфиденциальность

**Единственное назначение:**

```
M-Link connects the browser to the user's own proxy servers. The user adds a subscription link or server links (VLESS, VMess, Trojan, Shadowsocks, Hysteria2, TUIC), picks a server, and the extension routes browser traffic through it using a local helper app (open source, runs sing-box). It also lets the user choose which sites go through the proxy and measures server latency.
```

**Обоснование разрешений.** В версии 1.0 разрешений стало меньше: доступ к сайтам и `declarativeNetRequest` больше не нужны, кабинет про них не спросит.

- `proxy`:
  ```
  Required to route browser traffic through the local proxy (127.0.0.1) started by the helper app, using a PAC script that applies the user's per-site rules.
  ```
- `nativeMessaging`:
  ```
  Communicates with the M-Link helper app installed by the user (open source: github.com/Mag1c3R/m-link). The helper starts/stops the sing-box core, measures server latency and downloads the user's subscriptions, because browsers cannot connect via VLESS, Hysteria2 and similar protocols themselves.
  ```
- `storage`:
  ```
  Stores the user's subscriptions, server list, selected server and settings locally on the device.
  ```
- `unlimitedStorage`:
  ```
  Subscriptions can contain hundreds of servers with full connection settings (over 1 MB per subscription), which may exceed the default local storage quota.
  ```
- `alarms`:
  ```
  Periodically refreshes the user's subscriptions (default every 12 hours) and checks once a day whether a newer helper version is available.
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
