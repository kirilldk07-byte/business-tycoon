import * as THREE from 'three';
import { EVENTS, PLAYER } from '../../../shared/constants/config';
import { MEGA_MALL_PLOT, PLOT_LOCAL, PLOTS, POWER_SWITCHES, WORLD_BOUNDS, plotToWorld } from '../../../shared/constants/world';
import { emptyBusiness, formatMoney } from '../../../shared/game/economy';
import { walkMs } from '../../../shared/game/paths';
import {
  STRUCTURES, STRUCTURE_IDS, UPGRADES, VENUES, VENUE_IDS, WORKERS, type StructureId, type UpgradeId, type VenueId, type WorkerId,
} from '../../../shared/constants/config';
import { q2 } from '../../../shared/protocol/codec';
import { C2S, EMOTES, EMOTE_COOLDOWN_MS, S2C, type InteractTarget, type MoveTuple } from '../../../shared/protocol/messages';
import { ANIM, type ActiveEvent, type MatchResult, type BusinessState, type PlayerPublic, type RoomSnapshot } from '../../../shared/types/state';
import type { AudioManager } from '../audio/AudioManager';
import { createConstructionSite, createCrate, createDeliveryTruck, createMegaMall } from '../business/BuildingFactory';
import { BusinessView, type PadDef } from '../business/BusinessView';
import { CLIENT, isTouch } from '../config/client';
import { lowerQuality, qualitySetting, resolveQuality, type Quality } from '../config/quality';
import { Interpolator } from '../multiplayer/Interpolator';
import type { Net } from '../multiplayer/Net';
import { Character } from '../player/Character';
import { World, type AABB } from '../world/World';
import { CameraRig } from './CameraRig';
import { Effects } from './Effects';
import { Input } from './Input';

export interface HudSink {
  prompt(text: string | null, locked?: boolean): void;
  toast(text: string, kind?: 'info' | 'good' | 'bad'): void;
  flashMoney(): void;
}

interface RemotePlayer {
  info: PlayerPublic;
  char: Character;
  interp: Interpolator;
  lastPos: THREE.Vector3;
  /** Smoothed render state on top of the interpolated sample (absorbs jitter). */
  pos: THREE.Vector3;
  rot: number;
  speed: number;
  fresh: boolean;
}

interface Box2 { minX: number; maxX: number; minZ: number; maxZ: number }
type Target = { label: string; target?: InteractTarget; pad?: PadDef; view?: BusinessView };

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly world: World;
  readonly effects: Effects;
  readonly input: Input;
  quality: Quality;

  room: RoomSnapshot | null = null;
  myId: string | null = null;
  inMatch = false;

  /** Menu backdrop: two finished businesses, purely client-side (never touch the server). */
  private showcase: { view: BusinessView; acc: number; pay: [number, number][] }[] = [];
  private showcaseId = 1;
  private players = new Map<string, RemotePlayer>();
  private me: Character | null = null;
  private myPos = new THREE.Vector3();
  private myVelY = 0;
  private myVel = new THREE.Vector3();
  private myRot = 0;
  private myAnim: number = ANIM.idle;
  private interactUntil = 0;
  private carryUntil = 0;
  private grounded = true;
  private sendAcc = 0;
  private lastSent = '';
  private lastSentAt = 0;
  private moveSeq = 0;

  readonly rig: CameraRig;
  private camColliders: AABB[] = [];
  private camColliderTimer = 0;
  private mySpeed = 0;
  private snapJitter = 0;
  private lastSnapAt = 0;
  private views = new Map<number, BusinessView>();
  private obstacles: Box2[] = [];
  private megaSite: THREE.Object3D | null = null;
  private megaMall: THREE.Object3D | null = null;
  private crates = new Map<string, THREE.Object3D>();
  private trucks = new Map<number, THREE.Object3D>();
  private currentTarget: Target | null = null;
  onOpenPanel: (tab: 'upgrades') => void = () => {};
  private timer = new THREE.Timer();
  private elapsed = 0;
  private ended: 'win' | 'lose' | 'draw' | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    private net: Net,
    private audio: AudioManager,
    private hud: HudSink,
    floatLayer: HTMLElement,
    joyBase: HTMLElement,
    joyKnob: HTMLElement,
  ) {
    this.quality = resolveQuality();
    const q = this.quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: q.antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(q.pixelRatio);
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.5, 700);
    this.world = new World(this.scene, q);
    this.rig = new CameraRig(this.camera);
    this.rig.wantDist = isTouch ? 18 : 16;
    this.effects = new Effects(this.scene, this.camera, floatLayer);
    this.input = new Input(canvas, joyBase, joyKnob);
    this.input.onKey = (code) => {
      const idx = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'].indexOf(code);
      if (idx >= 0) this.emote(idx);
    };
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.bindNet();
    this.startShowcase();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.rig?.setAspect(w < h);
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- network

  private bindNet() {
    const n = this.net;
    n.on(S2C.SNAPSHOT, (m) => {
      // Track arrival jitter → adaptive interpolation delay.
      const now = performance.now();
      if (this.lastSnapAt) {
        const dev = Math.abs(now - this.lastSnapAt - 1000 / 15);
        this.snapJitter += (dev - this.snapJitter) * 0.1;
      }
      this.lastSnapAt = now;
      for (const [id, x, y, z, rot, anim] of m.p) {
        const rp = this.players.get(id);
        if (rp) rp.interp.push({ t: m.s, x, y, z, rot, anim });
      }
    });
    n.on(S2C.ECONOMY, (m) => {
      for (const t of m.b) {
        const v = this.views.get(t.id);
        if (!v?.state) continue;
        v.state.value = t.value; v.state.stats.customers = t.customers;
        v.updateTick(t.stock, t.queue, t.cash);
        this.ipm.set(t.id, t.ipm);
        const rb = this.room?.businesses.find((b) => b.id === t.id);
        if (rb) Object.assign(rb, { cash: t.cash, stock: t.stock, queue: t.queue, value: t.value });
      }
    });
    n.on(S2C.BUSINESS_UPDATE, (m) => this.applyBusiness(m.b, true, m.cause, m.by));
    n.on(S2C.CUSTOMERS, (m) => this.views.get(m.b)?.onCustomers(m.sp, m.pd, m.lf));
    n.on(S2C.DELIVERY_SALE, (m) => {
      const v = this.views.get(m.b);
      if (!v) return;
      const at = v.toWorld(new THREE.Vector3(PLOT_LOCAL.staff.delivery.lx, 2.5, PLOT_LOCAL.staff.delivery.lz));
      this.effects.floatText(at, `🛵 +$${formatMoney(m.amt)}`, 'money');
      if (this.isMyBiz(m.b)) this.audio.play('money');
    });
    n.on(S2C.EVENT_STATE, (m) => {
      if (this.room) this.room.event = m.event;
      this.applyEventVisuals(m.event);
    });
    n.on(S2C.EMOTE, (m) => {
      const ch = m.id === this.myId ? this.me : this.players.get(m.id)?.char;
      ch?.showEmote(EMOTES[m.e]);
      this.audio.play('emote');
    });
    n.on(S2C.CORRECTION, (m) => {
      this.myPos.set(m.p[0], m.p[1], m.p[2]);
    });
  }

  /** Latest income per minute per business (for HUD). */
  readonly ipm = new Map<number, number>();

  private isMyBiz(id: number) {
    return !!this.views.get(id)?.state?.ownerIds.includes(this.myId ?? '');
  }

  private near(p: THREE.Vector3, d: number) {
    return p.distanceTo(this.camera.position) < d * 1.6;
  }

  // ------------------------------------------------------------- room sync

  /** Full sync from a room snapshot (join, reconnect, status change). */
  syncRoom(room: RoomSnapshot, myId: string) {
    const prevStatus = this.room?.status;
    const fresh = this.room?.roomId !== room.roomId || prevStatus === 'lobby' || prevStatus === 'ended' && room.status === 'countdown';
    this.room = room;
    this.myId = myId;
    const active = room.status !== 'lobby';

    // Characters
    for (const [id, rp] of this.players) {
      if (!room.players.some((p) => p.id === id) || !active) { this.scene.remove(rp.char.root); this.players.delete(id); }
    }
    if (!active) {
      if (this.me) { this.scene.remove(this.me.root); this.me = null; }
      this.clearMatchVisuals();
      this.inMatch = false;
      this.input.enabled = false;
      this.startShowcase();
      return;
    }
    this.stopShowcase();
    for (const p of room.players) {
      if (p.id === myId) {
        if (!this.me) {
          this.me = new Character(p.color, p.hat, true, p.slot);
          this.scene.add(this.me.root);
        }
        continue;
      }
      let rp = this.players.get(p.id);
      if (!rp) {
        const char = new Character(p.color, p.hat, false, p.slot);
        this.scene.add(char.root);
        rp = { info: p, char, interp: new Interpolator(), lastPos: new THREE.Vector3(), pos: new THREE.Vector3(), rot: 0, speed: 0, fresh: true };
        this.players.set(p.id, rp);
      }
      rp.info = p;
      rp.char.root.visible = true;
    }

    if (fresh) this.clearMatchVisuals();
    // Businesses
    const usedPlots = new Set<number>();
    for (const b of room.businesses) {
      this.applyBusiness(b, false);
      usedPlots.add(b.plot);
    }
    // Co-op: the second plot is the Mega Mall site.
    if (room.mode !== 'vs') {
      if (room.megaMallBuilt) this.showMegaMall(false);
      else if (!this.megaSite) {
        this.megaSite = createConstructionSite();
        const p = PLOTS[MEGA_MALL_PLOT];
        this.megaSite.position.set(p.x, 0, p.z);
        this.megaSite.rotation.y = p.dir > 0 ? 0 : Math.PI;
        this.scene.add(this.megaSite);
      }
    }
    this.applyEventVisuals(room.event);

    if (fresh || !this.inMatch) {
      const mine = room.players.find((p) => p.id === myId)!;
      const spawnPlot = room.mode === 'vs' ? mine.slot : 0;
      const sp = PLOT_LOCAL.spawn[room.mode === 'vs' ? 0 : mine.slot % PLOT_LOCAL.spawn.length];
      const w = plotToWorld(spawnPlot, sp.lx, sp.lz);
      this.myPos.set(w.x, 0, w.z);
      this.myVelY = 0;
      this.myVel.set(0, 0, 0);
      this.myRot = PLOTS[spawnPlot].dir > 0 ? -Math.PI / 2 : Math.PI / 2;
      // Camera on the plaza side, looking at your own business.
      this.rig.yaw = PLOTS[spawnPlot].dir > 0 ? Math.PI / 2 : -Math.PI / 2;
      this.rig.pitch = 0.38;
      this.rig.setOverride(null);
      this.rig.snap(this.myPos);
      this.ended = null;
      for (const rp of this.players.values()) { rp.interp = new Interpolator(); rp.fresh = true; }
    }
    this.inMatch = true;
    this.input.enabled = room.status === 'playing' || room.status === 'countdown' || room.status === 'ended';
    if (room.status === 'ended' && room.result) {
      const r = room.result;
      this.ended = r.winnerIds.length === 0 ? (r.mode === 'vs' ? 'draw' : 'lose') : r.winnerIds.includes(myId) ? 'win' : 'lose';
    } else {
      this.ended = null;
    }
    this.updateTags();
  }

  private applyBusiness(b: BusinessState, animate: boolean, cause?: string, by?: string) {
    let v = this.views.get(b.id);
    if (!v) {
      const owner = this.room?.players.find((p) => b.ownerIds.includes(p.id));
      const accent = this.room?.mode === 'vs' ? owner?.color ?? 0x3b82f6 : 0x8b5cf6;
      const mineBiz = b.ownerIds.includes(this.myId ?? '');
      v = new BusinessView(b.plot, accent, this.effects, this.world.crowd, this.quality.maxNpcs, mineBiz);
      const view = v;
      v.onBuilt = (label, at, big) => {
        if (!this.near(at, 60)) return;
        this.effects.floatText(at, view.isMine ? `BUILD COMPLETE! ${label}` : label, 'big');
        if (view.isMine) { this.audio.play('purchase'); this.rig.shake(big ? 0.35 : 0.18); this.effects.burst(at, 'confetti', big ? 60 : 25); }
      };
      v.onPay = () => { if (view.isMine) { this.audio.play('money'); this.hud.flashMoney(); } };
      this.views.set(b.id, v);
      this.scene.add(v.root);
      const names = this.room?.players.filter((p) => b.ownerIds.includes(p.id)).map((p) => p.name).join(' + ') ?? '';
      v.setOwnerLabel(this.room?.mode === 'coop' ? `TEAM: ${names}` : names, this.room?.mode === 'vs' ? hex(accent) : '#e9d5ff');
    }
    const prevTier = v.state?.tier ?? b.tier;
    v.apply(b, animate);
    const rb = this.room?.businesses.findIndex((x) => x.id === b.id) ?? -1;
    if (this.room && rb >= 0) this.room.businesses[rb] = b;
    this.rebuildObstacles();
    if (animate && cause) {
      const mine = b.ownerIds.includes(this.myId ?? '');
      const center = v.toWorld(new THREE.Vector3(PLOT_LOCAL.building.lx, 3, 0));
      if ((cause === 'tier' && b.tier > prevTier) || cause.startsWith('venue')) {
        if (mine) this.audio.play('construction');
        if (!mine && this.room?.mode === 'vs') this.hud.toast(cause === 'tier' ? `🏗️ Соперник: HQ уровень ${b.tier}` : `🏗️ Соперник открыл новый бизнес`, 'info');
      } else if (cause.startsWith('upgrade')) {
        this.effects.burst(center, 'sparkle', 24);
        const id = cause.split(':')[1] as UpgradeId;
        if (mine && UPGRADES[id]) {
          this.audio.play('upgrade');
          this.effects.floatText(v.toWorld(new THREE.Vector3(PLOT_LOCAL.counter.lx, 4, 0)), `⬆ ${UPGRADES[id].name} · ур. ${b.upgrades[id]}`, 'big');
        }
      } else if (cause.startsWith('hire') || cause.startsWith('structure')) {
        if (mine) this.audio.play(cause.startsWith('structure') ? 'construction' : 'purchase');
      } else if (cause === 'megamall') {
        this.showMegaMall(true);
      }
      if (by && by !== this.myId && mine && this.room?.mode !== 'vs') {
        const who = this.room?.players.find((p) => p.id === by)?.name ?? 'Напарник';
        const [kind, id] = cause.split(':');
        const what: Record<string, string> = {
          upgrade: `улучшил ${UPGRADES[id as UpgradeId]?.name ?? ''}`, hire: `нанял ${WORKERS[id as WorkerId]?.name ?? ''}`, tier: `поднял HQ до ур. ${b.tier}`,
          venue: `открыл ${VENUES[id as VenueId]?.name ?? 'бизнес'}`, structure: `построил ${STRUCTURES[id as StructureId]?.name ?? ''}`, delivery: 'разгрузил доставку',
        };
        if (what[kind]) this.hud.toast(`🤝 ${who} ${what[kind]}`, 'info');
      }
    }
  }

  private showMegaMall(animate: boolean) {
    if (this.megaMall) return;
    if (this.megaSite) { this.scene.remove(this.megaSite); this.megaSite = null; }
    const m = createMegaMall();
    const p = PLOTS[MEGA_MALL_PLOT];
    m.position.set(p.x, 0, p.z);
    m.rotation.y = p.dir > 0 ? 0 : Math.PI;
    this.scene.add(m);
    this.megaMall = m;
    if (animate) {
      m.scale.y = 0.01;
      const start = performance.now();
      const grow = () => {
        const k = Math.min(1, (performance.now() - start) / 2500);
        m.scale.y = Math.max(0.01, 1 - Math.pow(1 - k, 3));
        if (k < 1) requestAnimationFrame(grow);
        else this.effects.burst(new THREE.Vector3(p.x, 10, p.z), 'confetti', 200);
      };
      grow();
      this.audio.play('construction');
    }
  }

  startShowcase() {
    if (this.showcase.length || this.inMatch) return;
    const setups = [
      { plot: 0, accent: 0x3b82f6, label: 'YOUR EMPIRE', tier: 9, venues: [3, 3, 2, 2, 1, 0], structs: 5, workers: [2, 2, 1, 1, 1] },
      { plot: 1, accent: 0xf97316, label: 'RIVAL', tier: 7, venues: [3, 2, 2, 1, 0, 0], structs: 4, workers: [2, 1, 1, 1, 1] },
    ];
    for (const st of setups) {
      const b = emptyBusiness(-1 - st.plot, st.plot, [], 0);
      b.tier = st.tier;
      VENUE_IDS.forEach((id, i) => { b.venues[id] = st.venues[i]; });
      b.structures = STRUCTURE_IDS.slice(0, st.structs);
      (['cashier', 'worker', 'marketer', 'delivery', 'manager'] as const).forEach((k, i) => { b.workers[k] = st.workers[i]; });
      const view = new BusinessView(st.plot, st.accent, this.effects, this.world.crowd, Math.min(24, this.quality.maxNpcs), false);
      view.apply(b, false);
      view.setOwnerLabel(st.label, hex(st.accent));
      this.scene.add(view.root);
      this.showcase.push({ view, acc: Math.random(), pay: [] });
    }
  }

  private stopShowcase() {
    for (const s of this.showcase) { s.view.dispose(); this.scene.remove(s.view.root); }
    this.showcase = [];
  }

  private updateShowcase(dt: number) {
    const now = Date.now();
    for (const s of this.showcase) {
      const st = s.view.state!;
      s.acc -= dt;
      if (s.acc <= 0 && s.view.customers.visibleCount < 22) {
        s.acc = 0.45 + Math.random() * 0.5;
        const built = VENUE_IDS.map((id, i) => (st.venues[id] ? i : -9)).filter((i) => i >= 0);
        const dest = Math.random() < 0.4 ? -1 : built[Math.floor(Math.random() * built.length)];
        const side = Math.random() < 0.5 ? 0 : 1;
        const id = this.showcaseId++;
        const arrive = now + walkMs(dest, side);
        s.view.customers.spawn(id, dest, 0, arrive, side);
        s.pay.push([id, arrive + (dest < 0 ? 1200 + Math.random() * 1500 : 300)]);
      }
      for (let i = s.pay.length - 1; i >= 0; i--) {
        if (now < s.pay[i][1]) continue;
        s.view.customers.paid(s.pay[i][0]);
        s.pay.splice(i, 1);
      }
      s.view.update(dt, now, this.elapsed, false);
    }
  }

  private clearMatchVisuals() {
    for (const v of this.views.values()) { v.dispose(); this.scene.remove(v.root); }
    this.views.clear();
    if (this.megaSite) { this.scene.remove(this.megaSite); this.megaSite = null; }
    if (this.megaMall) { this.scene.remove(this.megaMall); this.megaMall = null; }
    this.applyEventVisuals(null);
    this.effects.clear();
    this.obstacles = [];
  }

  private rebuildObstacles() {
    const obs: Box2[] = [];
    const v3 = new THREE.Vector3();
    for (const v of this.views.values()) {
      for (const f of v.footprints()) {
        v3.set(f.lx, 0, f.lz);
        v.root.localToWorld(v3);
        obs.push({ minX: v3.x - f.w / 2, maxX: v3.x + f.w / 2, minZ: v3.z - f.d / 2, maxZ: v3.z + f.d / 2 });
      }
    }
    if (this.megaMall) obs.push({ minX: PLOTS[MEGA_MALL_PLOT].x - 12, maxX: PLOTS[MEGA_MALL_PLOT].x + 12, minZ: -13, maxZ: 13 });
    obs.push({ minX: -4, maxX: 4, minZ: -4, maxZ: 4 }); // park fountain
    this.obstacles = obs;
  }

  // -------------------------------------------------------------- events

  private applyEventVisuals(ev: ActiveEvent | null) {
    // BIG DELIVERY: a truck and crates at every business (each player unloads their own).
    const want = new Set<string>();
    if (ev?.kind === 'delivery' && ev.crates) {
      for (const [bid, list] of Object.entries(ev.crates)) for (const i of list) want.add(`${bid}:${i}`);
    }
    for (const [key, obj] of this.crates) {
      if (want.has(key)) continue;
      if (this.near(obj.position, 50)) this.effects.burst(obj.position.clone().setY(1), 'sparkle', 10);
      this.scene.remove(obj);
      this.crates.delete(key);
      if (this.isMyBiz(Number(key.split(':')[0]))) this.audio.play('produce');
    }
    for (const key of want) {
      if (this.crates.has(key)) continue;
      const [bid, i] = key.split(':').map(Number);
      const biz = this.room?.businesses.find((b) => b.id === bid);
      if (!biz) continue;
      const loc = PLOT_LOCAL.crates[i];
      const w = plotToWorld(biz.plot, loc.lx, loc.lz);
      const c = createCrate();
      c.position.set(w.x, 0, w.z);
      c.rotation.y = i * 0.7;
      this.scene.add(c);
      this.crates.set(key, c);
    }
    const truckFor = ev?.kind === 'delivery' ? Object.keys(ev.crates ?? {}) : [];
    for (const [bid, t] of this.trucks) if (!truckFor.includes(String(bid))) { this.scene.remove(t); this.trucks.delete(bid); }
    for (const bidS of truckFor) {
      const bid = Number(bidS);
      const biz = this.room?.businesses.find((b) => b.id === bid);
      if (!biz || this.trucks.has(bid)) continue;
      const t = createDeliveryTruck();
      const w = plotToWorld(biz.plot, 17, -12.5);
      t.position.set(w.x, 0, w.z);
      t.rotation.y = PLOTS[biz.plot].dir > 0 ? -Math.PI / 2 : Math.PI / 2;
      this.scene.add(t);
      this.trucks.set(bid, t);
    }
    // Power generators
    for (const sw of POWER_SWITCHES) {
      if (ev?.kind !== 'power') this.world.setSwitchState(sw.id, 'idle');
      else {
        const t = ev.switches?.[sw.id] ?? 0;
        const on = t > 0 && this.net.serverNow() - t <= EVENTS.powerWindowMs;
        this.world.setSwitchState(sw.id, on ? 'on' : 'alarm');
      }
    }
  }

  // -------------------------------------------------------------- actions

  private lastEmoteAt = 0;
  /** Returns false while on cooldown (server rate-limits too). */
  emote(i: number): boolean {
    if (!this.inMatch) return false;
    const now = performance.now();
    if (now - this.lastEmoteAt < EMOTE_COOLDOWN_MS) return false;
    this.lastEmoteAt = now;
    this.net.send({ t: C2S.EMOTE, e: i });
    return true;
  }

  private findTarget(): Target | null {
    if (!this.room || this.room.status !== 'playing') return null;
    const R = PLAYER.interactRadius;
    let best: (Target & { d: number }) | null = null;
    const consider = (x: number, z: number, t: Target, radius = R) => {
      const d = Math.hypot(this.myPos.x - x, this.myPos.z - z);
      if (d <= radius && (!best || d < best.d)) best = { ...t, d };
    };
    for (const v of this.views.values()) {
      if (!v.state?.ownerIds.includes(this.myId ?? '')) continue;
      if (v.state.tier >= 1) {
        const c = plotToWorld(v.plot, PLOT_LOCAL.counter.lx, PLOT_LOCAL.counter.lz);
        consider(c.x, c.z, { target: { kind: 'counter', biz: v.state.id }, label: 'Обслужить клиента' });
        const m = plotToWorld(v.plot, PLOT_LOCAL.machine.lx, PLOT_LOCAL.machine.lz);
        consider(m.x, m.z, { target: { kind: 'machine', biz: v.state.id }, label: 'Произвести товар' });
      }
      // Purchase pads (step on the glowing circle)
      for (const p of v.padTargets()) {
        const price = p.def.price === null ? '' : ` — $${formatMoney(p.def.price)}`;
        const label = p.def.state === 'locked' ? `🔒 ${p.def.title}: ${p.def.note ?? ''}` : `${p.def.open ? 'Открыть' : 'Купить'} ${p.def.title}${price}`;
        consider(p.x, p.z, { pad: p.def, view: v, label }, 1.9);
      }
    }
    const ev = this.room.event;
    if (ev?.kind === 'delivery') {
      for (const [key, obj] of this.crates) {
        const [bid, idx] = key.split(':').map(Number);
        if (this.isMyBiz(bid)) consider(obj.position.x, obj.position.z, { target: { kind: 'crate', index: idx }, label: 'Разгрузить ящик' });
      }
    }
    if (ev?.kind === 'power') {
      for (const sw of POWER_SWITCHES) consider(sw.x, sw.z, { target: { kind: 'switch', id: sw.id }, label: 'Включить генератор' });
    }
    return best;
  }

  // ---------------------------------------------------------------- frame

  private frame() {
    this.timer.update();
    const dt = Math.min(0.05, this.timer.getDelta());
    this.elapsed += dt;
    const serverNow = this.net.serverNow();
    this.world.update(dt, this.elapsed, this.camera.position);

    if (this.inMatch && this.me && this.room) {
      this.updateLocal(dt);
      this.updateRemotes(dt, serverNow);
      this.updateCamera(dt);
      for (const v of this.views.values()) {
        if (v.isMine) v.focusPads(this.myPos.x, this.myPos.z);
        v.update(dt, serverNow, this.elapsed, this.myPos.distanceTo(v.root.position) < 70);
      }
      if (this.room.event?.kind === 'power') this.applyEventVisuals(this.room.event);
      this.sendAcc += dt;
      if (this.sendAcc >= 1 / CLIENT.sendHz) { this.sendAcc = 0; this.sendMove(); }
      if (Math.floor(this.elapsed * 4) !== Math.floor((this.elapsed - dt) * 4)) this.updateTags();
    } else {
      this.updateShowcase(dt);
      // Menu: slow cinematic drift between the two showcase businesses.
      const t = this.elapsed * 0.045;
      const fx = Math.sin(t * 0.7) * 34;
      this.camera.position.set(fx + Math.cos(t) * 40, 26 + Math.sin(t * 1.3) * 4, Math.sin(t) * 40);
      this.camera.lookAt(fx * 0.9, 7, 0);
    }
    this.effects.update(dt);
    this.updateTutorialArrow();
    this.watchFps(dt);
    this.world.crowd.commit();
    this.renderer.render(this.scene, this.camera);
  }

  private updateLocal(dt: number) {
    const room = this.room!;
    const canMove = room.status === 'playing' || room.status === 'ended';
    const { x, y } = canMove ? this.input.axes() : { x: 0, y: 0 };
    const yaw = this.rig.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const mx = fx * y + rx * x, mz = fz * y + rz * x;
    const mag = Math.min(1, Math.hypot(mx, mz));
    const want = PLAYER.runSpeed * mag;
    // Short acceleration / braking (≈0.1 s) — no instant start/stop, no foot sliding.
    const wx = mag > 0.05 ? (mx / Math.hypot(mx, mz)) * want : 0, wz = mag > 0.05 ? (mz / Math.hypot(mx, mz)) * want : 0;
    const ka = Math.min(1, dt * (mag > 0.05 ? 14 : 18));
    this.myVel.x += (wx - this.myVel.x) * ka;
    this.myVel.z += (wz - this.myVel.z) * ka;
    if (Math.hypot(this.myVel.x, this.myVel.z) < 0.05) this.myVel.set(0, 0, 0);
    this.myPos.x += this.myVel.x * dt;
    this.myPos.z += this.myVel.z * dt;
    const speed = Math.hypot(this.myVel.x, this.myVel.z);
    if (mag > 0.05) {
      const target = Math.atan2(mx, mz);
      let d = target - this.myRot;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.myRot += d * Math.min(1, dt * 14);
    }
    if (this.input.consumeJump() && this.grounded && canMove) {
      this.myVelY = PLAYER.jumpVelocity;
      this.grounded = false;
      this.audio.play('jump');
    }
    this.myVelY -= PLAYER.gravity * dt;
    this.myPos.y += this.myVelY * dt;
    if (this.myPos.y <= 0) { this.myPos.y = 0; this.myVelY = 0; this.grounded = true; }
    this.collide();

    // Interaction
    this.currentTarget = this.findTarget();
    this.hud.prompt(this.currentTarget ? `${isTouch ? '' : 'E — '}${this.currentTarget.label}` : null, this.currentTarget?.pad?.state === 'locked');
    if (this.input.consumeInteract() && this.currentTarget && room.status === 'playing') {
      const ct = this.currentTarget;
      this.interactUntil = performance.now() + 350;
      if (ct.pad) {
        // Pads only REQUEST the purchase; the building appears after the server confirms.
        if (ct.pad.open) this.onOpenPanel(ct.pad.open);
        else if (ct.pad.state === 'locked') { this.audio.play('error'); this.hud.toast(`🔒 ${ct.pad.note ?? 'Пока недоступно'}`, 'bad'); }
        else if (ct.pad.send) { this.net.send(ct.pad.send); ct.view?.markPending(ct.pad.key); this.audio.play('ui'); }
      } else if (ct.target) {
        this.net.send({ t: C2S.INTERACT, target: ct.target });
        const tk = ct.target.kind;
        this.audio.play(tk === 'machine' ? 'produce' : 'ui');
        if (tk === 'machine') this.effects.burst(this.myPos.clone().setY(1.6), 'sparkle', 5);
        if (tk === 'crate') this.carryUntil = performance.now() + 900;
      }
    }

    if (this.ended === 'win') this.myAnim = ANIM.victory;
    else if (this.ended === 'lose') this.myAnim = ANIM.lose;
    else if (!this.grounded) this.myAnim = ANIM.jump;
    else if (performance.now() < this.carryUntil) this.myAnim = ANIM.carry;
    else if (performance.now() < this.interactUntil) this.myAnim = ANIM.interact;
    else this.myAnim = speed > 0.3 ? (speed < PLAYER.runSpeed * 0.55 ? ANIM.walk : ANIM.run) : ANIM.idle;
    this.mySpeed = speed;

    const me = this.me!;
    me.anim = this.myAnim;
    me.root.position.copy(this.myPos);
    me.root.rotation.y = this.myRot;
    me.update(dt, speed);
  }

  private collide() {
    const r = 0.5;
    const p = this.myPos;
    p.x = Math.max(WORLD_BOUNDS.minX, Math.min(WORLD_BOUNDS.maxX, p.x));
    p.z = Math.max(WORLD_BOUNDS.minZ, Math.min(WORLD_BOUNDS.maxZ, p.z));
    for (const b of this.obstacles) {
      if (p.y > 2.5 && b.maxX - b.minX < 3) continue; // can hop over small things
      const minX = b.minX - r, maxX = b.maxX + r, minZ = b.minZ - r, maxZ = b.maxZ + r;
      if (p.x > minX && p.x < maxX && p.z > minZ && p.z < maxZ) {
        const dl = p.x - minX, dr = maxX - p.x, dn = p.z - minZ, df = maxZ - p.z;
        const m = Math.min(dl, dr, dn, df);
        if (m === dl) p.x = minX; else if (m === dr) p.x = maxX; else if (m === dn) p.z = minZ; else p.z = maxZ;
      }
    }
  }

  private updateRemotes(dt: number, serverNow: number) {
    // Render the past: base delay grows with measured jitter (smooth on bad networks).
    const delay = Math.min(260, Math.max(CLIENT.interpDelayMs, 80 + this.snapJitter * 2.5));
    const renderTime = serverNow - delay;
    const kPos = 1 - Math.exp(-dt * 18);
    const kRot = 1 - Math.exp(-dt * 12);
    for (const rp of this.players.values()) {
      const s = rp.interp.sample(renderTime);
      if (!s) continue;
      const target = new THREE.Vector3(s.x, s.y, s.z);
      if (rp.fresh || rp.pos.distanceTo(target) > 6) {
        rp.pos.copy(target); rp.rot = s.rot; rp.fresh = false; // respawn / big correction: snap
      } else {
        rp.pos.lerp(target, kPos);
        let d = s.rot - rp.rot;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        rp.rot += d * kRot;
      }
      const inst = dt > 0 ? Math.hypot(rp.pos.x - rp.lastPos.x, rp.pos.z - rp.lastPos.z) / dt : 0;
      rp.speed += (Math.min(inst, 10) - rp.speed) * Math.min(1, dt * 8);
      rp.lastPos.copy(rp.pos);
      rp.char.root.position.copy(rp.pos);
      rp.char.root.rotation.y = rp.rot;
      rp.char.anim = s.anim;
      rp.char.root.visible = true;
      rp.char.update(dt, rp.speed);
      // Blink while the player is reconnecting.
      if (!rp.info.connected) rp.char.root.visible = Math.floor(performance.now() / 400) % 2 === 0;
    }
  }

  private updateCamera(dt: number) {
    const c = this.input.consumeCamera();
    this.rig.rotate(c.dx, c.dy, c.zoom);
    this.camColliderTimer -= dt;
    if (this.camColliderTimer <= 0) { this.camColliderTimer = 0.5; this.rebuildCamColliders(); }
    this.rig.update(dt, this.myPos, this.mySpeed, this.camColliders);
  }

  /** World city blocks + current business buildings (heights included). */
  private rebuildCamColliders() {
    const list: AABB[] = [...this.world.colliders];
    const box = new THREE.Box3();
    for (const v of this.views.values()) {
      for (const o of v.cameraBlockers()) {
        box.setFromObject(o);
        if (box.isEmpty() || box.max.y < 2) continue;
        list.push({ minX: box.min.x, maxX: box.max.x, minY: 0, maxY: box.max.y, minZ: box.min.z, maxZ: box.max.z });
      }
    }
    this.camColliders = list;
  }

  /** Small camera kick (construction feedback). */
  shake(amount: number) { this.rig.shake(amount); }

  private sendMove() {
    if (!this.room || this.room.status === 'lobby') return;
    const p: MoveTuple = [q2(this.myPos.x), q2(this.myPos.y), q2(this.myPos.z), q2(this.myRot), this.myAnim];
    const key = p.join(',');
    const now = performance.now();
    // Only send when something changed (plus a slow keep-alive).
    if (key === this.lastSent && now - this.lastSentAt < 1000) return;
    this.lastSent = key;
    this.lastSentAt = now;
    this.net.send({ t: C2S.PLAYER_MOVE, p, seq: this.moveSeq++ });
  }

  private updateTags() {
    const room = this.room;
    if (!room) return;
    const label = (p: PlayerPublic) => {
      const biz = room.businesses.find((b) => b.ownerIds.includes(p.id));
      const money = biz ? `$${formatMoney(room.mode === 'vs' ? biz.value : biz.cash)}` : '';
      return { name: p.connected ? p.name : `${p.name} ⏳`, money };
    };
    for (const p of room.players) {
      const ch = p.id === this.myId ? this.me : this.players.get(p.id)?.char;
      if (!ch) continue;
      const l = label(p);
      ch.setTag(l.name, p.id === this.myId ? '' : l.money, hex(p.color)); // own money is already in the HUD
    }
  }

  /** Player info changed (ping/connected) without full resync. */
  updatePlayers(players: PlayerPublic[]) {
    for (const p of players) {
      const rp = this.players.get(p.id);
      if (rp) rp.info = p;
    }
  }

  celebrate(win: boolean) {
    if (win) {
      for (let i = 0; i < 4; i++) setTimeout(() => this.effects.burst(this.myPos.clone().setY(2), 'confetti', 80), i * 350);
    }
  }

  // ---------------------------------------------------------- end of match

  /** Server result arrived: fly the camera over both businesses, confetti at the winner. */
  endCinematic(result: MatchResult) {
    const won = result.winnerIds.includes(this.myId ?? '');
    if (result.mode === 'vs') {
      this.rig.setOverride(new THREE.Vector3(0, 52, 62), new THREE.Vector3(0, 4, 0));
      const winner = result.winnerIds[0];
      const pos = winner === this.myId ? this.myPos : this.players.get(winner ?? '')?.pos;
      if (pos) for (let i = 0; i < 5; i++) setTimeout(() => this.effects.burst(pos.clone().setY(2.5), 'confetti', 90), 300 + i * 380);
      const wb = this.room?.businesses.find((b) => b.ownerIds.includes(winner ?? ''));
      if (wb) { const p = PLOTS[wb.plot]; this.effects.burst(new THREE.Vector3(p.x, 18, p.z), 'confetti', 160); }
    } else {
      const p = PLOTS[MEGA_MALL_PLOT];
      if (won) {
        this.rig.setOverride(new THREE.Vector3(p.x * 0.35, 30, 48), new THREE.Vector3(p.x, 8, p.z));
        for (let i = 0; i < 6; i++) setTimeout(() => this.effects.burst(new THREE.Vector3(p.x, 22, p.z), 'confetti', 150), i * 400);
      } else this.rig.setOverride(new THREE.Vector3(0, 46, 60), new THREE.Vector3(0, 4, 0));
    }
    this.celebrate(won);
    setTimeout(() => this.rig.setOverride(null), 9000);
  }

  // ---------------------------------------------------------- tutorial arrow

  private tutorialArrow: THREE.Group | null = null;
  private tutorialKey: string | null = null;

  setTutorialPad(key: string | null) {
    this.tutorialKey = key;
    if (!key) { if (this.tutorialArrow) this.tutorialArrow.visible = false; return; }
    if (!this.tutorialArrow) {
      const g = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: 0x22c55e });
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.4, 4), mat);
      cone.rotation.x = Math.PI;
      const stem = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.2, 0.4), mat);
      stem.position.y = 1.2;
      g.add(cone, stem);
      this.scene.add(g);
      this.tutorialArrow = g;
    }
  }

  private updateTutorialArrow() {
    const a = this.tutorialArrow;
    if (!a || !this.tutorialKey) return;
    let found = false;
    for (const v of this.views.values()) {
      if (!v.isMine) continue;
      const pad = v.padTargets().find((p) => p.def.key === this.tutorialKey);
      if (pad) { a.position.set(pad.x, 4.2 + Math.abs(Math.sin(this.elapsed * 3)) * 0.8, pad.z); a.rotation.y = this.elapsed * 2; found = true; }
    }
    a.visible = found;
  }

  // ---------------------------------------------------------- quality

  fps = 60;
  private lowFpsFor = 0;

  applyQuality(q: Quality) {
    this.quality = q;
    this.renderer.setPixelRatio(q.pixelRatio);
    this.renderer.shadowMap.enabled = q.shadows;
    this.world.sun.castShadow = q.shadows;
    if (this.world.sun.shadow.mapSize.x !== q.shadowMap) {
      this.world.sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
      this.world.sun.shadow.map?.dispose();
      this.world.sun.shadow.map = null;
    }
    this.scene.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; if (m) m.needsUpdate = true; });
    for (const v of this.views.values()) v.customers.maxVisible = q.maxNpcs;
    this.resize();
  }

  /** AUTO quality: step down if the device can't hold ~30 FPS. */
  private watchFps(dt: number) {
    this.fps += (1 / Math.max(dt, 0.001) - this.fps) * 0.05;
    if (qualitySetting() !== 'auto' || !this.inMatch) return;
    this.lowFpsFor = this.fps < 30 ? this.lowFpsFor + dt : 0;
    if (this.lowFpsFor > 6) {
      this.lowFpsFor = 0;
      const lower = lowerQuality(this.quality);
      if (lower) { this.applyQuality(lower); console.info('[quality] auto-lowered to', lower.name); }
    }
  }
}
