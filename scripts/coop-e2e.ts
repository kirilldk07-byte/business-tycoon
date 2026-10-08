// CO-OP flow test: shared business, DELIVERY crates, POWER FAILURE switches
// (needs both players), distance validation, MEGA MALL win.
//   WS_URL=ws://<ip>:3040/ws npx tsx scripts/coop-e2e.ts   (server with DEV_TOOLS=1)
import WebSocket from 'ws';
import { PLOT_LOCAL, POWER_SWITCHES, plotToWorld } from '../shared/constants/world';
import { C2S, PROTOCOL_VERSION, S2C, type ClientMsg, type MoveTuple, type ServerMsg } from '../shared/protocol/messages';

const URL = process.env.WS_URL ?? 'ws://localhost:3040/ws';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (c: unknown, what: string) => { if (!c) { console.error(`  ✗ ${what}`); process.exit(1); } passed++; console.log(`  ✓ ${what}`); };

class C {
  ws!: WebSocket; msgs: ServerMsg[] = []; id = ''; pos: MoveTuple = [0, 0, 0, 0, 0]; seq = 0;
  async connect(name: string) {
    this.ws = new WebSocket(URL);
    await new Promise((r) => this.ws.on('open', r));
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMsg;
      this.msgs.push(m);
      if (m.t === S2C.ROOM_JOINED) this.id = m.playerId;
      if (m.t === S2C.CORRECTION) this.pos = m.p;
    });
    this.send({ t: C2S.HELLO, v: PROTOCOL_VERSION, name });
    await this.wait(S2C.WELCOME);
  }
  send(m: ClientMsg) { this.ws.send(JSON.stringify(m)); }
  async wait<T extends ServerMsg['t']>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true, ms = 10000) {
    const s = Date.now();
    for (;;) {
      const i = this.msgs.findIndex((m) => m.t === t && pred(m as Extract<ServerMsg, { t: T }>));
      if (i >= 0) return this.msgs.splice(i, 1)[0] as Extract<ServerMsg, { t: T }>;
      if (Date.now() - s > ms) throw new Error(`timeout ${t}`);
      await sleep(20);
    }
  }
  /** Walk at legal speed (≈6 m/s) to a point. */
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
  console.log(`CO-OP E2E against ${URL}`);
  const A = new C(), B = new C();
  await A.connect('CoopA'); await B.connect('CoopB');
  A.send({ t: C2S.CREATE_ROOM, mode: 'coop' });
  const ja = await A.wait(S2C.ROOM_JOINED);
  B.send({ t: C2S.JOIN_ROOM, code: ja.room.code });
  await B.wait(S2C.ROOM_JOINED);
  A.send({ t: C2S.PLAYER_READY, ready: true }); B.send({ t: C2S.PLAYER_READY, ready: true });
  await A.wait(S2C.ROOM_STATE, (m) => m.room.players.every((p) => p.ready));
  A.send({ t: C2S.START_MATCH });
  const st = await A.wait(S2C.ROOM_STATE, (m) => m.room.status === 'playing', 8000);
  for (const c of [A, B]) {
    const me = st.room.players.find((p) => p.id === c.id)!;
    void me;
  }
  const snap = await A.wait(S2C.SNAPSHOT);
  for (const c of [A, B]) { const e = snap.p.find((p) => p[0] === c.id)!; c.pos = [e[1], e[2], e[3], e[4], 0]; }
  ok(true, 'co-op match started');

  // Shared economy: A opens the kiosk, B spends from the same shared cash
  A.send({ t: C2S.BUILD_BUSINESS, kind: 'tier' });
  await B.wait(S2C.BUSINESS_UPDATE, (m) => m.cause === 'tier');
  A.send({ t: C2S.DEV, cmd: 'addMoney', arg: 100 });
  await A.wait(S2C.BUSINESS_UPDATE, (m) => m.cause === 'dev');
  B.send({ t: C2S.BUY_UPGRADE, id: 'capacity' });
  const up = await A.wait(S2C.BUSINESS_UPDATE, (m) => m.cause === 'upgrade:capacity');
  ok(up.by === B.id && up.b.id === 0, 'B upgrades the SHARED business, A sees it');

  // Manual interaction with distance validation
  A.send({ t: C2S.INTERACT, target: { kind: 'machine', biz: 0 } });
  await A.wait(S2C.ERROR, (m) => m.code === 'TOO_FAR');
  ok(true, 'interaction from far away rejected (TOO_FAR)');
  const mach = plotToWorld(0, PLOT_LOCAL.machine.lx + 2, PLOT_LOCAL.machine.lz);
  await A.walkTo(mach.x, mach.z);
  A.msgs = [];
  A.send({ t: C2S.INTERACT, target: { kind: 'machine', biz: 0 } });
  await sleep(400);
  ok(!A.msgs.some((m) => m.t === S2C.ERROR), 'A produces stock at the machine when near');

  // DELIVERY: unload all crates
  A.send({ t: C2S.DEV, cmd: 'triggerEvent', arg: 1 });
  const ev = await A.wait(S2C.EVENT_STATE, (m) => m.event?.kind === 'delivery');
  ok(ev.event!.crates![0].length === 6, 'DELIVERY ARRIVED: 6 crates at the shared business');
  const crates = PLOT_LOCAL.crates.map((c) => plotToWorld(0, c.lx, c.lz));
  // Split crates between the two players
  const jobs = [A, B].map(async (c, k) => {
    for (let i = k; i < crates.length; i += 2) {
      await c.walkTo(crates[i].x + 1, crates[i].z);
      c.send({ t: C2S.INTERACT, target: { kind: 'crate', index: i } });
      await sleep(150);
    }
  });
  await Promise.all(jobs);
  const done = await A.wait(S2C.EVENT_STATE, (m) => m.event === null, 15000);
  ok(done.outcome === 'success', 'both players unloaded crates → event success');

  // POWER FAILURE: needs both switches within window
  A.send({ t: C2S.DEV, cmd: 'triggerEvent', arg: 2 });
  await A.wait(S2C.EVENT_STATE, (m) => m.event?.kind === 'power');
  A.send({ t: C2S.INTERACT, target: { kind: 'counter', biz: 0 } });
  const s0 = POWER_SWITCHES[0], s1 = POWER_SWITCHES[1];
  await Promise.all([A.walkTo(s0.x + 1, s0.z), B.walkTo(s1.x, s1.z - 1)]);
  A.send({ t: C2S.INTERACT, target: { kind: 'switch', id: 0 } });
  const half = await A.wait(S2C.EVENT_STATE, (m) => m.event?.kind === 'power' && (m.event.switches?.[0] ?? 0) > 0);
  ok(half.event!.switches![1] === 0, 'one switch alone does not restore power');
  B.send({ t: C2S.INTERACT, target: { kind: 'switch', id: 1 } });
  const pw = await A.wait(S2C.EVENT_STATE, (m) => m.event === null);
  ok(pw.outcome === 'success', 'POWER FAILURE fixed by two players together');

  // Mega Mall: requirements enforced
  A.send({ t: C2S.BUILD_MEGA_MALL });
  await A.wait(S2C.ERROR, (m) => m.code === 'LOCKED');
  ok(true, 'MEGA MALL locked until requirements met');
  A.send({ t: C2S.DEV, cmd: 'addMoney', arg: 20_000_000 });
  await A.wait(S2C.BUSINESS_UPDATE, (m) => m.cause === 'dev');
  for (let i = 0; i < 9; i++) A.send({ t: C2S.BUILD_BUSINESS, kind: 'tier' });
  for (const id of ['price', 'customers', 'capacity'] as const) for (let i = 0; i < 4; i++) B.send({ t: C2S.BUY_UPGRADE, id });
  await sleep(1500);
  B.send({ t: C2S.BUILD_MEGA_MALL });
  const end = await A.wait(S2C.MATCH_END);
  ok(end.result.reason === 'goal' && end.result.winnerIds.length === 2, 'MEGA MALL built → both players win');
  console.log(`\nALL ${passed} CO-OP CHECKS PASSED`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
