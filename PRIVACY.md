# Политика конфиденциальности M-Link

_Обновлено: 14 ноября 2026 г._ · [English version below](#m-link-privacy-policy)

M-Link — это расширение для браузера и программа-помощник, которые подключают браузер к прокси-серверам пользователя. Мы не собираем и не получаем никаких данных пользователей.

## Что хранится и где

Все данные хранятся только на твоём компьютере:

- **В расширении** (локальное хранилище браузера): ссылки на подписки, список серверов, выбранный сервер, настройки (режим сайтов, списки доменов, порт, User-Agent), результаты замера пинга.
- **В папке помощника** (`MLink` в папке данных приложений системы):
  - `config.json`: настройки текущего сервера. Без них ядро sing-box не запустится.
  - `helper.log`: технический журнал (запуск и остановка ядра, ошибки). В нём могут быть адреса серверов и последние строки сообщений ядра об ошибках.

- **Текущая вкладка:** когда ты открываешь окно расширения, оно видит адрес открытой вкладки, чтобы показать переключатель «VPN / Напрямую» для этого сайта. Адрес никуда не отправляется и не сохраняется. Сохраняется только правило, если ты сам нажал переключатель.
- **Настройки WebRTC:** пока VPN включён, расширение запрещает WebRTC соединяться в обход прокси, чтобы он не раскрыл твой настоящий IP. После отключения VPN настройка возвращается к прежней.

Расширение и помощник **не отправляют разработчику ничего**: ни историю посещений, ни адреса сайтов, ни подписки, ни статистику или аналитику.

## Какие сетевые запросы выполняются

- **Скачивание подписок** по ссылкам, которые добавил ты сам, у твоего поставщика подписки. Запрос выполняет помощник и передаёт заголовок `User-Agent: M-Link/<версия>`. Самому расширению доступ к сайтам не нужен.
- **Служебный файл с GitHub** раз в сутки: `remote-config.json` из репозитория проекта. В нём номер актуальной версии помощника и текст рекламного блока. Запрос не содержит никаких данных о тебе, но GitHub, как любой сайт, видит IP-адрес.
- **Трафик браузера** идёт через выбранный тобой сервер, а при режиме «все, кроме списка» или «только список» — напрямую для указанных сайтов. Что видит и хранит сервер, определяет его владелец, а не M-Link.
- **Замер пинга:** запрос к `https://www.gstatic.com/generate_204` через каждый проверяемый сервер.
- **Обновление помощника:** помощник версии 1.1 и новее раз в сутки (и когда ты нажимаешь «Обновить») узнаёт у `api.github.com` номер последнего релиза этого проекта и, если он новее, скачивает архив с `github.com`. Запрос не содержит данных о тебе.
- **Ссылки «Скачать помощник», «Продлить» и рекламный блок** открывают GitHub, сайт или Telegram-бот сервиса только по твоему нажатию.

## Третьи стороны

Данные не продаются и не передаются третьим лицам. Сторонние сервисы получают запросы только в описанных выше случаях: твой поставщик подписки, твои серверы, Google (замер пинга), GitHub (служебный файл и проверка обновлений раз в сутки, ссылки по нажатию) и Telegram (только по нажатию на ссылку).

## Как удалить данные

- Удали подписку в расширении: она стирается вместе со списком серверов.
- Удали расширение из браузера: браузер стирает все его данные.
- Запусти `uninstall.sh` или `uninstall.bat` из архива помощника: удаляются помощник, его журнал и конфиг.

## Открытый исходный код

Код расширения и помощника открыт: https://github.com/Mag1c3R/m-link

## Связь

Вопросы и сообщения об ошибках: https://github.com/Mag1c3R/m-link/issues

---

# M-Link Privacy Policy

_Last updated: November 14, 2026_

M-Link is a browser extension and a companion helper app that connect the browser to the user's own proxy servers. We do not collect or receive any user data.

## What is stored and where

All data stays on the user's device:

- **In the extension** (browser local storage): subscription links, the server list, the selected server, settings (site mode, domain lists, port, User-Agent) and latency results.
- **In the helper folder** (`MLink` in the system application data folder):
  - `config.json`: the settings of the current server, needed to start the sing-box core.
  - `helper.log`: a technical log (core start/stop, errors). It may contain server addresses and the last lines of core error messages.

- **Current tab:** when the user opens the extension window, it reads the address of the active tab to show the "VPN / Direct" switch for that site. The address is not sent anywhere and is not stored; only a rule the user creates with the switch is stored.
- **WebRTC setting:** while the VPN is on, the extension stops WebRTC from connecting outside the proxy so it can't reveal the real IP. The setting is restored when the VPN is turned off.

Neither the extension nor the helper sends **anything** to the developer: no browsing history, no site addresses, no subscriptions, no statistics or analytics.

## Network requests

- **Subscription download** from the links the user added, sent to the user's subscription provider. The request is made by the helper app with the header `User-Agent: M-Link/<version>`. The extension itself has no access to websites.
- **A config file from GitHub** once a day: `remote-config.json` from the project repository. It contains the current helper version and the text of the promo block. The request carries no user data, but GitHub, like any website, sees the IP address.
- **Browser traffic** goes through the server selected by the user, or directly for sites excluded by the user's rules. What a server sees or logs is determined by its operator, not by M-Link.
- **Latency test:** a request to `https://www.gstatic.com/generate_204` through each server being tested.
- **Helper updates:** helper 1.1 and later asks `api.github.com` once a day (and when the user clicks "Update") for the latest release of this project and, if it is newer, downloads the archive from `github.com`. The request carries no user data.
- **"Download helper", "Renew" and promo links** open GitHub, the service's site or Telegram only when the user clicks them.

## Third parties

Data is not sold or shared with third parties. Third-party services receive requests only in the cases listed above: the user's subscription provider, the user's servers, Google (latency test), GitHub (the daily config file and update check, links on click) and Telegram (only on click).

## Deleting data

- Remove a subscription in the extension: its server list is deleted too.
- Uninstall the extension: the browser deletes all of its data.
- Run `uninstall.sh` or `uninstall.bat` from the helper archive: the helper, its log and config are removed.

## Open source

The source code of the extension and the helper is public: https://github.com/Mag1c3R/m-link

## Contact

Questions and bug reports: https://github.com/Mag1c3R/m-link/issues
