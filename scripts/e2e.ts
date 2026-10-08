// Headless two-client multiplayer test. Usage:
//   WS_URL=ws://<public-ip>:3040/ws npx tsx scripts/e2e.ts
// Requires the server to run with DEV_TOOLS=1 (uses speedTimer/addMoney).
import WebSocket from 'ws';
import { C2S, PROTOCOL_VERSION, S2C, type ClientMsg, type ServerMsg } from '../shared/protocol/messages';

const URL = process.env.WS_URL ?? 'ws://localhost:3040/ws';
const LATENCY = Number(process.env.LATENCY ?? 0); // artificial one-way delay, ms

class TestClient {
  ws!: WebSocket;
  msgs: ServerMsg[] = [];
  token = '';
  playerId = '';
  profileId = '';
  secret = '';
  constructor(public name: string) {}
  connect() {
    return new Promise<void>((res, rej) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', () => res());
      this.ws.on('error', rej);
      this.ws.on('message', (d) => setTimeout(() => {
        const m = JSON.parse(d.toString()) as ServerMsg;
        this.msgs.push(m);
        if (m.t === S2C.ROOM_JOINED) { this.token = m.token; this.playerId = m.playerId; }
        if (m.t === S2C.WELCOME) { this.profileId = m.profile.id; this.secret = m.secret; }
      }, LATENCY));
    });
  }
  send(m: ClientMsg) { setTimeout(() => this.ws.send(JSON.stringify(m)), LATENCY); }
  async wait<T extends ServerMsg['t']>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true, ms = 8000) {
    const start = Date.now();
    for (;;) {
      const i = this.msgs.findIndex((m) => m.t === t && pred(m as Extract<ServerMsg, { t: T }>));
      if (i >= 0) return this.msgs.splice(i, 1)[0] as Extract<ServerMsg, { t: T }>;
      if (Date.now() - start > ms) throw new Error(`${this.name}: timeout waiting ${t}`);
      await sleep(20);
    }
  }
  last<T extends ServerMsg['t']>(t: T) {
    return [...this.msgs].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;
  }
  async hello(name: string) {
    this.send({ t: C2S.HELLO, v: PROTOCOL_VERSION, name, profileId: this.profileId || undefined, secret: this.secret || undefined });
    await this.wait(S2C.WELCOME);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(cond: unknown, what: string) {
  if (!cond) { console.error(`  ✗ ${what}`); process.exit(1); }
  passed++;
  console.log(`  ✓ ${what}`);
}

async function main() {
  console.log(`E2E against ${URL} (latency ${LATENCY}ms one-way)`);
  const A = new TestClient('A'), B = new TestClient('B');
  await A.connect(); await B.connect();
  await A.hello('Alice'); await B.hello('Bob');
  ok(true, 'both devices connected + HELLO');

  // Room create / join by code
  A.send({ t: C2S.CREATE_ROOM, mode: 'vs' });
  const ja = await A.wait(S2C.ROOM_JOINED);
  const code = ja.room.code;
  ok(/^\d{6}$/.test(code), `room code ${code}`);
  B.send({ t: C2S.JOIN_ROOM, code: '000000' });
  await B.wait(S2C.ERROR, (m) => m.code === 'ROOM_NOT_FOUND');
  ok(true, 'wrong code rejected');
  B.send({ t: C2S.JOIN_ROOM, code });
  const jb = await B.wait(S2C.ROOM_JOINED);
  ok(jb.room.players.length === 2, 'B joined, sees 2 players');
  await A.wait(S2C.ROOM_STATE, (m) => m.room.players.length === 2);
  ok(true, 'A sees B in lobby');

  // Start must fail before ready
  A.send({ t: C2S.START_MATCH });
  await A.wait(S2C.ERROR, (m) => m.code === 'NOT_READY');
  ok(true, 'START blocked until both READY');
  A.send({ t: C2S.PLAYER_READY, ready: true });
  B.send({ t: C2S.PLAYER_READY, ready: true });
  await A.wait(S2C.ROOM_STATE, (m) => m.room.players.every((p) => p.ready));
  A.send({ t: C2S.START_MATCH });
  const ca = await A.wait(S2C.MATCH_COUNTDOWN);
  const cb = await B.wait(S2C.MATCH_COUNTDOWN);
  ok(ca.startAt === cb.startAt && ca.endAt === cb.endAt, 'identical server start/end time on both devices');
  await A.wait(S2C.ROOM_STATE, (m) => m.room.status === 'playing', 6000);
  ok(true, 'match playing after countdown');

  // Anti-cheat: client cannot set money; buying without money fails
  A.send({ t: C2S.BUILD_BUSINESS, kind: 'tier' });
  await A.wait(S2C.ERROR, (m) => m.code === 'NOT_ENOUGH_MONEY');
  ok(true, 'server rejects purchase without money ($100 < $400)');
  A.send({ t: 'BUY_UPGRADE', id: 'price', money: 999999 } as never);
  const up = await B.wait(S2C.BUSINESS_UPDATE, (m) => m.cause === 'upgrade:price');
  ok(up.b.cash === 0 && up.b.upgrades.price === 1, 'A buys upgrade ($100); B sees it; injected money ignored');
  A.send({ t: C2S.BUY_UPGRADE, id: 'price' });
  await A.wait(S2C.ERROR, (m) => m.code === 'NOT_ENOUGH_MONEY');
  ok(true, 'second upgrade rejected (no cash)');
  A.send({ t: 'BUY_UPGRADE', id: 'nonexistent' } as never);
  await A.wait(S2C.ERROR, (m) => m.code === 'BAD_MESSAGE');
  ok(true, 'unknown upgrade id rejected');

  // Building visible to the other device
  A.send({ t: C2S.DEV, cmd: 'addMoney', arg: 1000 });
  await A.wait(S2C.BUSINESS_UPDATE, (m) => m.cause === 'dev');
  A.send({ t: C2S.BUILD_BUSINESS, kind: 'tier' });
  const tb = await B.wait(S2C.BUSINESS_UPDATE, (m) => m.cause === 'tier');
  ok(tb.b.tier === 2, 'A builds tier 2, B sees the new building');

  // Movement sync
  const bStart = jb.room.players.find((p) => p.id === B.playerId)!;
  void bStart;
  let pos: [number, number, number, number, number] = [30 - 9, 0, -4, 0, 1];
  // walk B in small steps
  const snapB0 = await A.wait(S2C.SNAPSHOT);
  const bEntry0 = snapB0.p.find((e) => e[0] === B.playerId)!;
  pos = [bEntry0[1], 0, bEntry0[3], 0, 1];
  for (let i = 0; i < 15; i++) {
    pos = [pos[0] - 0.4, 0, pos[2], 0, 1];
    B.send({ t: C2S.PLAYER_MOVE, p: pos, seq: i });
    await sleep(66);
  }
  await sleep(200 + 3 * LATENCY);
  A.msgs = A.msgs.filter((m) => m.t !== S2C.SNAPSHOT);
  const snap = await A.wait(S2C.SNAPSHOT);
  const bEntry = snap.p.find((e) => e[0] === B.playerId)!;
  ok(Math.abs(bEntry[1] - pos[0]) < 0.05, `A sees B moved to x=${bEntry[1]}`);

  // Speed hack clamp
  B.send({ t: C2S.PLAYER_MOVE, p: [0, 0, 0, 0, 1], seq: 99 });
  const corr = await B.wait(S2C.CORRECTION);
  ok(Math.hypot(corr.p[0], corr.p[2]) > 2, `teleport rejected with CORRECTION (server kept x=${corr.p[0]})`);

  // Emote sync
  B.send({ t: C2S.EMOTE, e: 2 });
  const em = await A.wait(S2C.EMOTE);
  ok(em.id === B.playerId && em.e === 2, 'emote 🔥 synced');

  // Customers / economy ticking
  const eco = await A.wait(S2C.ECONOMY);
  ok(eco.b.length === 2, 'economy ticks for both businesses');

  // Disconnect + reconnect with token
  const cashBefore = (await A.wait(S2C.ECONOMY)).b.find((b) => b.id === 1)!.cash;
  B.ws.terminate();
  const disc = await A.wait(S2C.PLAYER_DISCONNECTED);
  ok(disc.id === B.playerId && disc.graceUntil > Date.now(), 'A notified: opponent reconnecting (grace)');
  await sleep(1500);
  const B2 = new TestClient('B2');
  B2.profileId = B.profileId; B2.secret = B.secret;
  await B2.connect(); await B2.hello('Bob');
  B2.send({ t: C2S.RESUME, token: 'deadbeef' });
  await B2.wait(S2C.ERROR, (m) => m.code === 'BAD_TOKEN');
  ok(true, 'forged token rejected');
  B2.send({ t: C2S.RESUME, token: B.token });
  const res = await B2.wait(S2C.ROOM_JOINED);
  B2.playerId = res.playerId;
  const myBiz = res.room.businesses.find((b) => b.ownerIds.includes(res.playerId))!;
  ok(res.room.status === 'playing' && myBiz.cash >= cashBefore, `B resumed same match, cash kept ($${myBiz.cash})`);
  await A.wait(S2C.PLAYER_RECONNECTED);
  ok(true, 'A notified: opponent reconnected');

  // Timer end → same result for both
  A.send({ t: C2S.DEV, cmd: 'speedTimer', arg: 1500 });
  const ra = await A.wait(S2C.MATCH_END, undefined, 6000);
  const rb = await B2.wait(S2C.MATCH_END, undefined, 6000);
  ok(JSON.stringify(ra.result.winnerIds) === JSON.stringify(rb.result.winnerIds), `same result on both: winner=${ra.result.winnerIds.join(',')}`);
  ok(ra.result.winnerIds[0] === A.playerId, 'A (richer business) wins by BUSINESS VALUE');

  // Actions frozen after end
  A.send({ t: C2S.BUY_UPGRADE, id: 'capacity' });
  await A.wait(S2C.ERROR, (m) => m.code === 'NOT_PLAYING');
  ok(true, 'purchases frozen after match end');

  // Rematch
  A.send({ t: C2S.REMATCH });
  B2.send({ t: C2S.REMATCH });
  const rc = await A.wait(S2C.MATCH_COUNTDOWN, (m) => m.startAt > Date.now());
  ok(rc.startAt > Date.now(), 'REMATCH by both → new countdown in same room');
  const st = await B2.wait(S2C.ROOM_STATE, (m) => m.room.status === 'countdown');
  ok(st.room.businesses.every((b) => b.cash === 100 && b.tier === 1), 'rematch resets match state (money not carried over)');

  // Forfeit: leaving during VS = defeat
  await A.wait(S2C.ROOM_STATE, (m) => m.room.status === 'playing', 6000);
  B2.send({ t: C2S.LEAVE });
  const ff = await A.wait(S2C.MATCH_END);
  ok(ff.result.reason === 'forfeit' && ff.result.winnerIds[0] === A.playerId, 'LEAVE during VS → forfeit, A wins');

  // Quick match FIFO
  const C = new TestClient('C'), D = new TestClient('D');
  await C.connect(); await D.connect(); await C.hello('Carl'); await D.hello('Dina');
  C.send({ t: C2S.QUICK_MATCH });
  await C.wait(S2C.QUEUE_STATUS, (m) => m.searching);
  D.send({ t: C2S.QUICK_MATCH });
  const qc = await C.wait(S2C.ROOM_JOINED);
  const qd = await D.wait(S2C.ROOM_JOINED);
  ok(qc.room.code === qd.room.code, `quick match paired C+D in ${qc.room.code}`);

  // CO-OP: shared business
  const E = new TestClient('E'), F = new TestClient('F');
  await E.connect(); await F.connect(); await E.hello('Eva'); await F.hello('Fil');
  E.send({ t: C2S.CREATE_ROOM, mode: 'coop' });
  const je = await E.wait(S2C.ROOM_JOINED);
  F.send({ t: C2S.JOIN_ROOM, code: je.room.code });
  await F.wait(S2C.ROOM_JOINED);
  E.send({ t: C2S.PLAYER_READY, ready: true }); F.send({ t: C2S.PLAYER_READY, ready: true });
  await E.wait(S2C.ROOM_STATE, (m) => m.room.players.every((p) => p.ready));
  F.send({ t: C2S.START_MATCH });
  const cs = await E.wait(S2C.ROOM_STATE, (m) => m.room.status === 'countdown');
  ok(cs.room.businesses.length === 1 && cs.room.businesses[0].ownerIds.length === 2, 'CO-OP: one shared business, two owners');

  // Rate limit
  for (let i = 0; i < 40; i++) C.send({ t: C2S.EMOTE, e: 0 });
  await C.wait(S2C.ERROR, (m) => m.code === 'RATE_LIMITED');
  ok(true, 'emote spam rate-limited');

  console.log(`\nALL ${passed} CHECKS PASSED`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
