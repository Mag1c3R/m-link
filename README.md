# M-Link

Расширение Chrome — клиент для своих VPN-подписок и узлов (как Happ, но в браузере) — плюс маленький помощник на Go, который запускает sing-box.

```
┌────────────── Chrome ──────────────┐        ┌──────── компьютер ────────┐
│ popup: подписки, узлы, пинг, режим │        │ m-link-helper (Go)        │
│ background: chrome.proxy + PAC  ───┼─ SOCKS5 ─▶ sing-box 127.0.0.1:10808 ─▶ VLESS / Hy2 / …
│                       Native Messaging ◀────▶ start / stop / test / fetch / stats / update │
└────────────────────────────────────┘        └───────────────────────────┘
```

Chrome умеет отдавать трафик только в HTTP/SOCKS-прокси, поэтому сами протоколы обслуживает sing-box (а серверы на XHTTP — xray-core), а расширение настраивает браузер и показывает интерфейс.

## Установка помощника

Помощник нужен для подключения, замера пинга и скачивания подписок. VLESS, Reality, VMess, Trojan, Shadowsocks, Hysteria2 и TUIC браузер сам не поддерживает. Ядра sing-box и xray-core уже входят в комплект. Начиная с версии 1.1 помощник обновляется сам.

**macOS и Linux.** Открой «Терминал», вставь команду и нажми Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/Mag1c3R/m-link/main/install.sh | sh
```

**Windows.** Скачай [m-link-helper-windows-amd64.zip](../../releases/latest/download/m-link-helper-windows-amd64.zip), распакуй архив целиком и запусти `install.bat`.

После установки открой расширение: карточка «Установи помощник» исчезнет после нажатия «Проверить». Если этого не произошло, перезапусти браузер.

<details>
<summary>Установка из архива вручную (macOS, Linux)</summary>

Архивы лежат в [последнем релизе](../../releases/latest):

- **macOS (Apple Silicon: M1–M4):** `m-link-helper-darwin-arm64.tar.gz`
- **macOS (Intel):** `m-link-helper-darwin-amd64.tar.gz`
- **Linux:** `m-link-helper-linux-amd64.tar.gz` или `m-link-helper-linux-arm64.tar.gz`

Распакуй архив и запусти `install.command` (macOS, двойным щелчком) или `sh install.sh` (Linux). macOS может не дать открыть файл, скачанный браузером: тогда разреши запуск в «Системных настройках» → «Конфиденциальность и безопасность» или воспользуйся командой выше.
</details>

Удаление: `uninstall.sh` или `uninstall.bat` из архива. Помощник не подписан сертификатом разработчика, поэтому Windows может показать предупреждение при запуске.

## Что умеет

- **Протоколы:** VLESS (TCP, Reality, WS, gRPC, HTTP/2, HTTPUpgrade, Vision), VMess, Trojan, Shadowsocks (вкл. 2022 и obfs/v2ray-plugin), Hysteria2 (obfs salamander, port hopping), Hysteria, TUIC, AnyTLS, SOCKS5.
- **Подписки:** base64, простой список ссылок, JSON sing-box и xray-JSON (его отдают Remnawave/Marzban для Happ). Группы «Авто» из xray-JSON превращаются в группы `urltest` sing-box. Читаются заголовки `subscription-userinfo` (трафик и срок), `profile-title`, `support-url`, `profile-update-interval`. Подписки автоматически обновляются.
- **Ручные узлы:** можно вставить одну или сразу много ссылок.
- **Пинг:** настоящий URL-тест через sing-box (работает и для UDP-протоколов). Если он не получился, используется TCP-пинг. После замера быстрые узлы поднимаются наверх.
- **Режимы:** все сайты; все, кроме списка (по умолчанию ru, su, рф, by); только список.
- **Защита от поломок:** если ядро или помощник падают, прокси снимается, чтобы браузер не остался без сети. После перезапуска браузера подключение восстанавливается.
- **Минимум разрешений:** расширению не нужен доступ к сайтам. Подписки скачивает помощник.
- **Реклама:** карточка M-VPN в пустом состоянии и ссылка в подвале. Текст по умолчанию — в [extension/config.js](extension/config.js), а [remote-config.json](remote-config.json) позволяет менять его без выпуска новой версии.
- **XHTTP и mKCP:** такие серверы запускаются через xray-core, остальные — через sing-box.
- **Защита:** WebRTC не может показать настоящий IP в обход прокси (разрешение `privacy`). Kill switch по желанию: при обрыве сайты не открываются мимо VPN, расширение само переподключается.
- **Текущий сайт:** переключатель «VPN / Напрямую» прямо в popup. Правило для сайта важнее режима.
- **Скорость** загрузки и отдачи под кнопкой подключения (для серверов sing-box).
- **Напоминание** за 3 дня до конца подписки и при остатке трафика меньше 10% с кнопкой «Продлить».
- **Самообновление помощника:** расширение раз в сутки сверяет версию с [remote-config.json](remote-config.json). Помощник 1.1+ сам скачивает новую версию из релизов этого репозитория и проверяет её контрольную сумму, которую публикует GitHub.
- **Языки:** русский и английский, выбор в настройках.
- **Не поддерживается:** WireGuard и Clash YAML. Такие узлы по умолчанию скрыты, их можно показать в настройках.

## Структура

| Путь | Что это |
|---|---|
| [extension/](extension) | Расширение MV3. Логика: [background.js](extension/background.js), разбор ссылок: [lib/parser.js](extension/lib/parser.js), конфиг sing-box и PAC: [lib/singbox.js](extension/lib/singbox.js), бренд и ссылки: [config.js](extension/config.js) |
| [helper/](helper) | Помощник на Go без внешних зависимостей. Сборка: `sh helper/build.sh` → `helper/dist/` |
| [helper/install/](helper/install) | Установщики из архива и список ID расширений [extension-ids.txt](helper/install/extension-ids.txt) |
| [install.sh](install.sh) | Установка помощника одной командой: скачивает архив последнего релиза и запускает установщик |
| [remote-config.json](remote-config.json) | Данные, которые расширение раз в сутки читает с GitHub: актуальная версия помощника и рекламный блок |
| [tests/](tests) | `parser.test.html` — тесты парсера и PAC; `preview.html` — просмотр popup без Chrome; `e2e.html` — сквозной стенд с настоящим помощником |
| [store/](store) | Значок, скриншоты и тексты для Chrome Web Store |
| keys/ | Ключ, который даёт версии для разработки постоянный ID `aghdgobidfiogibjlpfhdegieiaiakgm`. **`.pem` никуда не публиковать.** |

## Разработка

1. Собери помощник: `sh helper/build.sh`. С `SINGBOX_DIR=<распакованные релизы sing-box>` и `XRAY_DIR=<распакованные релизы xray-core в папках xray-<платформа>, плюс файл VERSION>` сборка положит оба ядра в архивы для релиза. Нужен sing-box 1.11 или новее.
2. Установи его: `sh helper/dist/m-link-helper-darwin-arm64/install.sh` (подставь свою платформу).
3. Загрузи расширение: `chrome://extensions` → «Режим разработчика» → «Загрузить распакованное» → папка `extension`. ID должен совпасть с `aghdgobidfiogibjlpfhdegieiaiakgm`.

Тесты: запусти `python3 tests/serve.py 8768` и открой:

- http://localhost:8768/tests/parser.test.html — парсер ссылок, подписок и PAC;
- http://localhost:8768/tests/e2e.html — настоящие `background.js` и popup в обычной странице. Вместо Chrome их с собранным помощником и sing-box связывает тестовый сервер. Чтобы помощник не писал в настоящую домашнюю папку, запускай сервер с `MLINK_TEST_HOME=<пустая папка>`.

Папка `tests/out` не коммитится: в неё кладутся настоящие подписки для локальных проверок.

## Выпуск новой версии

**Расширение.** Подними `version` в [extension/manifest.json](extension/manifest.json), выполни `sh build-store.sh` и загрузи `dist/m-link-<версия>-store.zip` в кабинет разработчика Chrome Web Store. Скрипт убирает из манифеста поле `key`: магазин его не принимает.

**Помощник.** Подними `version` в [helper/main.go](helper/main.go), собери архивы и выложи их в новый релиз на GitHub. Затем обнови `helper.latest` в [remote-config.json](remote-config.json): помощники 1.1+ обновятся сами, когда VPN выключен, старым расширение покажет инструкцию. Самообновление берёт архив из последнего релиза и проверяет его по контрольной сумме из API GitHub, поэтому архивы в релизе всегда должны называться `m-link-helper-<ос>-<архитектура>`. Если расширению нужна новая команда помощника, подними ещё `minHelper` в `config.js`, а новые возможности проверяй по списку `features` из команды `hello`.

**ID расширения.** Помощник отвечает только расширениям из [extension-ids.txt](helper/install/extension-ids.txt). ID из Chrome Web Store нужно добавить туда и пересобрать помощник.

## Что дальше

- Подписать помощник: на macOS нужны подпись и нотаризация, на Windows — сертификат Authenticode. Без этого системы показывают предупреждения.
- Встроить sing-box в помощник как Go-библиотеку, чтобы получился один файл.
- Поддержать Clash YAML.
- Добавить диплинк для добавления подписки в один клик со страницы M-VPN (`externally_connectable`).
- Показывать скорость и для серверов xray (через его API статистики).
