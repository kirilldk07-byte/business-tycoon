// Anti-cheat / security + VS event fairness checks.
//   WS_URL=ws://<ip>:3041/ws [PROD_WS_URL=ws://<ip>:3040/ws] npx tsx scripts/security-e2e.ts
import WebSocket from 'ws';
import { PLOT_LOCAL, plotToWorld } from '../shared/constants/world';
import { C2S, PROTOCOL_VERSION, S2C, type ClientMsg, type MoveTuple, type ServerMsg } from '../shared/protocol/messages';

const URL = process.env.WS_URL ?? 'ws://localhost:3041/ws';
const PROD = process.env.PROD_WS_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (c: unknown, what: string) => { if (!c) { console.error(`  ✗ ${what}`); process.exit(1); } passed++; console.log(`  ✓ ${what}`); };

class C {
  ws!: WebSocket; msgs: ServerMsg[] = []; id = ''; token = ''; profileId = ''; secret = ''; pos: MoveTuple = [0, 0, 0, 0, 0]; seq = 0;
  constructor(private url = URL) {}
  async connect(name: string, profileId?: string, secret?: string) {
    this.ws = new WebSocket(this.url);
    await new Promise((r) => this.ws.on('open', r));
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMsg;
      this.msgs.push(m);
      if (m.t === S2C.ROOM_JOINED) { this.id = m.playerId; this.token = m.token; }
      if (m.t === S2C.WELCOME) { this.profileId = m.profile.id; this.secret = m.secret; }
      if (m.t === S2C.CORRECTION) this.pos = m.p;
    });
    this.send({ t: C2S.HELLO, v: PROTOCOL_VERSION, name, profileId, secret });
    await this.wait(S2C.WELCOME);
  }
  send(m: ClientMsg) { this.ws.send(JSON.stringify(m)); }
  raw(o: object) { this.ws.send(JSON.stringify(o)); }
  async wait<T extends ServerMsg['t']>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true, ms = 8000) {
    const s = Date.now();
    for (;;) {
      const i = this.msgs.findIndex((m) => m.t === t && pred(m as Extract<ServerMsg, { t: T }>));
      if (i >= 0) return this.msgs.splice(i, 1)[0] as Extract<ServerMsg, { t: T }>;
      if (Date.now() - s > ms) throw new Error(`timeout ${t}`);
      await sleep(20);
    }
  }
  async walkTo(x: number, z: number) {
    for (;;) {
      const dx = x - this.pos[0], dz = z - this.pos[2], d = Math.hypot(dx, dz);
      if (d < 0.3) return;
      const s = Math.min(d, 0.4);
      this.pos = [this.pos[0] + (dx / d) * s, 0, this.pos[2] + (dz / d) * s, 0, 1];
      this.send({ t: C2S.PLAYER_MOVE, p: this.pos, seq: this.seq++ });
      await sleep(66);
    }
  }
}

async function main() {
  console.log(`SECURITY + FAIRNESS E2E against ${URL}`);
  const A = new C(), B = new C();
  await A.connect('SecA'); await B.connect('SecB');
  A.send({ t: C2S.CREATE_ROOM, mode: 'vs' });
  const ja = await A.wait(S2C.ROOM_JOINED);
  const code = ja.room.code;
  B.send({ t: C2S.JOIN_ROOM, code });
  await B.wait(S2C.ROOM_JOINED);

  // Room capacity
  const X = new C();
  await X.connect('Intruder');
  X.send({ t: C2S.JOIN_ROOM, code });
  await X.wait(S2C.ERROR, (m) => m.code === 'ROOM_FULL');
  ok(true, '3rd player cannot join a full room (ROOM_FULL)');

  // Session hijack: stealing B's token with another profile
  X.send({ t: C2S.RESUME, token: B.token });
  const hj = await X.wait(S2C.ERROR, (m) => m.code === 'BAD_TOKEN');
  ok(/Чужая/.test(hj.msg), 'stolen session token from another profile rejected');

  // Start match
  A.send({ t: C2S.PLAYER_READY, ready: true }); B.send({ t: C2S.PLAYER_READY, ready: true });
  await A.wait(S2C.ROOM_STATE, (m) => m.room.players.every((p) => p.ready));
  A.send({ t: C2S.START_MATCH });
  const st = await A.wait(S2C.ROOM_STATE, (m) => m.room.status === 'playing', 8000);
  const snap = await A.wait(S2C.SNAPSHOT);
  for (const c of [A, B]) { const e = snap.p.find((p) => p[0] === c.id)!; c.pos = [e[1], e[2], e[3], e[4], 0]; }
  const bizA = st.room.businesses.find((b) => b.ownerIds.includes(A.id))!;
  const bizB = st.room.businesses.find((b) => b.ownerIds.includes(B.id))!;

  // Joining a room with a running match
  X.send({ t: C2S.JOIN_ROOM, code });
  await X.wait(S2C.ERROR, (m) => m.code === 'ROOM_IN_PROGRESS' || m.code === 'ROOM_FULL');
  ok(true, 'cannot join a room with a match in progress');

  // Replay / double purchase: cash for exactly one kiosk ($50 of $100) then for exactly one upgrade
  for (let i = 0; i < 5; i++) A.send({ t: C2S.BUILD_BUSINESS, kind: 'tier' });
  await sleep(600);
  A.msgs = A.msgs.filter((m) => m.t !== S2C.BUSINESS_UPDATE);
  A.send({ t: C2S.DEV, cmd: 'addMoney', arg: 50 });
  const afterDev = await A.wait(S2C.BUSINESS_UPDATE, (m) => m.cause === 'dev');
  ok(afterDev.b.tier === 1 && afterDev.b.cash === 100, '5× replayed tier purchase → only ONE applied (kiosk; HQ2 costs $400)');
  for (let i = 0; i < 6; i++) A.send({ t: C2S.BUY_UPGRADE, id: 'price' });
  await sleep(700);
  A.send({ t: C2S.DEV, cmd: 'addMoney', arg: 0 });
  const afterUp = await A.wait(S2C.BUSINESS_UPDATE, (m) => m.cause === 'dev');
  ok(afterUp.b.upgrades.price === 1 && afterUp.b.cash === 0, '6× replayed upgrade with cash for one → exactly one level');

  // Client-sent money fields / fake ids
  A.raw({ t: 'BUY_UPGRADE', id: 'price', cost: 0, cash: 1e9 });
  await A.wait(S2C.ERROR, (m) => m.code === 'NOT_ENOUGH_MONEY');
  ok(true, 'extra "cost"/"cash" fields ignored — still NOT_ENOUGH_MONEY');
  A.raw({ t: 'BUILD_BUSINESS', kind: 'venue', id: 'casino' });
  await A.wait(S2C.ERROR, (m) => m.code === 'BAD_MESSAGE');
  ok(true, 'unknown venue id rejected');
  A.raw({ t: 'GIVE_MONEY', amount: 1e9 });
  await A.wait(S2C.ERROR, (m) => m.code === 'BAD_MESSAGE');
  ok(true, 'unknown message type rejected');

  // Opponent's business
  const oppCounter = plotToWorld(bizB.plot, PLOT_LOCAL.counter.lx, PLOT_LOCAL.counter.lz);
  A.send({ t: C2S.INTERACT, target: { kind: 'counter', biz: bizB.id } });
  await A.wait(S2C.ERROR, (m) => m.code === 'NOT_ALLOWED');
  ok(true, "cannot serve at the opponent's counter (not your business)");
  void oppCounter;
  const aBefore = afterUp.b.cash;
  B.send({ t: C2S.BUILD_BUSINESS, kind: 'tier' });
  await B.wait(S2C.BUSINESS_UPDATE, (m) => m.cause === 'tier');
  B.send({ t: C2S.DEV, cmd: 'addMoney', arg: 5000 });
  await B.wait(S2C.BUSINESS_UPDATE, (m) => m.cause === 'dev');
  A.send({ t: C2S.BUILD_BUSINESS, kind: 'venue', id: 'burger' });
  await A.wait(S2C.ERROR, (m) => m.code === 'NOT_ENOUGH_MONEY');
  ok(aBefore === 0, "opponent's money is never usable: purchases always charge YOUR business");

  // Fair VS events: Big Delivery → both businesses get the same crates
  A.send({ t: C2S.DEV, cmd: 'triggerEvent', arg: 3 }); // VS_EVENTS[3] = delivery
  const ev = await B.wait(S2C.EVENT_STATE, (m) => m.event?.kind === 'delivery');
  ok(ev.event!.crates![bizA.id].length === 6 && ev.event!.crates![bizB.id].length === 6, 'BIG DELIVERY: identical 6 crates for each player');
  // A tries to steal a crate that belongs to B's plot
  const theirCrate = plotToWorld(bizB.plot, PLOT_LOCAL.crates[0].lx, PLOT_LOCAL.crates[0].lz);
  void theirCrate;
  A.send({ t: C2S.INTERACT, target: { kind: 'crate', index: 0 } });
  await A.wait(S2C.ERROR, (m) => m.code === 'TOO_FAR');
  ok(true, 'crates are validated by distance to YOUR plot (no remote looting)');
  // finish the event, then VIP
  await sleep(300);
  A.send({ t: C2S.DEV, cmd: 'triggerEvent', arg: 2 }); // vip (replaces current event)
  const vip = await A.wait(S2C.EVENT_STATE, (m) => m.event?.kind === 'vip');
  const spawns = { [bizA.id]: 0, [bizB.id]: 0 } as Record<number, number>;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    for (const m of A.msgs) if (m.t === S2C.CUSTOMERS && m.sp) for (let i = 0; i + 4 < m.sp.length; i += 5) if (m.sp[i + 2] === 2) spawns[m.b]++;
    if (spawns[bizA.id] && spawns[bizB.id]) break;
    await sleep(50);
  }
  ok(spawns[bizA.id] === 1 && spawns[bizB.id] === 1 && (vip.event!.reward ?? 0) > 0, `VIP: one VIP per player, same flat reward $${vip.event!.reward}`);

  // Rewarded-ad boosts are impossible in VS (pay-to-win protection)
  A.send({ t: 'AD_BOOST' } as never);
  await A.wait(S2C.ERROR, (m) => m.code === 'NOT_ALLOWED');
  A.send({ t: C2S.AD_REWARD });
  await A.wait(S2C.ERROR, (m) => m.code === 'NOT_ALLOWED');
  ok(true, 'rewarded ads give NO bonus inside a VS match (AD_BOOST/AD_REWARD rejected)');

  // Spam protection on actions
  for (let i = 0; i < 60; i++) A.send({ t: C2S.BUY_UPGRADE, id: 'capacity' });
  await A.wait(S2C.ERROR, (m) => m.code === 'RATE_LIMITED');
  ok(true, 'purchase spam rate-limited');
  await sleep(2500); // let the action bucket refill before the next checks
  A.msgs = [];

  // Reconnect restores state (money/buildings) for the right player only
  const beforeDrop = (await B.wait(S2C.ECONOMY)).b.find((b) => b.id === bizB.id)!;
  B.ws.terminate();
  await A.wait(S2C.PLAYER_DISCONNECTED);
  const B2 = new C();
  await B2.connect('SecB', B.profileId, B.secret);
  B2.send({ t: C2S.RESUME, token: B.token });
  const res = await B2.wait(S2C.ROOM_JOINED);
  const restored = res.room.businesses.find((b) => b.id === bizB.id)!;
  ok(res.playerId === B.id && restored.cash >= beforeDrop.cash && restored.tier === 1, 'reconnect: same player, same business state restored');

  // After MATCH_END everything is frozen
  A.send({ t: C2S.DEV, cmd: 'endMatch' });
  await A.wait(S2C.MATCH_END);
  A.send({ t: C2S.BUILD_BUSINESS, kind: 'tier' });
  await A.wait(S2C.ERROR, (m) => m.code === 'NOT_PLAYING');
  A.send({ t: C2S.INTERACT, target: { kind: 'machine', biz: bizA.id } });
  await A.wait(S2C.ERROR, (m) => m.code === 'NOT_PLAYING');
  ok(true, 'purchases and interactions rejected after MATCH_END');

  if (PROD) {
    const P = new C(PROD);
    await P.connect('ProdCheck');
    P.send({ t: C2S.CREATE_ROOM, mode: 'vs' });
    await P.wait(S2C.ROOM_JOINED);
    P.send({ t: C2S.DEV, cmd: 'addMoney', arg: 1e9 });
    await P.wait(S2C.ERROR, (m) => m.code === 'DEV_DISABLED');
    ok(true, 'PRODUCTION server rejects dev commands (DEV_DISABLED)');
    P.send({ t: C2S.LEAVE });
  }
  console.log(`\nALL ${passed} SECURITY/FAIRNESS CHECKS PASSED`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
