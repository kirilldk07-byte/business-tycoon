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

## Игровой процесс (v2)
- **Участок стартует пустым.** Первая зелёная площадка — COFFEE STAND ($50). Дальше флагман растёт по цепочке
  🥤 Киоск → ☕ Кофейня → 🍔 Кафе → 🍽️ Ресторан → 🏪 Магазин → 🛒 Супермаркет → 🏬 ТЦ → 🏢 Бизнес-центр → 🌆 Небоскрёб → 👑 BUSINESS EMPIRE.
- **Новые бизнесы** (data-driven, `VENUES` в `shared/constants/config.ts` + слот в `world.ts` + билдер в `BuildingFactory.ts`):
  Burger Shop → Restaurant → Supermarket → Car Dealership → Hotel → Shopping Mall, у каждого 3 уровня.
- **Tycoon-площадки** на участке: стоишь на светящемся круге → `E`/кнопка → клиент **только запрашивает** покупку, сервер проверяет и подтверждает, затем каждый клиент локально проигрывает стройку (фундамент → рост → частицы → BUILD COMPLETE!).
- **Автоматизация:** касса и производство вручную → кассир/рабочий → менеджер → новые бизнесы работают сами.
- **Работники** стоят в своих зонах и анимированы (касса, производство, офис, доставка на скутере, маркетолог с вывеской).
- **NPC-клиенты** идут по тротуару к нужному бизнесу; маршрут общий для сервера и клиента, время прихода — серверное. Рендер — 7 InstancedMesh на всю толпу.
- **События:** RUSH HOUR, CITY FESTIVAL, VIP CUSTOMER (одинаковая фиксированная награда обоим — честный comeback), BIG DELIVERY (ящики у каждого игрока свои), BUSINESS BOOST; GOLDEN CUSTOMER (x10) приходит ко всем одновременно. CO-OP: DELIVERY, POWER FAILURE (два генератора), RUSH, финальная цель MEGA MALL.
- **Таймлайн VS** (проверен `npm run test:balance`): 0–1 мин киоск и первые покупки → ~2 мин второй бизнес → 4–6 мин Restaurant/Supermarket → 7–9 мин быстрый рост → финал ≈ $1–2M у сильного игрока.

## Режимы
- **⚔️ VS** — 10 минут, свои участки, победа по `BUSINESS VALUE = cash + здания + бизнесы + постройки + 0.8·апгрейды + 0.6·персонал` (`VALUE_WEIGHTS`).
- **🤝 CO-OP** — общий бизнес и касса, 18 минут, цель MEGA MALL: $5M + HQ 9 + PRICE/CUSTOMERS/CAPACITY ≥ 4.
- **🎮 SOLO** — как CO-OP для одного; единственный режим, где rewarded-реклама даёт игровой бонус (x2 производство 60 с).
- **⚡ QUICK MATCH** — FIFO; через 30 с: KEEP SEARCHING / PLAY SOLO / CREATE PRIVATE ROOM. Ботов нет.

## Мета-прогресс (вне матча)
Профиль на сервере: wins, losses, rating (Elo), матчи, монеты, косметика, достижения
(FIRST BUSINESS, ENTREPRENEUR, MILLIONAIRE, WINNER, TEAMWORK, TYCOON). В матч ничего из этого не переносится — старт всегда равный.

## Реклама и честность
- Interstitial — только после выхода из матча в меню.
- Rewarded: монеты на косметику (вне VS-матча, в т.ч. на экране результатов) и x2 производство в SOLO. Сервер **отклоняет** `AD_BOOST`/`AD_REWARD` внутри VS (`security-e2e`).
- `game_api_pause/resume` (Yandex SDK) глушат звук и ввод; время матча идёт на сервере.

## Производительность
Город, здания и бизнесы запечены в несколько мешей с вершинными цветами (`client/src/world/geo.ts`), толпа — instancing, частицы — instancing, всплывающие тексты — пул DOM.
Меню с двумя застроенными бизнесами-витринами ≈ 140 draw calls / ~95K треугольников в кадре (≈150K вместе с проходом теней на MEDIUM); InstancedMesh толпы рисует только занятые слоты. Трафик в матче ≈ 2,6 КБ/с на клиента (снапшоты 15 Гц + экономика 4 Гц).
Пресеты AUTO/LOW/MEDIUM/HIGH (pixel ratio, тени, лимит NPC); AUTO сам понижает качество при FPS < 30.

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
WS_URL=ws://<host>:3041/ws bash scripts/test-all.sh          # всё: typecheck + e2e (0/150 мс) + coop + security + grace (45 с)
WS_URL=ws://<host>:3041/ws bash scripts/test-all.sh --quick  # без 45-секундного grace-теста
WS_URL=... LATENCY=200 npx tsx scripts/e2e.ts                # плохая сеть
WS_URL=... PROD_WS_URL=ws://<host>:3040/ws npx tsx scripts/security-e2e.ts   # + проверка, что prod отклоняет dev-команды
npm run test:balance                                          # таймлайн экономики
```
- `e2e.ts` (32): комнаты, ready, общий старт, анти-чит покупок, порядок бизнесов, постройка видна сопернику, движение, телепорт, эмоции, reconnect, одинаковый результат, заморозка после конца, rematch, forfeit, quick match, rate limit.
- `coop-e2e.ts` (10): общий бизнес, TOO_FAR, ящики вдвоём, два генератора, Mega Mall → победа обоих.
- `security-e2e.ts` (18–19): повтор покупки, чужой бизнес/ящики, украденный токен, полная/идущая комната, мусорные поля и типы сообщений, фейковый MATCH_END/результат от клиента, честность VS-событий, реклама в VS, спам, restore после reconnect, заморозка после MATCH_END, prod без dev.
- `grace-e2e.ts`: соперник не вернулся за 45 с → техническая победа.
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
На HTTPS-странице клиент принимает только `wss://` (любой `ws://` из параметра, `config.json` или env игнорируется — mixed content); `pack-yandex.sh` требует `wss://`.

## GitHub Pages (клиент) + туннель (сервер)
Клиент опубликован на **https://kirilldk07-byte.github.io/business-tycoon/** (ветка `gh-pages`).
GitHub Pages — только статика, поэтому игровой сервер работает отдельно, а страница по HTTPS может ходить только на `wss://`.
- Адрес сервера клиент читает в рантайме из `config.json` рядом с `index.html` (приоритет: `?server=` → `config.json` → `VITE_WS_URL` → тот же хост).
- `bash scripts/deploy-pages.sh` с `WS_URL=wss://.../ws` — собрать и опубликовать клиент.
- `bash scripts/start-tunnel.sh` — поднять Cloudflare quick tunnel к локальному серверу (`PORT`, по умолчанию 3040) и сразу перепубликовать `config.json` с новым адресом.
- Quick tunnel меняет адрес при каждом перезапуске и не переживает перезагрузку машины. Для постоянного адреса: named Cloudflare tunnel на своём домене или nginx + TLS (ниже), затем `deploy-pages.sh` с постоянным `WS_URL`.

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

## Тест на реальных устройствах (ПК + телефон)
Production URL: **https://kirilldk07-byte.github.io/business-tycoon/** (сервер — prod-режим, `DEV_TOOLS=0`, за `wss://` туннелем).
Устройство A — ПК, устройство B — телефон **на мобильном интернете** (Wi-Fi выключен).

| # | Действие | Ожидаемый результат |
|---|---|---|
| 1 | ПК: PLAY WITH FRIEND → CREATE ROOM | 6-значный код, карточка PLAYER 2 «WAITING…» |
| 2 | Телефон: PLAY WITH FRIEND → JOIN ROOM → ввести код | Подключается автоматически после 6 цифр; на ПК карточка Bob влетает с анимацией, «CONNECTED ✓», звук |
| 3 | Оба: READY | Плашки «READY ✓» у обоих |
| 4 | ПК: START | У обоих 3-2-1-GO! одновременно |
| 5 | Оба двигаются | Соперник движется плавно, без рывков и телепортов |
| 6 | ПК покупает кофейню / HQ / бизнес | Стройка с пылью и вспышкой, «BUILD COMPLETE!» |
| 7 | Телефон смотрит на участок ПК | Видит ту же стройку; тост «Соперник: HQ уровень N» |
| 8 | Телефон: «Бизнес» → Улучшения → купить | Тап срабатывает с первого раза, видно «+$X/мин · окупится за N с» |
| 9 | ПК смотрит на участок телефона | Появились звёзды/шары/ограждение, у соперника выросла сумма в VS-карточке |
| 10 | Дождаться события (≈каждые 1,5–2 мин) | Баннер события одинаковый у обоих |
| 11 | Телефон: выключить интернет на 10 с | На ПК «Bob переподключается… 45с»; у телефона экран CONNECTION LOST |
| 12 | Включить интернет | Телефон сам возвращается в тот же матч, состояние сохранено |
| 13 | Доиграть до конца таймера | — |
| 14 | Сравнить экраны результатов | Победитель и все цифры совпадают на обоих устройствах |
| 15 | Оба: REMATCH | Короткий отсчёт, новый матч с нуля |
| 16 | Повернуть телефон | Интерфейс перестраивается, ничего не обрезано |

Если игра не подключается: туннель мог смениться — на сервере `bash scripts/start-tunnel.sh`.

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
