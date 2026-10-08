import {
  COOP_GOAL, EVENTS, MATCH, PLAYER, STRUCTURES, TIERS, UPGRADES, WORKERS,
  type CosmeticId, type StructureId, type UpgradeId, type WorkerId,
} from '../../shared/constants/config';
import { PLOT_LOCAL, PLOTS, POWER_SWITCHES, WORLD_BOUNDS, plotToWorld } from '../../shared/constants/world';
import { COOP_EVENTS, SOLO_EVENTS, VS_EVENTS } from '../../shared/events';
import {
  checkStructure, checkTier, checkUpgrade, checkWorker, computeRates, emptyBusiness, megaMallMissing, NO_MODS, type Modifiers,
} from '../../shared/game/economy';
import { q2 } from '../../shared/protocol/codec';
import {
  ERR, S2C, type DevCmd, type ErrCode, type InteractTarget, type MoveTuple, type ServerMsg,
} from '../../shared/protocol/messages';
import type {
  ActiveEvent, ActiveEventKind, BusinessState, GameMode, MatchResult, MatchStatus, PlayerPublic, RoomSnapshot,
} from '../../shared/types/state';
import { BusinessSim, type SimEmitter } from '../game/BusinessSim';
import { randomToken } from '../persistence/storage';

export interface Conn {
  readonly id: string;
  send(msg: ServerMsg): void;
  /** Pre-serialized send (used for broadcasts so we stringify once). */
  sendRaw(raw: string): void;
  terminate(): void;
}

export interface PlayerSlot {
  id: string;
  token: string;
  profileId: string;
  name: string;
  slot: number;
  hat: CosmeticId;
  ready: boolean;
  rematch: boolean;
  conn: Conn | null;
  graceUntil: number;
  ping: number;
  pos: MoveTuple;
  lastMoveAt: number;
  cdServe: number;
  cdProduce: number;
}

export interface RoomHooks {
  onMatchEnd(room: Room, result: MatchResult): void;
  log(msg: string): void;
}

const COLORS = [0x3b82f6, 0xf97316, 0x22c55e, 0xa855f7];
const fail = (code: ErrCode, msg: string) => ({ ok: false as const, code, msg });
type Result = { ok: true } | { ok: false; code: ErrCode; msg: string };
const OK: Result = { ok: true };

export class Room {
  readonly roomId = 'r_' + randomToken(6);
  players = new Map<string, PlayerSlot>();
  status: MatchStatus = 'lobby';
  countdownEndsAt = 0;
  startTime = 0;
  endTime = 0;
  serverTick = 0;
  businesses: BusinessSim[] = [];
  event: ActiveEvent | null = null;
  nextEventAt = 0;
  result: MatchResult | null = null;
  megaMallBuilt = false;
  lastActivity = Date.now();
  private customerSeq = 1;
  private lastStep = Date.now();

  constructor(
    public code: string,
    public mode: GameMode,
    public isPrivate: boolean,
    private hooks: RoomHooks,
    private devTools: boolean,
  ) {}

  get maxPlayers() { return MATCH.maxPlayers[this.mode]; }
  get connectedCount() { return [...this.players.values()].filter((p) => p.conn).length; }
  get isFull() { return this.players.size >= this.maxPlayers; }
  get hostId() { return [...this.players.values()].sort((a, b) => a.slot - b.slot)[0]?.id; }

  // ---------- membership ----------

  addPlayer(conn: Conn, profileId: string, name: string, hat: CosmeticId): PlayerSlot {
    const used = new Set([...this.players.values()].map((p) => p.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const p: PlayerSlot = {
      id: 'pl_' + randomToken(5), token: randomToken(24), profileId, name, slot, hat,
      ready: false, rematch: false, conn, graceUntil: 0, ping: 0,
      pos: this.spawnPos(slot), lastMoveAt: Date.now(), cdServe: 0, cdProduce: 0,
    };
    this.players.set(p.id, p);
    this.touch();
    this.hooks.log(`room ${this.code}: + ${name} (${p.id}) slot ${slot}`);
    this.broadcastState();
    return p;
  }

  /** Reattach a reconnecting player using their session token. */
  resume(p: PlayerSlot, conn: Conn) {
    const old = p.conn;
    p.conn = conn;
    p.graceUntil = 0;
    if (old && old.id !== conn.id) old.terminate();
    this.touch();
    this.hooks.log(`room ${this.code}: ${p.name} reconnected`);
    this.broadcast({ t: S2C.PLAYER_RECONNECTED, id: p.id });
    this.broadcastState();
  }

  /** Socket dropped — start grace period instead of ending the match. */
  onDisconnect(p: PlayerSlot) {
    if (!p.conn) return;
    p.conn = null;
    const now = Date.now();
    if (this.status === 'lobby' || (this.status === 'ended' && this.mode !== 'solo')) {
      // No match running: short grace so a page refresh still works.
      p.graceUntil = now + 15_000;
    } else {
      p.graceUntil = now + MATCH.reconnectGraceMs;
    }
    p.ready = false;
    this.hooks.log(`room ${this.code}: ${p.name} disconnected, grace until +${p.graceUntil - now}ms`);
    this.broadcast({ t: S2C.PLAYER_DISCONNECTED, id: p.id, graceUntil: p.graceUntil });
    this.broadcastState();
  }

  /** Intentional leave. During a VS match that is a forfeit. */
  leave(p: PlayerSlot, reason: 'leave' | 'timeout') {
    if ((this.status === 'playing' || this.status === 'countdown') && this.mode === 'vs') {
      const winners = [...this.players.values()].filter((o) => o.id !== p.id).map((o) => o.id);
      this.endMatch(reason === 'leave' ? 'forfeit' : 'disconnect', winners);
    }
    this.players.delete(p.id);
    if (p.conn) p.conn.send({ t: S2C.ROOM_LEFT, reason });
    p.conn = null;
    this.hooks.log(`room ${this.code}: - ${p.name} (${reason})`);
    if (this.status === 'playing' && this.mode !== 'vs' && this.connectedCount === 0 && this.players.size === 0) {
      this.endMatch('disconnect', []);
    }
    if (this.status === 'ended' || this.status === 'countdown') {
      // Back to lobby so the remaining player can invite someone else.
      if (this.status === 'countdown') this.status = 'lobby';
      for (const o of this.players.values()) o.rematch = false;
    }
    if (this.status === 'ended' && this.players.size < this.maxPlayers) this.status = 'lobby';
    for (const o of this.players.values()) o.ready = false;
    this.touch();
    this.broadcastState();
  }

  // ---------- lobby ----------

  setMode(p: PlayerSlot, mode: GameMode): Result {
    if (this.status !== 'lobby') return fail(ERR.NOT_ALLOWED, 'Режим меняется только в лобби');
    if (p.id !== this.hostId) return fail(ERR.NOT_ALLOWED, 'Режим выбирает создатель комнаты');
    this.mode = mode;
    for (const o of this.players.values()) o.ready = false;
    this.broadcastState();
    return OK;
  }

  setReady(p: PlayerSlot, ready: boolean): Result {
    if (this.status !== 'lobby') return fail(ERR.NOT_ALLOWED, 'Матч уже идёт');
    p.ready = ready;
    this.touch();
    this.broadcastState();
    return OK;
  }

  canStart(): boolean {
    const ps = [...this.players.values()];
    return this.status === 'lobby' && ps.length === this.maxPlayers && ps.every((p) => p.ready && p.conn);
  }

  start(): Result {
    if (!this.canStart()) return fail(ERR.NOT_READY, 'Нужны все игроки в статусе READY');
    this.beginCountdown();
    return OK;
  }

  rematch(p: PlayerSlot): Result {
    if (this.status !== 'ended') return fail(ERR.NOT_ALLOWED, 'Матч ещё не окончен');
    p.rematch = true;
    this.broadcastState();
    const ps = [...this.players.values()];
    if (ps.length === this.maxPlayers && ps.every((o) => o.rematch && o.conn)) this.beginCountdown();
    return OK;
  }

  // ---------- match lifecycle ----------

  private beginCountdown() {
    const now = Date.now();
    this.status = 'countdown';
    this.result = null;
    this.megaMallBuilt = false;
    this.event = null;
    this.countdownEndsAt = now + MATCH.countdownMs;
    this.startTime = this.countdownEndsAt;
    this.endTime = this.startTime + MATCH.durationMs[this.mode];
    this.nextEventAt = this.startTime + EVENTS.firstDelayMs;
    this.serverTick = 0;
    this.customerSeq = 1;
    const ps = [...this.players.values()];
    // VS: one business per player. CO-OP/solo: one shared business.
    if (this.mode === 'vs') {
      this.businesses = ps.sort((a, b) => a.slot - b.slot).map((p, i) => this.makeSim(i, p.slot, [p.id]));
    } else {
      this.businesses = [this.makeSim(0, 0, ps.map((p) => p.id))];
    }
    for (const p of ps) {
      p.ready = false;
      p.rematch = false;
      p.pos = this.spawnPos(p.slot);
      p.lastMoveAt = now;
    }
    this.hooks.log(`room ${this.code}: countdown (${this.mode}), start ${new Date(this.startTime).toISOString()}`);
    this.broadcastState();
    this.broadcast({ t: S2C.MATCH_COUNTDOWN, startAt: this.startTime, endAt: this.endTime, serverTime: now });
  }

  private makeSim(id: number, plot: number, owners: string[]) {
    return new BusinessSim(emptyBusiness(id, plot, owners, MATCH.startCash), () => this.customerSeq++);
  }

  /** Called by RoomManager at MATCH.serverTickHz. */
  step(now: number) {
    const dt = Math.min(500, now - this.lastStep);
    this.lastStep = now;
    this.checkGrace(now);
    if (this.status === 'countdown' && now >= this.startTime) {
      this.status = 'playing';
      this.broadcastState();
    }
    if (this.status !== 'playing') return;
    this.serverTick++;
    const mods = this.mods();
    for (const sim of this.businesses) sim.step(dt, now, mods, this.emitter);
    this.updateEvents(now);
    if (now >= this.endTime) this.finishByTime();
  }

  private checkGrace(now: number) {
    for (const p of [...this.players.values()]) {
      if (!p.conn && p.graceUntil && now > p.graceUntil) {
        this.hooks.log(`room ${this.code}: ${p.name} reconnect grace expired`);
        this.leave(p, 'timeout');
      }
    }
  }

  private finishByTime() {
    if (this.mode === 'vs') {
      const sorted = [...this.businesses].sort((a, b) => b.b.value - a.b.value);
      const winners = sorted.length > 1 && sorted[0].b.value === sorted[1].b.value ? [] : sorted[0].b.ownerIds;
      this.endMatch('time', winners);
    } else {
      this.endMatch('time', []); // co-op ran out of time without the Mega Mall
    }
  }

  endMatch(reason: MatchResult['reason'], winnerIds: string[]) {
    if (this.status === 'ended' || this.status === 'lobby') return;
    this.status = 'ended';
    this.event = null;
    for (const s of this.businesses) s.refreshValue();
    const playerList = [...this.players.values()];
    const result: MatchResult = {
      winnerIds, reason, mode: this.mode,
      players: playerList.map((p) => {
        const biz = this.bizFor(p);
        return { id: p.id, name: p.name, value: biz?.b.value ?? 0, businessId: biz?.b.id ?? 0 };
      }),
      businesses: this.businesses.map(({ b }) => ({
        id: b.id, value: b.value, customers: b.stats.customers, upgrades: b.stats.upgrades,
        buildings: b.stats.buildings, income: Math.floor(b.stats.income), tier: b.tier,
      })),
      rewards: {},
    };
    this.hooks.onMatchEnd(this, result); // fills rewards + persists profiles
    this.result = result;
    this.hooks.log(`room ${this.code}: match end (${reason}) winners=${winnerIds.join(',') || 'none'}`);
    this.broadcast({ t: S2C.MATCH_END, result });
    this.broadcastState();
  }

  // ---------- player actions (all validated here) ----------

  move(p: PlayerSlot, t: MoveTuple) {
    if (this.status !== 'playing' && this.status !== 'countdown' && this.status !== 'ended') return;
    const now = Date.now();
    // Cap the window so pausing then teleporting doesn't earn a huge allowance.
    const dt = Math.min(1, Math.max(0.016, (now - p.lastMoveAt) / 1000));
    p.lastMoveAt = now;
    let [x, y, z, rot, anim] = t;
    const frozen = this.status === 'countdown';
    const maxDist = frozen ? 0.5 : PLAYER.runSpeed * dt * 1.6 + 1.0;
    const dx = x - p.pos[0], dz = z - p.pos[2];
    const d = Math.hypot(dx, dz);
    let corrected = false;
    if (d > maxDist) {
      // Speed-hack / teleport guard: clamp to the max allowed step.
      x = p.pos[0] + (dx / d) * maxDist;
      z = p.pos[2] + (dz / d) * maxDist;
      corrected = d > maxDist + 2;
    }
    x = Math.max(WORLD_BOUNDS.minX, Math.min(WORLD_BOUNDS.maxX, x));
    z = Math.max(WORLD_BOUNDS.minZ, Math.min(WORLD_BOUNDS.maxZ, z));
    y = Math.max(0, Math.min(4, y));
    anim = Math.max(0, Math.min(5, Math.round(anim)));
    p.pos = [q2(x), q2(y), q2(z), q2(rot), anim];
    if (corrected) p.conn?.send({ t: S2C.CORRECTION, p: p.pos });
  }

  buyUpgrade(p: PlayerSlot, id: UpgradeId): Result {
    const sim = this.actionBiz(p);
    if (!sim) return fail(ERR.NOT_PLAYING, 'Матч не идёт');
    const c = checkUpgrade(sim.b, id);
    if (!c.ok) return this.purchaseFail(c.code);
    sim.spend(c.cost, 'spentUpgrade');
    sim.b.upgrades[id]++;
    sim.b.stats.upgrades++;
    this.bizUpdate(sim, `upgrade:${id}`, p.id);
    p.conn?.send({ t: S2C.TOAST, text: `${UPGRADES[id].icon} ${UPGRADES[id].name} → ур. ${sim.b.upgrades[id]}`, kind: 'good' });
    return OK;
  }

  hireWorker(p: PlayerSlot, id: WorkerId): Result {
    const sim = this.actionBiz(p);
    if (!sim) return fail(ERR.NOT_PLAYING, 'Матч не идёт');
    const c = checkWorker(sim.b, id);
    if (!c.ok) return this.purchaseFail(c.code);
    sim.spend(c.cost, 'spentWorker');
    sim.b.workers[id]++;
    this.bizUpdate(sim, `hire:${id}`, p.id);
    p.conn?.send({ t: S2C.TOAST, text: `${WORKERS[id].icon} Нанят ${WORKERS[id].name}`, kind: 'good' });
    return OK;
  }

  build(p: PlayerSlot, kind: 'tier' | 'structure', id?: StructureId): Result {
    const sim = this.actionBiz(p);
    if (!sim) return fail(ERR.NOT_PLAYING, 'Матч не идёт');
    if (kind === 'tier') {
      const c = checkTier(sim.b);
      if (!c.ok) return this.purchaseFail(c.code);
      sim.spend(c.cost, 'spentBuilding');
      sim.b.tier++;
      sim.b.stats.buildings++;
      this.bizUpdate(sim, 'tier', p.id);
      p.conn?.send({ t: S2C.TOAST, text: `🏗️ ${TIERS[sim.b.tier - 1].name}!`, kind: 'good' });
      return OK;
    }
    const c = checkStructure(sim.b, id!);
    if (!c.ok) return this.purchaseFail(c.code);
    sim.spend(c.cost, 'spentStructure');
    sim.b.structures.push(id!);
    sim.b.stats.buildings++;
    this.bizUpdate(sim, `structure:${id}`, p.id);
    p.conn?.send({ t: S2C.TOAST, text: `${STRUCTURES[id!].icon} ${STRUCTURES[id!].name} построен!`, kind: 'good' });
    return OK;
  }

  buildMegaMall(p: PlayerSlot): Result {
    if (this.mode === 'vs') return fail(ERR.NOT_ALLOWED, 'Только в CO-OP');
    const sim = this.actionBiz(p);
    if (!sim) return fail(ERR.NOT_PLAYING, 'Матч не идёт');
    const missing = megaMallMissing(sim.b);
    if (missing.length) return fail(ERR.LOCKED, 'Не хватает: ' + missing.join(', '));
    sim.spend(COOP_GOAL.cost, 'spentBuilding');
    sim.b.stats.buildings++;
    this.megaMallBuilt = true;
    this.bizUpdate(sim, 'megamall', p.id);
    this.endMatch('goal', [...this.players.keys()]);
    return OK;
  }

  interact(p: PlayerSlot, target: InteractTarget): Result {
    if (this.status !== 'playing') return fail(ERR.NOT_PLAYING, 'Матч не идёт');
    const now = Date.now();
    const mods = this.mods();
    if (target.kind === 'counter' || target.kind === 'machine') {
      const sim = this.businesses.find((s) => s.b.id === target.biz);
      if (!sim || !sim.b.ownerIds.includes(p.id)) return fail(ERR.NOT_ALLOWED, 'Это не твой бизнес');
      const loc = target.kind === 'counter' ? PLOT_LOCAL.counter : PLOT_LOCAL.machine;
      if (!this.near(p, plotToWorld(sim.b.plot, loc.lx, loc.lz))) return fail(ERR.TOO_FAR, 'Подойди ближе');
      if (mods.halted) return fail(ERR.LOCKED, 'Нет электричества!');
      if (target.kind === 'counter') {
        if (now < p.cdServe) return OK;
        p.cdServe = now + 250;
        if (!sim.manualServe(mods, this.emitter, p.id)) {
          p.conn?.send({ t: S2C.TOAST, text: sim.b.stock < 1 ? 'Нет товара — произведи у машины!' : 'Нет клиентов в очереди', kind: 'info' });
        }
      } else {
        if (now < p.cdProduce) return OK;
        p.cdProduce = now + 300;
        sim.manualProduce(mods);
      }
      return OK;
    }
    const ev = this.event;
    if (target.kind === 'crate') {
      if (ev?.kind !== 'delivery' || !ev.crates?.includes(target.index)) return fail(ERR.NOT_ALLOWED, 'Ящика нет');
      const sim = this.businesses[0];
      const loc = PLOT_LOCAL.crates[target.index];
      if (!loc || !this.near(p, plotToWorld(sim.b.plot, loc.lx, loc.lz))) return fail(ERR.TOO_FAR, 'Подойди ближе');
      ev.crates = ev.crates.filter((c) => c !== target.index);
      if (ev.crates.length === 0) {
        const price = this.priceOf(sim);
        sim.b.stock += EVENTS.deliveryStock;
        sim.b.cash += price * EVENTS.deliveryCashPerPrice;
        sim.b.stats.income += price * EVENTS.deliveryCashPerPrice;
        this.endEvent('success');
      } else {
        this.broadcast({ t: S2C.EVENT_STATE, event: ev });
      }
      return OK;
    }
    if (target.kind === 'switch') {
      if (ev?.kind !== 'power' || !ev.switches) return fail(ERR.NOT_ALLOWED, 'Электричество в норме');
      const sw = POWER_SWITCHES[target.id];
      if (!sw || !this.near(p, sw)) return fail(ERR.TOO_FAR, 'Подойди ближе');
      ev.switches[target.id] = now;
      if (ev.switches.every((t) => t > 0 && now - t <= EVENTS.powerWindowMs)) this.endEvent('success');
      else this.broadcast({ t: S2C.EVENT_STATE, event: ev });
      return OK;
    }
    return fail(ERR.BAD_MESSAGE, 'Неизвестная цель');
  }

  emote(p: PlayerSlot, e: number) {
    this.broadcast({ t: S2C.EMOTE, id: p.id, e });
  }

  dev(p: PlayerSlot, cmd: DevCmd, arg?: number): Result {
    if (!this.devTools) return fail(ERR.DEV_DISABLED, 'Dev tools disabled');
    const sim = this.bizFor(p);
    switch (cmd) {
      case 'addMoney':
        if (!sim) return fail(ERR.NOT_PLAYING, 'no business');
        sim.b.cash += arg ?? 10_000;
        this.bizUpdate(sim, 'dev', p.id);
        break;
      case 'speedTimer':
        if (this.status === 'playing') this.endTime = Math.min(this.endTime, Date.now() + (arg ?? 15_000));
        this.broadcast({ t: S2C.MATCH_COUNTDOWN, startAt: this.startTime, endAt: this.endTime, serverTime: Date.now() });
        break;
      case 'buildTier':
        if (!sim || sim.b.tier >= TIERS.length) break;
        sim.b.tier++;
        sim.b.stats.buildings++;
        this.bizUpdate(sim, 'tier', p.id);
        break;
      case 'endMatch':
        if (this.status === 'playing') this.finishByTime();
        break;
      case 'triggerEvent': {
        const list = this.eventPool();
        this.startEvent(list[(arg ?? 0) % list.length], Date.now());
        break;
      }
      case 'dropSocket':
        p.conn?.terminate();
        break;
    }
    return OK;
  }

  // ---------- events ----------

  private eventPool(): ActiveEventKind[] {
    if (this.mode === 'vs') return VS_EVENTS;
    if (this.mode === 'coop' && this.players.size > 1) return COOP_EVENTS;
    return SOLO_EVENTS;
  }

  private updateEvents(now: number) {
    const ev = this.event;
    if (ev && now >= ev.endsAt) {
      this.endEvent(ev.kind === 'delivery' || ev.kind === 'power' ? 'fail' : 'expired');
    }
    if (!this.event && now >= this.nextEventAt) {
      const pool = this.eventPool();
      this.startEvent(pool[Math.floor(Math.random() * pool.length)], now);
    }
  }

  private startEvent(kind: ActiveEventKind, now: number) {
    const ev: ActiveEvent = { kind, startedAt: now, endsAt: now + EVENTS.rushDurationMs };
    if (kind === 'boost') ev.endsAt = now + EVENTS.boostDurationMs;
    if (kind === 'golden') {
      ev.endsAt = now + 8_000;
      // Fair: every business gets its golden customer at the same moment.
      for (const sim of this.businesses) sim.spawnCustomer(now, true, this.emitter);
    }
    if (kind === 'delivery') {
      ev.endsAt = now + EVENTS.deliveryDurationMs;
      ev.crates = PLOT_LOCAL.crates.slice(0, EVENTS.deliveryCrates).map((_, i) => i);
    }
    if (kind === 'power') {
      ev.endsAt = now + EVENTS.powerMaxMs;
      ev.switches = POWER_SWITCHES.map(() => 0);
    }
    this.event = ev;
    this.hooks.log(`room ${this.code}: event ${kind}`);
    this.broadcast({ t: S2C.EVENT_STATE, event: ev });
  }

  private endEvent(outcome: 'success' | 'fail' | 'expired') {
    this.event = null;
    const now = Date.now();
    this.nextEventAt = now + EVENTS.minGapMs + Math.random() * (EVENTS.maxGapMs - EVENTS.minGapMs);
    this.broadcast({ t: S2C.EVENT_STATE, event: null, outcome });
    for (const sim of this.businesses) this.bizUpdate(sim, 'event');
  }

  private mods(): Modifiers {
    const ev = this.event;
    if (!ev) return NO_MODS;
    return {
      customerMult: ev.kind === 'rush' ? (this.mode === 'vs' ? EVENTS.rushMultVs : EVENTS.rushMultCoop) : 1,
      productionMult: ev.kind === 'boost' ? EVENTS.boostMult : 1,
      halted: ev.kind === 'power',
    };
  }

  // ---------- helpers ----------

  private emitter: SimEmitter = {
    spawn: (b, id, g, arrive, side) => this.broadcast({ t: S2C.CUSTOMER_SPAWN, b, id, g, arrive, side }),
    served: (b, id, amt, by) => this.broadcast({ t: S2C.CUSTOMER_SERVED, b, id, amt, by }),
    left: (b, id) => this.broadcast({ t: S2C.CUSTOMER_LEFT, b, id }),
    delivery: (b, amt) => this.broadcast({ t: S2C.DELIVERY_SALE, b, amt }),
  };

  private priceOf(sim: BusinessSim) {
    return computeRates(sim.b).price;
  }

  private purchaseFail(code: 'NOT_ENOUGH_MONEY' | 'MAXED' | 'LOCKED'): Result {
    const msg = code === 'NOT_ENOUGH_MONEY' ? 'Недостаточно денег' : code === 'MAXED' ? 'Уже максимум' : 'Пока недоступно';
    return fail(code, msg);
  }

  private near(p: PlayerSlot, pt: { x: number; z: number }) {
    return Math.hypot(p.pos[0] - pt.x, p.pos[2] - pt.z) <= PLAYER.interactRadius + 1.5; // + latency slack
  }

  bizFor(p: PlayerSlot) {
    return this.businesses.find((s) => s.b.ownerIds.includes(p.id));
  }

  /** Business a player may spend from — only while playing, only their own (or shared co-op). */
  private actionBiz(p: PlayerSlot) {
    if (this.status !== 'playing') return undefined;
    return this.bizFor(p);
  }

  private bizUpdate(sim: BusinessSim, cause: string, by?: string) {
    sim.refreshValue();
    this.broadcast({ t: S2C.BUSINESS_UPDATE, b: this.bizSnapshot(sim.b), cause, by });
  }

  private bizSnapshot(b: BusinessState): BusinessState {
    return { ...b, cash: Math.floor(b.cash), stock: Math.floor(b.stock) };
  }

  spawnPos(slot: number): MoveTuple {
    const plot = this.mode === 'vs' ? slot : 0;
    const s = PLOT_LOCAL.spawn[this.mode === 'vs' ? 0 : slot % PLOT_LOCAL.spawn.length];
    const w = plotToWorld(plot % PLOTS.length, s.lx, s.lz);
    return [w.x, 0, w.z, PLOTS[plot % PLOTS.length].dir > 0 ? Math.PI / 2 : -Math.PI / 2, 0];
  }

  touch() { this.lastActivity = Date.now(); }

  snapshot(): RoomSnapshot {
    const host = this.hostId;
    return {
      roomId: this.roomId, code: this.code, mode: this.mode, status: this.status, isPrivate: this.isPrivate,
      serverTime: Date.now(), countdownEndsAt: this.countdownEndsAt, startTime: this.startTime, endTime: this.endTime,
      players: [...this.players.values()].sort((a, b) => a.slot - b.slot).map((p): PlayerPublic => ({
        id: p.id, name: p.name, slot: p.slot, color: COLORS[p.slot % COLORS.length], hat: p.hat, ready: p.ready,
        connected: !!p.conn, isHost: p.id === host, ping: p.ping, rematch: p.rematch,
        graceUntil: p.conn ? undefined : p.graceUntil,
      })),
      businesses: this.businesses.map((s) => this.bizSnapshot(s.b)),
      event: this.event, result: this.result, megaMallBuilt: this.megaMallBuilt, devTools: this.devTools,
    };
  }

  movementSnapshot(): ServerMsg {
    return {
      t: S2C.SNAPSHOT, s: Date.now(), tick: this.serverTick,
      p: [...this.players.values()].map((p) => [p.id, ...p.pos] as [string, number, number, number, number, number]),
    };
  }

  economySnapshot(): ServerMsg {
    return { t: S2C.ECONOMY, s: Date.now(), b: this.businesses.map((s) => s.tick()) };
  }

  broadcast(msg: ServerMsg) {
    const raw = JSON.stringify(msg);
    for (const p of this.players.values()) p.conn?.sendRaw(raw);
  }

  broadcastState() {
    this.broadcast({ t: S2C.ROOM_STATE, room: this.snapshot() });
  }

  // ---------- persistence ----------

  serialize() {
    return {
      roomId: this.roomId, code: this.code, mode: this.mode, isPrivate: this.isPrivate, status: this.status,
      countdownEndsAt: this.countdownEndsAt, startTime: this.startTime, endTime: this.endTime, serverTick: this.serverTick,
      nextEventAt: this.nextEventAt, result: this.result, megaMallBuilt: this.megaMallBuilt,
      businesses: this.businesses.map((s) => s.b),
      players: [...this.players.values()].map(({ conn: _c, ...rest }) => rest),
    };
  }

  static restore(data: ReturnType<Room['serialize']>, hooks: RoomHooks, devTools: boolean): Room {
    const r = new Room(data.code, data.mode, data.isPrivate, hooks, devTools);
    (r as { roomId: string }).roomId = data.roomId;
    Object.assign(r, {
      status: data.status, countdownEndsAt: data.countdownEndsAt, startTime: data.startTime, endTime: data.endTime,
      serverTick: data.serverTick, nextEventAt: data.nextEventAt, result: data.result, megaMallBuilt: data.megaMallBuilt,
    });
    r.businesses = data.businesses.map((b) => {
      const sim = new BusinessSim(b, () => r.customerSeq++);
      sim.resetCustomers();
      return sim;
    });
    const now = Date.now();
    for (const p of data.players) {
      // Everybody is "disconnected" after a restart and gets a fresh grace window.
      r.players.set(p.id, { ...p, conn: null, graceUntil: now + MATCH.reconnectGraceMs, ready: false });
    }
    // Server downtime shouldn't eat match time.
    if (r.status === 'playing' || r.status === 'countdown') {
      r.status = 'playing';
      r.endTime = Math.max(r.endTime, now + 60_000);
    }
    return r;
  }
}
