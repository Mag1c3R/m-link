# Политика конфиденциальности M-Link

_Обновлено: 12 ноября 2026 г._ · [English version below](#m-link-privacy-policy)

M-Link — это расширение для браузера и программа-помощник, которые подключают браузер к прокси-серверам пользователя. Мы не собираем и не получаем никаких данных пользователей.

## Что хранится и где

Все данные хранятся только на твоём компьютере:

- **В расширении** (локальное хранилище браузера): ссылки на подписки, список серверов, выбранный сервер, настройки (режим сайтов, списки доменов, порт, User-Agent), результаты замера пинга.
- **В папке помощника** (`MClient` в папке данных приложений системы):
  - `config.json`: настройки текущего сервера. Без них ядро sing-box не запустится.
  - `helper.log`: технический журнал (запуск и остановка ядра, ошибки). В нём могут быть адреса серверов и последние строки сообщений ядра об ошибках.

Расширение и помощник **не отправляют разработчику ничего**: ни историю посещений, ни адреса сайтов, ни подписки, ни статистику или аналитику.

## Какие сетевые запросы выполняются

- **Скачивание подписок** по ссылкам, которые добавил ты сам, у твоего поставщика подписки. В запросе передаётся заголовок `User-Agent: M-Link/<версия>`.
- **Трафик браузера** идёт через выбранный тобой сервер, а при режиме «все, кроме списка» или «только список» — напрямую для указанных сайтов. Что видит и хранит сервер, определяет его владелец, а не M-Link.
- **Замер пинга:** запрос к `https://www.gstatic.com/generate_204` через каждый проверяемый сервер.
- **Ссылки «Скачать помощник» и рекламный блок** открывают GitHub и Telegram только по твоему нажатию.

## Третьи стороны

Данные не продаются и не передаются третьим лицам. Сторонние сервисы получают запросы только в описанных выше случаях: твой поставщик подписки, твои серверы, Google (замер пинга), GitHub и Telegram (только по нажатию на ссылку).

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

_Last updated: November 12, 2026_

M-Link is a browser extension and a companion helper app that connect the browser to the user's own proxy servers. We do not collect or receive any user data.

## What is stored and where

All data stays on the user's device:

- **In the extension** (browser local storage): subscription links, the server list, the selected server, settings (site mode, domain lists, port, User-Agent) and latency results.
- **In the helper folder** (`MClient` in the system application data folder):
  - `config.json`: the settings of the current server, needed to start the sing-box core.
  - `helper.log`: a technical log (core start/stop, errors). It may contain server addresses and the last lines of core error messages.

Neither the extension nor the helper sends **anything** to the developer: no browsing history, no site addresses, no subscriptions, no statistics or analytics.

## Network requests

- **Subscription download** from the links the user added, sent to the user's subscription provider with the header `User-Agent: M-Link/<version>`.
- **Browser traffic** goes through the server selected by the user, or directly for sites excluded by the user's rules. What a server sees or logs is determined by its operator, not by M-Link.
- **Latency test:** a request to `https://www.gstatic.com/generate_204` through each server being tested.
- **"Download helper" and promo links** open GitHub and Telegram only when the user clicks them.

## Third parties

Data is not sold or shared with third parties. Third-party services receive requests only in the cases listed above: the user's subscription provider, the user's servers, Google (latency test), GitHub and Telegram (only on click).

## Deleting data

- Remove a subscription in the extension: its server list is deleted too.
- Uninstall the extension: the browser deletes all of its data.
- Run `uninstall.sh` or `uninstall.bat` from the helper archive: the helper, its log and config are removed.

## Open source

The source code of the extension and the helper is public: https://github.com/Mag1c3R/m-link

## Contact

Questions and bug reports: https://github.com/Mag1c3R/m-link/issues
