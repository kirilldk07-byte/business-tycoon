# BUSINESS TYCOON: БИЗНЕС НА ДВОИХ

Браузерная 3D-игра (Three.js + TypeScript + Vite) для Яндекс Игр с **настоящим сетевым мультиплеером**:
два человека на разных устройствах (ПК ↔ ПК, ПК ↔ телефон, телефон ↔ телефон) играют в одной комнате
через собственный WebSocket-сервер (Node.js + `ws`). Сервер — единственный источник истины для денег,
покупок, таймера и победы.

```
CLIENT (Yandex Games iframe / браузер)  ⇄  wss://…/ws  ⇄  GAME SERVER (Node.js)  ⇄  ROOM (state, sim)
```

## Почему `ws`, а не Socket.IO
- Чистый WebSocket: меньше трафика и задержек, нет polling-фолбэков.
- В Яндекс Играх внешние хосты разрешаются через CSP-правила в консоли — один `wss://` домен проще пропустить, чем транспорт Socket.IO.
- Протокол полностью наш и типизирован (`shared/protocol/messages.ts`), переподключение и resume реализованы явно.

## Структура

```
shared/            общий код клиента и сервера
  protocol/        типизированные события C2S/S2C, кодек
  types/           RoomSnapshot, BusinessState, MatchResult…
  constants/       config.ts — ВЕСЬ баланс (цены, формула BUSINESS VALUE, тайминги), world.ts — раскладка карты
  game/economy.ts  чистые формулы экономики (сервер — авторитетно, клиент — только показ)
  events/          метаданные событий матча
server/
  index.ts         HTTP (статика + /api/health) + WebSocket upgrade на /ws
  networking/      GameServer (сессии, диспетчер, rate limit, heartbeat)
  rooms/           Room (матч, покупки, события, реконнект), RoomManager (коды, токены, тики, очистка)
  matchmaking/     FIFO-очередь Quick Match
  game/            BusinessSim — серверная симуляция клиентов/производства/дохода
  validation/      строгая валидация каждого входящего сообщения
  persistence/     интерфейсы ProfileStore/RoomStore + JSON-реализация (заменяемо на Redis/Postgres)
  config/          переменные окружения
client/src/
  multiplayer/     Net (reconnect, resume, синхронизация часов, ping), Interpolator
  game/            Game (рендер, prediction, отправка 15 Гц), Input, Effects
  player/ npc/ business/ world/   3D: персонажи, NPC-клиенты, здания 10 уровней, город
  ui/              HUD, панель бизнеса, стили
  audio/           AudioManager (синтез WebAudio + музыка)
  platform/        Yandex SDK обёртка, локальное хранение своих credentials
scripts/           e2e.ts, coop-e2e.ts, grace-e2e.ts, balance.ts, pack-yandex.sh
deploy/            nginx.conf, systemd unit, Dockerfile
```

## Сетевая модель
| Что | Как | Частота |
|---|---|---|
| Движение | клиент → `PLAYER_MOVE [x,y,z,rot,anim]` (только при изменении), сервер клампит скорость/границы | 15 Гц |
| Позиции всех | сервер → `SNAPSHOT` (компактные массивы) | 15 Гц |
| Экономика | сервер → `ECONOMY` (cash/stock/queue/value) | 4 Гц |
| Покупки, стройка, найм | событие `BUY_UPGRADE` / `BUILD_BUSINESS` / `HIRE_WORKER` → проверка → `BUSINESS_UPDATE` | по событию |
| NPC-клиенты | `CUSTOMER_SPAWN` с серверным временем прихода, `CUSTOMER_SERVED` | по событию |
| Таймер/старт | `startAt`/`endAt` в серверном времени, клиенты синхронизируют часы NTP-методом | — |

Соперник рендерится в прошлом (≈110 мс) с интерполяцией между снапшотами и коротким экстраполированием —
движение плавное при 50–200 мс задержки. Свой персонаж — client-side prediction + `CORRECTION` от сервера.

**Анти-чит:** клиент шлёт только намерения. Сервер проверяет: существует ли апгрейд, хватает ли денег,
не максимум ли, принадлежит ли бизнес игроку, идёт ли матч, близко ли игрок к объекту (`TOO_FAR`),
скорость движения. Деньги, доход, стоимость бизнеса, победа и таймер считаются только на сервере.
Rate limit (token bucket) по категориям: движение, действия, эмоции, создание комнат, dev.

**Безопасность комнат:** код комнаты ≠ личность. При входе выдаётся случайный 48-hex session token;
`RESUME` требует token **и** совпадения профиля (profileId + secret, хранится только hash).

**Реконнект:** при обрыве сокета игрок получает 45 с grace-периода (`MATCH.reconnectGraceMs`), второй
видит «Игрок переподключается… N с». Клиент сам переподключается с backoff и шлёт `RESUME` — возвращается
в тот же матч с теми же деньгами/зданиями. Перезагрузка страницы в течение 60 с тоже возвращает в матч.
Не вернулся: VS → техническая победа оставшегося, CO-OP → игра продолжается. `LEAVE` во время VS = поражение.

**Рестарт сервера:** живые матчи снапшотятся в `DATA_DIR/rooms.json` каждые 3 с и при SIGTERM.
После старта комнаты восстанавливаются, все игроки получают новый grace-период и автоматически
возвращаются (проверено вживую). Для горизонтального масштабирования заменить `FileRoomStore` на Redis
и закрепить комнату за инстансом (sticky routing по коду комнаты).

**Масштаб на 4 игроков:** игроки — `Map`, участки — массив `PLOTS`, `MATCH.maxPlayers` в конфиге;
сетевой код не завязан на player1/player2.

## Профиль vs матч
- `PlayerProfile` (сервер, `profiles.json`): wins, losses, coopWins, rating (Elo), coins, шляпы. Начисляет только сервер по результату.
- `MatchState` (в комнате): деньги, здания, работники, апгрейды, таймер. Сбрасывается при каждом матче/реванше — перенос денег невозможен.

## Режимы
- **⚔️ VS** — 10 минут, у каждого свой участок; побеждает большая `BUSINESS VALUE = cash + здания + постройки + 0.8·апгрейды + 0.6·персонал` (веса в `VALUE_WEIGHTS`). События RUSH HOUR / GOLDEN CUSTOMER / BUSINESS BOOST одновременно и одинаково для обоих.
- **🤝 CO-OP** — общий бизнес и касса, 15 минут, цель BUILD THE MEGA MALL ($1M + уровень 8 + PRICE/CUSTOMERS/CAPACITY ≥ 4). Совместные события: DELIVERY ARRIVED (разгрузить 6 ящиков), POWER FAILURE (два рубильника в разных концах карты почти одновременно), CUSTOMER RUSH.
- **🎮 Соло** — то же, что CO-OP, для одного.
- **⚡ Quick Match** — FIFO; через 30 с предлагает CONTINUE SEARCHING / PLAY SOLO / CREATE PRIVATE ROOM. Ботов нет.

## Запуск локально (разработка)
```bash
npm install
npm run dev:server      # :3040, DEV_TOOLS=1
npm run dev:client      # :5180, проксирует /ws на :3040
# открыть http://<ip>:5180/?dev=1
```
Dev-панель (`?dev=1` + сервер с `DEV_TOOLS=1`): +деньги, стройка, таймер→15 с, событие, конец матча,
симуляция дисконнекта / офлайна 10 с, задержка 0/50/100/200 мс, «2nd client» (новое окно с кодом комнаты).

## Тесты
```bash
WS_URL=ws://<host>:3040/ws npm run test:e2e                 # 30 проверок: комнаты, ready, старт, анти-чит, движение, реконнект, результат, реванш, forfeit, quick match, rate limit
WS_URL=ws://<host>:3040/ws LATENCY=200 npm run test:e2e     # то же с задержкой 200 мс в каждую сторону
WS_URL=ws://<host>:3040/ws npx tsx scripts/coop-e2e.ts      # CO-OP: общий бизнес, ящики, рубильники, TOO_FAR, Mega Mall
WS_URL=ws://<host>:3040/ws npx tsx scripts/grace-e2e.ts     # соперник не вернулся за 45 с → техническая победа
npm run test:balance                                         # симуляция экономики жадным ботом
```
(e2e требуют `DEV_TOOLS=1` на тестовом сервере.)

## Production build
```bash
npm ci
VITE_WS_URL=wss://tycoon.example.com/ws npm run build
#  dist/client/   — клиент (статический, для Яндекс Игр)
#  dist/server/index.js — сервер (зависимость в runtime: только ws)
```

## Переменные окружения
См. `.env.example`. Главное: `PORT`, `DEV_TOOLS=0` в проде, `DATA_DIR`, `ALLOWED_ORIGINS`, и на этапе
сборки клиента — `VITE_WS_URL`. Также URL сервера можно переопределить в рантайме: `?server=wss://…/ws`.

## Деплой backend
1. Сервер с Node 20+, домен, например `tycoon.example.com` → A-запись на IP.
2. ```bash
   sudo mkdir -p /opt/business-tycoon /var/lib/business-tycoon && sudo chown www-data /var/lib/business-tycoon
   rsync -a --exclude node_modules ./ /opt/business-tycoon/ && cd /opt/business-tycoon
   npm ci && VITE_WS_URL=wss://tycoon.example.com/ws npm run build && npm prune --omit=dev
   cp .env.example .env   # отредактировать
   sudo cp deploy/business-tycoon.service /etc/systemd/system/ && sudo systemctl enable --now business-tycoon
   sudo cp deploy/nginx.conf /etc/nginx/sites-available/tycoon && sudo ln -s ../sites-available/tycoon /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx && sudo certbot --nginx -d tycoon.example.com
   curl https://tycoon.example.com/api/health
   ```
   Либо Docker: `docker build -f deploy/Dockerfile --build-arg VITE_WS_URL=wss://tycoon.example.com/ws -t tycoon . && docker run -d -p 3040:3040 -v tycoon-data:/data tycoon`.
3. **Обязательно HTTPS/WSS**: Яндекс Игры открываются по https, браузер заблокирует `ws://`.

## Подключение клиента к production WebSocket
- Сборка: `VITE_WS_URL=wss://tycoon.example.com/ws` → URL вшит в бандл.
- Без переменной клиент использует `wss://<тот же хост>/ws` (удобно, когда сервер сам раздаёт клиент).
- Отладка: `?server=wss://другой-хост/ws`.

## Тест с двух разных устройств
1. Устройство A (ПК) открывает `https://tycoon.example.com/` (или ссылку тестового сервера) → «Играть с другом» → «Создать комнату» → получает код, напр. `482731` (можно «Поделиться»/«Ссылка» — откроет ввод кода).
2. Устройство B (телефон на мобильном интернете, **не** в той же Wi-Fi сети — так проверяется настоящий интернет) → «Играть с другом» → «Войти по коду» → `482731` → «Подключиться».
3. Оба видят PLAYER 1/PLAYER 2 и пинг → оба READY → START → общий отсчёт 3-2-1-BUILD!
4. A покупает улучшение/здание (панель «Бизнес») → B видит стройку на участке A и цифры в HUD.
5. B бегает джойстиком → A видит плавное движение. Таймеры совпадают.
6. Выключить Wi-Fi/мобильные данные у B на 10–20 с → у A «переподключается…», после включения B возвращается в тот же матч.
7. По окончании — одинаковый экран результатов, REMATCH у обоих → новый матч в той же комнате.

## Перед публикацией в Яндекс Играх
1. Задеплоить backend на домен с валидным TLS, `DEV_TOOLS=0`.
2. Собрать архив: `VITE_WS_URL=wss://tycoon.example.com/ws bash scripts/pack-yandex.sh` → `dist/yandex-game.zip` (index.html в корне, все пути относительные — `base: './'`).
3. В консоли разработчика добавить домен сервера в правила **CSP** (раздел добавления игры → проверка хостов): `wss://tycoon.example.com` (и `https://` для `/api`). Без этого WebSocket в проде заблокируется.
4. Проверить реальный Origin iframe игры в DevTools и при необходимости поправить `ALLOWED_ORIGINS`.
5. Создать лидерборд с техническим именем **`wins`** (тип — число, по убыванию). Игра вызывает `ysdk.leaderboards.setScore('wins', wins)` только для авторизованных.
6. Включить монетизацию: fullscreen показывается только между матчами (после выхода в меню), rewarded — только в магазине (монеты на косметику), никогда во время VS.
7. `LoadingAPI.ready()` вызывается после загрузки, `GameplayAPI.start/stop` — на старт/конец матча, паузу и рекламу; звук глушится на время рекламы и при скрытии вкладки.
8. Заполнить карточку игры: язык — русский, описание мультиплеера («нужен интернет»), скриншоты ПК и мобильной версии, ориентация — любая.
9. Для production-масштаба: заменить JSON-хранилище на Redis/Postgres; для привязки профиля к аккаунту Яндекса проверять подпись `getPlayer({ signed: true })` на сервере.

## Известные ограничения MVP
- Профиль гостя привязан к устройству (id+secret в localStorage и в облачном сохранении Яндекса для авторизованных). Подпись Яндекса на сервере ещё не проверяется.
- Награда за rewarded-рекламу не верифицируется сервером (поэтому выдаёт только косметические монеты и не работает внутри VS).
- Один инстанс сервера; горизонтальное масштабирование — через Redis RoomStore + sticky routing.
