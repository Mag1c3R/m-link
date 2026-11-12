# M-Client

Расширение Chrome — клиент для своих подписок и узлов (как Happ, но в браузере) — плюс маленький помощник на Go, который запускает sing-box.

```
┌────────────── Chrome ──────────────┐        ┌──────── компьютер ────────┐
│ popup: подписки, узлы, пинг, режим │        │ m-client-helper (Go)      │
│ background: chrome.proxy + PAC  ───┼─ SOCKS5 ─▶ sing-box 127.0.0.1:10808 ─▶ VLESS / Hy2 / …
│                       Native Messaging ◀────▶ start / stop / test        │
└────────────────────────────────────┘        └───────────────────────────┘
```

Chrome умеет отдавать трафик только в HTTP/SOCKS-прокси, поэтому сами протоколы обслуживает sing-box, а расширение настраивает браузер и показывает интерфейс.

## Установка помощника

Помощник нужен для подключения и замера пинга. VLESS, Reality, VMess, Trojan, Shadowsocks, Hysteria2 и TUIC браузер сам не поддерживает.

1. Скачай архив для своей системы из [последнего релиза](../../releases/latest). Внутри уже есть sing-box.
   - **macOS (Apple Silicon: M1–M4):** `m-client-helper-…-darwin-arm64.zip`
   - **macOS (Intel):** `…-darwin-amd64.zip`
   - **Windows:** `…-windows-amd64.zip`
   - **Linux:** `…-linux-amd64.zip` или `…-linux-arm64.zip`
2. Распакуй архив и запусти установщик:
   - **macOS:** двойной щелчок по `install.command`. Если macOS не даёт открыть файл, щёлкни по нему правой кнопкой → «Открыть».
   - **Windows:** двойной щелчок по `install.bat`.
   - **Linux:** `sh install.sh`.
3. Полностью перезапусти браузер.
4. Проверь: в расширении нажми шестерёнку → блок «Помощник» должен показывать «Работает».

Удаление: `uninstall.sh`, `uninstall.bat`.

## Что умеет

- **Протоколы:** VLESS (TCP, Reality, WS, gRPC, HTTP/2, HTTPUpgrade, Vision), VMess, Trojan, Shadowsocks (вкл. 2022 и obfs/v2ray-plugin), Hysteria2 (obfs salamander, port hopping), Hysteria, TUIC, AnyTLS, SOCKS5.
- **Подписки:** base64, простой список ссылок, JSON sing-box и xray-JSON (его отдают Remnawave/Marzban для Happ). Группы «Авто» из xray-JSON превращаются в группы `urltest` sing-box. Читаются заголовки `subscription-userinfo` (трафик и срок), `profile-title`, `support-url`, `profile-update-interval`. Подписки автоматически обновляются.
- **Ручные узлы:** можно вставить одну или сразу много ссылок.
- **Пинг:** настоящий URL-тест через sing-box (работает и для UDP-протоколов). Если он не получился, используется TCP-пинг.
- **Режимы:** все сайты; все, кроме списка (по умолчанию ru, su, рф, by); только список.
- **Защита от поломок:** если ядро или помощник падают, прокси снимается, чтобы браузер не остался без сети. После перезапуска браузера подключение восстанавливается.
- **Реклама:** карточка M-VPN в пустом состоянии и ссылка в подвале. Всё настраивается в [extension/config.js](extension/config.js).
- **Не поддерживается:** XHTTP/SplitHTTP (есть только в xray), WireGuard и Clash YAML. Такие узлы показываются серыми с пояснением.

## Структура

| Путь | Что это |
|---|---|
| [extension/](extension) | Расширение MV3. Логика: [background.js](extension/background.js), разбор ссылок: [lib/parser.js](extension/lib/parser.js), конфиг sing-box и PAC: [lib/singbox.js](extension/lib/singbox.js) |
| [helper/](helper) | Помощник на Go без внешних зависимостей. Сборка: `sh helper/build.sh` → `helper/dist/<платформа>/` |
| [helper/install/](helper/install) | Установщики: `install.command` и `install.sh` (macOS/Linux), `install.bat` (Windows), а также удаление |
| [tests/](tests) | `parser.test.html` — тесты парсера и PAC; `preview.html` — просмотр popup без Chrome |
| keys/ | Ключ, который даёт расширению постоянный ID `aghdgobidfiogibjlpfhdegieiaiakgm`. **`.pem` никуда не публиковать.** |

## Как попробовать у себя

1. Собери помощник: `sh helper/build.sh`. С `SINGBOX_DIR=<папка с распакованными релизами sing-box>` сборка заодно положит sing-box в архивы для релиза.
2. Положи `sing-box` в `helper/dist/darwin-arm64/` (релизы: github.com/SagerNet/sing-box/releases) или поставь его через `brew install sing-box`. Нужна версия 1.11 или новее.
3. Установи помощник: `sh helper/dist/darwin-arm64/install.sh`.
4. Загрузи расширение: `chrome://extensions` → «Режим разработчика» → «Загрузить распакованное» → папка `extension`. ID должен совпасть с `aghdgobidfiogibjlpfhdegieiaiakgm`.
5. Нажми «+», вставь подписку и подключайся.

Тесты: `python3 tests/serve.py 8768` и открой http://localhost:8768/tests/parser.test.html. Страница `tests/real-sub.html` разбирает настоящую подписку из `tests/out/sub.txt` (папка `tests/out` не коммитится: там секреты).

## Перед публикацией

- В `config.js` поменяй `helperDownloadUrl` и `promo.url` на свои.
- Chrome Web Store выдаст расширению свой ID. Его нужно добавить в `allowed_origins` в установщиках (`EXT_ID`), а поле `key` из manifest.json перед загрузкой в магазин убрать.
- Подпиши помощник: на macOS нужны подпись и нотаризация, на Windows — сертификат Authenticode. Без этого Gatekeeper и SmartScreen будут пугать пользователей.
- Нужна политика конфиденциальности: что хранится (только локально) и что никуда не отправляется. Без неё ревью с правами `proxy` и `nativeMessaging` не пройти.

## Что дальше

- Встроить sing-box в помощник как Go-библиотеку, чтобы получился один бинарник без отдельного скачивания.
- Сделать нормальные установщики (.pkg и .msi/.exe) с автозагрузкой sing-box нужной версии.
- Поддержать Clash YAML.
- Поддержать XHTTP: например, запускать для таких узлов xray-core вместо sing-box (в подписке M-VPN это 114 узлов из 607).
- Добавить диплинк для добавления подписки в один клик со страницы M-VPN (`chrome.runtime.onMessageExternal` + `externally_connectable`).
- Добавить kill switch (не снимать прокси при падении) отдельной галочкой.
