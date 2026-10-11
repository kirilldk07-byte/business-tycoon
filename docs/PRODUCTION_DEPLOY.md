# Production deploy: постоянный домен + Cloudflare Named Tunnel

Итоговая схема:

```
Yandex Games (клиент из ZIP)
        │  wss://game.DOMAIN.TLD/ws
        ▼
Cloudflare (TLS, DNS, WebSocket proxy)
        │  Named Tunnel (исходящее соединение с VPS — входящие порты не нужны)
        ▼
cloudflared-tunnel.service  (systemd --user)
        │  http://127.0.0.1:3040
        ▼
business-tycoon.service     (systemd --user, Node, только loopback)
```

`game.DOMAIN.TLD` ниже — **плейсхолдер**. Везде подставь свой поддомен, например `game.mytycoon.ru`.
`pack-yandex.sh` откажется собирать архив с плейсхолдером, `example.com`, IP, портом, `localhost` или `trycloudflare.com`.

Что уже сделано на VPS (проверка: `bash scripts/check-production.sh`):

- backend работает как `business-tycoon.service` (systemd **user** unit, пользователь `kirill`, не root), автозапуск, `Restart=always`;
- включён linger → сервис стартует после перезагрузки без входа в систему;
- backend слушает **127.0.0.1:3040** (снаружи недоступен), dev-сервер — 127.0.0.1:3041;
- `/health` → `{"status":"ok",...}`; graceful shutdown сохраняет комнаты и профили;
- `cloudflared` 2026.10.0 лежит в `~/bin/cloudflared`; unit `cloudflared-tunnel.service` установлен, но **не включён** (ждёт домен);
- временный quick tunnel (`*.trycloudflare.com`) продолжает работать для тестов до перехода.

---

## 1. Domain setup

1. Купи домен у любого регистратора (например `mytycoon.ru`). Отдельный домен не обязателен — подойдёт поддомен уже имеющегося.
2. Реши, какой поддомен будет у игрового сервера: **`game.<домен>`** (рекомендуется — так основной сайт останется свободным).

## 2. Cloudflare DNS

Named Tunnel работает только для доменов, DNS которых обслуживает Cloudflare.

1. https://dash.cloudflare.com → **Add a domain** → введи домен → план **Free**.
2. Cloudflare покажет два nameserver'а (`xxx.ns.cloudflare.com`). У регистратора замени NS домена на них.
3. Дождись статуса домена **Active** в Cloudflare (обычно минуты, иногда до 24 ч).
4. В Cloudflare: **SSL/TLS → Overview** — режим **Full** (для туннеля сертификат на VPS не нужен), **Network → WebSockets: On** (включено по умолчанию).

> Если домен уже на Cloudflare — шаги 1–3 пропусти.

## 3. Named Tunnel (команды выполняются на VPS под пользователем `kirill`)

```bash
cd ~/projects/business-tycoon

# 3.1 Авторизация cloudflared в твоём аккаунте (ЕДИНСТВЕННЫЙ шаг, где нужен браузер):
~/bin/cloudflared tunnel login
#  → команда напечатает ссылку. Открой её на своём компьютере, войди в Cloudflare,
#    выбери домен. cloudflared сам сохранит ~/.cloudflared/cert.pem на VPS.

# 3.2 Создать туннель (создаст ~/.cloudflared/<TUNNEL_ID>.json — это секрет, не коммитить):
~/bin/cloudflared tunnel create business-tycoon
~/bin/cloudflared tunnel list            # запомни ID туннеля

# 3.3 DNS-запись game.DOMAIN.TLD → туннель (CNAME на <ID>.cfargotunnel.com создаётся автоматически):
~/bin/cloudflared tunnel route dns business-tycoon game.DOMAIN.TLD

# 3.4 Конфиг туннеля из шаблона:
TID=$(~/bin/cloudflared tunnel list -o json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).find(t=>t.name==="business-tycoon").id))')
sed -e "s/<TUNNEL_ID>/$TID/g" -e "s/<HOSTNAME>/game.DOMAIN.TLD/g" deploy/cloudflared/config.yml.template > ~/.cloudflared/config.yml
chmod 600 ~/.cloudflared/*.json ~/.cloudflared/cert.pem

# 3.5 Проверить правила ingress:
~/bin/cloudflared tunnel --config ~/.cloudflared/config.yml ingress validate
~/bin/cloudflared tunnel --config ~/.cloudflared/config.yml ingress rule https://game.DOMAIN.TLD/ws   # → http://127.0.0.1:3040

# 3.6 Запустить туннель как сервис с автозапуском:
systemctl --user daemon-reload
systemctl --user enable --now cloudflared-tunnel
systemctl --user status cloudflared-tunnel --no-pager
journalctl --user -u cloudflared-tunnel -f        # должно быть "Registered tunnel connection" ×4
```

Ingress (`~/.cloudflared/config.yml`):

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /home/kirill/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: game.DOMAIN.TLD
    service: http://127.0.0.1:3040
  - service: http_status:404
```

> Альтернатива: туннель, созданный в панели (Zero Trust → Networks → Tunnels), запускается токеном:
> `cloudflared tunnel run --token <TOKEN>`. Тогда в unit замени `ExecStart` на этот вариант,
> а токен положи в `EnvironmentFile` с правами 600 (переменная `TUNNEL_TOKEN`), не в git.

## 4. Backend service

Уже настроен. Шпаргалка:

```bash
systemctl --user status business-tycoon            # статус
journalctl --user -u business-tycoon -f            # логи
systemctl --user restart business-tycoon           # рестарт (SIGTERM → комнаты сохраняются, клиенты переподключаются)
bash scripts/deploy-production.sh                  # сборка + рестарт + health + откат при сбое
bash scripts/install-services.sh                   # переустановить units (после правок deploy/systemd/*)
```

Конфигурация: `~/.config/business-tycoon/prod.env` (права 600; шаблон `deploy/env/prod.env.example`).
Секретов у сервера нет; учётки игроков (profileId+secret) хранятся в `data/profiles.json` (каталог 700, в git не попадает).

Проверка перезагрузки (выполнить вручную, когда удобно — на VPS работают и другие проекты):

```bash
sudo reboot
# через ~1 мин после загрузки:
systemctl --user is-active business-tycoon cloudflared-tunnel
curl -s http://127.0.0.1:3040/health
```

## 5. WSS test

```bash
curl -s https://game.DOMAIN.TLD/health                                  # {"status":"ok",...}
bash scripts/check-production.sh wss://game.DOMAIN.TLD/ws               # все пункты ✓
```

После этого временный quick tunnel больше не нужен: останови процесс `cloudflared tunnel --url ...`
(`pgrep -fa 'cloudflared tunnel --url'` → `kill <pid>`) и, если нужно, перенаправь веб-версию:
`WS_URL=wss://game.DOMAIN.TLD/ws bash scripts/deploy-pages.sh`.

## 6. Yandex build

```bash
VITE_WS_URL=wss://game.DOMAIN.TLD/ws bash scripts/pack-yandex.sh
bash scripts/check-production.sh wss://game.DOMAIN.TLD/ws
# → dist/yandex-game.zip
```

## 7. CSP

Консоль разработчика Яндекс Игр → игра → вкладка **CSP**:

- хост: `game.DOMAIN.TLD` (без `wss://`, без порта и пути — протоколы https/wss подразумеваются);
- причина: «Мультиплеерный сервер матчей: WebSocket-соединение для игры вдвоём в реальном времени».

Заявку рассматривает Яндекс. Архив: **Общее → Архив** → `dist/yandex-game.zip`.

## 8. Draft testing

Открой черновик на ПК и телефоне (portrait + landscape):

- [ ] меню загрузилось, нет экрана ошибки соединения;
- [ ] SOLO-матч стартует, деньги идут;
- [ ] два устройства: Quick Match / комната по коду → VS-матч до конца;
- [ ] ☰ → меню: игра на паузе для платформы, возврат продолжает;
- [ ] сворачивание вкладки/приложения → звук пропадает, возврат → звук есть;
- [ ] rewarded x2 (соло) и межстраничная реклама между матчами;
- [ ] переподключение: на 5 с выключить интернет → «RECONNECTING…» → «CONNECTED», матч продолжается.

## 9. Origin restriction

Пока `ALLOWED_ORIGINS` пуст — сервер принимает любой Origin (так задумано до первого запуска черновика).

```bash
journalctl --user -u business-tycoon | grep 'new WebSocket origin'
#  → увидишь реальные origin'ы черновика Яндекса (и веб-версии, если она нужна)
nano ~/.config/business-tycoon/prod.env
#  ALLOWED_ORIGINS=https://<origin черновика>,*.<домен-суффикс-яндекса>,https://kirilldk07-byte.github.io
systemctl --user restart business-tycoon
```

Формат: через запятую, точное совпадение или `*.suffix`. После изменения снова пройди пункт 8.

## 10. Final moderation checklist

- [ ] `bash scripts/check-production.sh wss://game.DOMAIN.TLD/ws` — FAIL 0
- [ ] `WS_URL=ws://127.0.0.1:3041/ws bash scripts/test-all.sh` — ALL GREEN
- [ ] архив собран с постоянным доменом (не trycloudflare), `index.html` в корне, < 100 МБ
- [ ] хост добавлен и одобрен во вкладке CSP
- [ ] язык игры в консоли: ru
- [ ] черновик пройден по пункту 8 на телефоне и ПК
- [ ] `ALLOWED_ORIGINS` заполнен реальными origin'ами (пункт 9)
- [ ] `cloudflared-tunnel` и `business-tycoon` — `enabled` и `active`; перезагрузка VPS проверена
