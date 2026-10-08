import * as THREE from 'three';
import { EVENTS, PLAYER } from '../../../shared/constants/config';
import { MEGA_MALL_PLOT, PLOT_LOCAL, PLOTS, POWER_SWITCHES, WORLD_BOUNDS, plotToWorld } from '../../../shared/constants/world';
import { formatMoney } from '../../../shared/game/economy';
import { q2 } from '../../../shared/protocol/codec';
import { C2S, EMOTES, EMOTE_COOLDOWN_MS, S2C, type InteractTarget, type MoveTuple } from '../../../shared/protocol/messages';
import { ANIM, type ActiveEvent, type BusinessState, type PlayerPublic, type RoomSnapshot } from '../../../shared/types/state';
import type { AudioManager } from '../audio/AudioManager';
import { createConstructionSite, createCrate, createDeliveryTruck, createMegaMall, TIER_SIZE } from '../business/BuildingFactory';
import { BusinessView } from '../business/BusinessView';
import { CLIENT, isTouch } from '../config/client';
import { resolveQuality, type Quality } from '../config/quality';
import { Interpolator } from '../multiplayer/Interpolator';
import type { Net } from '../multiplayer/Net';
import { Character } from '../player/Character';
import { World, type AABB } from '../world/World';
import { CameraRig } from './CameraRig';
import { Effects } from './Effects';
import { Input } from './Input';

export interface HudSink {
  prompt(text: string | null): void;
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

  private players = new Map<string, RemotePlayer>();
  private me: Character | null = null;
  private myPos = new THREE.Vector3();
  private myVelY = 0;
  private myRot = 0;
  private myAnim: number = ANIM.idle;
  private interactUntil = 0;
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
  private crates = new Map<number, THREE.Object3D>();
  private truck: THREE.Object3D | null = null;
  private currentTarget: { target: InteractTarget; label: string } | null = null;
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
        v.state.cash = t.cash; v.state.value = t.value; v.state.stats.customers = t.customers;
        v.updateTick(t.stock, t.queue);
        const rb = this.room?.businesses.find((b) => b.id === t.id);
        if (rb) Object.assign(rb, { cash: t.cash, stock: t.stock, queue: t.queue, value: t.value });
      }
    });
    n.on(S2C.BUSINESS_UPDATE, (m) => this.applyBusiness(m.b, true, m.cause, m.by));
    n.on(S2C.CUSTOMER_SPAWN, (m) => this.views.get(m.b)?.customers.spawn(m.id, m.g, m.arrive, m.side));
    n.on(S2C.CUSTOMER_SERVED, (m) => {
      const v = this.views.get(m.b);
      if (!v) return;
      const local = v.customers.served(m.id);
      const at = v.toWorld(local.setY(2.2));
      const mine = this.isMyBiz(m.b);
      this.effects.floatText(at, `+$${formatMoney(m.amt)}`, mine ? 'money' : 'money dim');
      if (this.near(at, 40)) this.effects.burst(at, 'coins', mine ? 8 : 4);
      if (mine) { this.audio.play('money'); this.hud.flashMoney(); }
    });
    n.on(S2C.CUSTOMER_LEFT, (m) => {
      const v = this.views.get(m.b);
      if (!v) return;
      const at = v.toWorld(v.customers.left(m.id).setY(2.4));
      this.effects.floatText(at, '😠', 'emoji');
    });
    n.on(S2C.DELIVERY_SALE, (m) => {
      const v = this.views.get(m.b);
      if (!v) return;
      const at = v.toWorld(new THREE.Vector3(14, 2.5, 0));
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
      return;
    }
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
      this.myRot = PLOTS[spawnPlot].dir > 0 ? -Math.PI / 2 : Math.PI / 2;
      // Camera on the plaza side, looking at your own business.
      this.rig.yaw = PLOTS[spawnPlot].dir > 0 ? Math.PI / 2 : -Math.PI / 2;
      this.rig.pitch = 0.5;
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
      v = new BusinessView(b.plot, accent, this.effects);
      v.onBuilt = (label, at) => {
        this.effects.floatText(at, `BUILD COMPLETE! ${label}`, 'big');
        this.audio.play('purchase');
      };
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
      if (cause === 'tier' && b.tier > prevTier) {
        this.audio.play('construction');
        if (mine) this.rig.shake(0.25);
        if (!mine) this.hud.toast(`🏗️ Соперник строит: уровень ${b.tier}`, 'info');
      } else if (cause.startsWith('upgrade')) {
        this.effects.burst(center, 'sparkle', 24);
        if (mine) this.audio.play('upgrade');
      } else if (cause.startsWith('hire') || cause.startsWith('structure')) {
        if (mine) this.audio.play(cause.startsWith('structure') ? 'construction' : 'purchase');
      } else if (cause === 'megamall') {
        this.showMegaMall(true);
      }
      if (by && by !== this.myId && mine && this.room?.mode !== 'vs') {
        const who = this.room?.players.find((p) => p.id === by)?.name ?? 'Напарник';
        this.hud.toast(`🤝 ${who}: ${cause.split(':')[0]}`, 'info');
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

  private clearMatchVisuals() {
    for (const v of this.views.values()) { v.clearDynamic(); this.scene.remove(v.root); }
    this.views.clear();
    if (this.megaSite) { this.scene.remove(this.megaSite); this.megaSite = null; }
    if (this.megaMall) { this.scene.remove(this.megaMall); this.megaMall = null; }
    this.applyEventVisuals(null);
    this.effects.clear();
    this.obstacles = [];
  }

  private rebuildObstacles() {
    const obs: Box2[] = [];
    const addBox = (cx: number, cz: number, w: number, d: number) => obs.push({ minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2 });
    for (const v of this.views.values()) {
      if (!v.state) continue;
      const pl = v.plot;
      const b = plotToWorld(pl, PLOT_LOCAL.building.lx, PLOT_LOCAL.building.lz);
      const size = Math.max(3, TIER_SIZE[v.state.tier - 1] + (v.state.tier >= 8 ? 3 : 0));
      addBox(b.x, b.z, size, size);
      const c = plotToWorld(pl, PLOT_LOCAL.counter.lx, PLOT_LOCAL.counter.lz);
      addBox(c.x, c.z, 1.4, 3.2);
      const m = plotToWorld(pl, PLOT_LOCAL.machine.lx, PLOT_LOCAL.machine.lz);
      addBox(m.x, m.z, 2.3, 2.1);
      for (const s of v.state.structures) {
        if (s === 'parking' || s === 'terrace' || s === 'billboard') continue;
        const at = PLOT_LOCAL.structures[s];
        const w = plotToWorld(pl, at.lx, at.lz);
        const size2 = s === 'fountain' ? 5 : 6;
        addBox(w.x, w.z, size2, size2);
      }
    }
    if (this.megaMall) addBox(PLOTS[MEGA_MALL_PLOT].x, PLOTS[MEGA_MALL_PLOT].z, 24, 26);
    addBox(0, 0, 8.6, 8.6); // central fountain
    this.obstacles = obs;
  }

  // -------------------------------------------------------------- events

  private applyEventVisuals(ev: ActiveEvent | null) {
    // Crates + truck for DELIVERY
    const want = ev?.kind === 'delivery' ? new Set(ev.crates ?? []) : new Set<number>();
    for (const [i, obj] of this.crates) {
      if (!want.has(i)) {
        this.effects.burst(obj.position.clone().setY(1), 'sparkle', 10);
        this.scene.remove(obj);
        this.crates.delete(i);
        this.audio.play('produce');
      }
    }
    const biz = this.room?.businesses[0];
    if (biz) {
      for (const i of want) {
        if (this.crates.has(i)) continue;
        const loc = PLOT_LOCAL.crates[i];
        const w = plotToWorld(biz.plot, loc.lx, loc.lz);
        const c = createCrate();
        c.position.set(w.x, 0, w.z);
        this.scene.add(c);
        this.crates.set(i, c);
      }
    }
    if (ev?.kind === 'delivery' && !this.truck && biz) {
      this.truck = createDeliveryTruck();
      const w = plotToWorld(biz.plot, 12, -12);
      this.truck.position.set(w.x, 0, w.z);
      this.scene.add(this.truck);
    } else if (ev?.kind !== 'delivery' && this.truck) {
      this.scene.remove(this.truck);
      this.truck = null;
    }
    // Power switches
    for (const s of POWER_SWITCHES) {
      if (ev?.kind !== 'power') this.world.setSwitchState(s.id, 'idle');
      else {
        const t = ev.switches?.[s.id] ?? 0;
        const on = t > 0 && this.net.serverNow() - t <= EVENTS.powerWindowMs;
        this.world.setSwitchState(s.id, on ? 'on' : 'alarm');
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

  private findTarget(): { target: InteractTarget; label: string } | null {
    if (!this.room || this.room.status !== 'playing') return null;
    const R = PLAYER.interactRadius;
    let best: { target: InteractTarget; label: string; d: number } | null = null;
    const consider = (x: number, z: number, target: InteractTarget, label: string) => {
      const d = Math.hypot(this.myPos.x - x, this.myPos.z - z);
      if (d <= R && (!best || d < best.d)) best = { target, label, d };
    };
    for (const v of this.views.values()) {
      if (!v.state?.ownerIds.includes(this.myId ?? '')) continue;
      const c = plotToWorld(v.plot, PLOT_LOCAL.counter.lx, PLOT_LOCAL.counter.lz);
      consider(c.x, c.z, { kind: 'counter', biz: v.state.id }, 'Обслужить клиента');
      const m = plotToWorld(v.plot, PLOT_LOCAL.machine.lx, PLOT_LOCAL.machine.lz);
      consider(m.x, m.z, { kind: 'machine', biz: v.state.id }, 'Произвести товар');
    }
    const ev = this.room.event;
    if (ev?.kind === 'delivery') {
      for (const [i, obj] of this.crates) consider(obj.position.x, obj.position.z, { kind: 'crate', index: i }, 'Разгрузить ящик');
    }
    if (ev?.kind === 'power') {
      for (const s of POWER_SWITCHES) consider(s.x, s.z, { kind: 'switch', id: s.id }, 'Включить рубильник');
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
      for (const v of this.views.values()) v.update(dt, serverNow, this.elapsed);
      if (this.room.event?.kind === 'power') this.applyEventVisuals(this.room.event);
      this.sendAcc += dt;
      if (this.sendAcc >= 1 / CLIENT.sendHz) { this.sendAcc = 0; this.sendMove(); }
      if (Math.floor(this.elapsed * 4) !== Math.floor((this.elapsed - dt) * 4)) this.updateTags();
    } else {
      // Menu: slow cinematic orbit over the city.
      const t = this.elapsed * 0.05;
      this.camera.position.set(Math.cos(t) * 58, 46, Math.sin(t) * 58);
      this.camera.lookAt(0, 2, 0);
    }
    this.effects.update(dt);
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
    const speed = PLAYER.runSpeed * mag;
    if (mag > 0.05) {
      this.myPos.x += (mx / Math.hypot(mx, mz)) * speed * dt;
      this.myPos.z += (mz / Math.hypot(mx, mz)) * speed * dt;
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
    this.hud.prompt(this.currentTarget ? `${isTouch ? '' : 'E — '}${this.currentTarget.label}` : null);
    if (this.input.consumeInteract() && this.currentTarget && room.status === 'playing') {
      this.net.send({ t: C2S.INTERACT, target: this.currentTarget.target });
      this.interactUntil = performance.now() + 350;
      const tk = this.currentTarget.target.kind;
      this.audio.play(tk === 'machine' ? 'produce' : 'ui');
      if (tk === 'machine') this.effects.burst(this.myPos.clone().setY(1.6), 'sparkle', 5);
    }

    if (this.ended === 'win') this.myAnim = ANIM.victory;
    else if (this.ended === 'lose') this.myAnim = ANIM.lose;
    else if (!this.grounded) this.myAnim = ANIM.jump;
    else if (performance.now() < this.interactUntil) this.myAnim = ANIM.interact;
    else this.myAnim = mag > 0.05 ? (mag < 0.55 ? ANIM.walk : ANIM.run) : ANIM.idle;
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
      ch.setTag(l.name, l.money, hex(p.color));
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
}
