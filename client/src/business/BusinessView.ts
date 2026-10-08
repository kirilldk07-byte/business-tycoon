import * as THREE from 'three';
import {
  STRUCTURES, STRUCTURE_IDS, TIERS, VENUES, VENUE_IDS, WORKERS, WORKER_IDS, type StructureId, type VenueId, type WorkerId,
} from '../../../shared/constants/config';
import { PLOT_LOCAL, PLOTS } from '../../../shared/constants/world';
import { CUSTOMER_KIND } from '../../../shared/events';
import {
  checkStructure, checkTier, checkVenue, checkWorker, formatMoney, nextVenue, tierCost, venueCost, venueUnlocked, workerCost,
} from '../../../shared/game/economy';
import type { ClientMsg } from '../../../shared/protocol/messages';
import type { BusinessState } from '../../../shared/types/state';
import type { Effects } from '../game/Effects';
import type { Crowd } from '../npc/Crowd';
import { CustomerManager, type SpecialMarker } from '../npc/CustomerManager';
import { LabelSprite } from '../player/Character';
import { GeoBuilder, makeSign } from '../world/geo';
import {
  TIER_HEIGHT, TIER_SIZE, createCounter, createMachine, createStructure, createTierBuilding, createVenue,
} from './BuildingFactory';

// One business plot: HQ tier chain, secondary venues, structures, staff,
// purchase pads and customers. Everything is driven by authoritative
// BusinessState; visuals (construction, particles) are played locally.

export interface PadDef {
  key: string;
  lx: number;
  lz: number;
  icon: string;
  title: string;
  price: number | null;
  state: 'ok' | 'poor' | 'locked';
  note?: string;
  send?: ClientMsg;
  open?: 'upgrades';
}

interface PadVisual { group: THREE.Group; disc: THREE.Mesh; ring: THREE.Mesh; label: LabelSprite; def: PadDef; pending: number; focus: number; want: number }
interface BuildAnim { target: THREE.Object3D; extra: THREE.Object3D[]; t: number; dur: number; label: string; dust: number; sink?: boolean; size: number }
interface Staff { kind: WorkerId; idx: number; slot: number; x: number; z: number; rot: number; props: THREE.Object3D | null }

const PAD_COLORS = { ok: 0x22c55e, poor: 0xf59e0b, locked: 0x94a3b8 };
const discGeo = new THREE.CircleGeometry(1.25, 28);
const ringGeo = new THREE.RingGeometry(1.25, 1.5, 32);
const padMats = Object.fromEntries(Object.entries(PAD_COLORS).map(([k, c]) => [k, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.55, depthWrite: false })])) as Record<PadDef['state'], THREE.MeshBasicMaterial>;
const ringMats = Object.fromEntries(Object.entries(PAD_COLORS).map(([k, c]) => [k, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9, depthWrite: false })])) as Record<PadDef['state'], THREE.MeshBasicMaterial>;
const auraGeo = new THREE.RingGeometry(0.6, 1.0, 24);
const auraMats = {
  [CUSTOMER_KIND.golden]: new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }),
  [CUSTOMER_KIND.vip]: new THREE.MeshBasicMaterial({ color: 0xa855f7, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }),
} as Record<number, THREE.MeshBasicMaterial>;

const STAFF_SHIRTS: Record<WorkerId, number> = { cashier: 0x0ea5e9, worker: 0xf59e0b, manager: 0x1f2937, delivery: 0xdc2626, marketer: 0xec4899 };
const PAD_LABEL_SCALE = 3.1;
const STAFF_OFFSETS = [[0, 0], [0, 1.4], [0, -1.4]];

export class BusinessView {
  readonly root = new THREE.Group();
  readonly customers: CustomerManager;
  private hqSlot = new THREE.Group();
  private hq: THREE.Object3D | null = null;
  private tier = 0;
  private venueSlots: THREE.Group[] = [];
  private venueObjs = new Map<VenueId, { obj: THREE.Object3D; level: number }>();
  private structures = new Map<StructureId, THREE.Object3D>();
  private staff: Staff[] = [];
  private pads = new Map<string, PadVisual>();
  private anims: BuildAnim[] = [];
  private counter: THREE.Group;
  private machine: THREE.Group;
  private stockBar: THREE.Mesh;
  private counterTag = new LabelSprite(400, 80, 4);
  private machineTag = new LabelSprite(400, 80, 4);
  private ownerSign: THREE.Mesh | null = null;
  private emptyLot: THREE.Group;
  private spinners: THREE.Object3D[] = [];
  private auras: THREE.Mesh[] = [];
  private specials: SpecialMarker[] = [];
  private payAgg = new Map<string, { pos: THREE.Vector3; amt: number; t: number }>();
  private lastSaleAt = 0;
  /** Persistent visuals for upgrade levels (so every purchase is visible, not just a number). */
  private upgradeProps: THREE.Object3D | null = null;
  private upgradeKey = '';
  private balloons: THREE.Object3D[] = [];
  private smokeAcc = 0;
  private lastReaction = -99;
  private reactions: { at: THREE.Vector3; delay: number }[] = [];
  private time = 0;
  state: BusinessState | null = null;
  onBuilt: (label: string, at: THREE.Vector3, big: boolean) => void = () => {};
  onPay: (amt: number) => void = () => {};

  constructor(public plot: number, public accent: number, private effects: Effects, private crowd: Crowd, maxNpcs: number, public isMine: boolean) {
    const p = PLOTS[plot];
    this.root.position.set(p.x, 0, p.z);
    this.root.rotation.y = p.dir > 0 ? 0 : Math.PI;
    this.root.updateMatrixWorld();
    this.hqSlot.position.set(PLOT_LOCAL.building.lx, 0, PLOT_LOCAL.building.lz);
    this.root.add(this.hqSlot);

    PLOT_LOCAL.venues.forEach((v) => {
      const g = new THREE.Group();
      g.position.set(v.lx, 0, v.lz);
      g.rotation.y = v.lz > 0 ? Math.PI : 0; // door faces the central aisle
      this.root.add(g);
      this.venueSlots.push(g);
    });

    // Empty-lot markers (dashed outlines) show where businesses will rise.
    const lot = new GeoBuilder();
    const outline = (cx: number, cz: number, w: number, d: number) => {
      for (let i = -w / 2; i < w / 2; i += 1.2) { lot.flat(0.6, 0.18, 0xffffff, cx + i + 0.3, 0.05, cz - d / 2); lot.flat(0.6, 0.18, 0xffffff, cx + i + 0.3, 0.05, cz + d / 2); }
      for (let i = -d / 2; i < d / 2; i += 1.2) { lot.flat(0.18, 0.6, 0xffffff, cx - w / 2, 0.05, cz + i + 0.3); lot.flat(0.18, 0.6, 0xffffff, cx + w / 2, 0.05, cz + i + 0.3); }
    };
    outline(PLOT_LOCAL.building.lx, 0, 13, 13);
    PLOT_LOCAL.venues.forEach((v) => outline(v.lx, v.lz, 9.5, 8.5));
    this.emptyLot = lot.build(false);
    this.root.add(this.emptyLot);

    this.counter = createCounter(accent);
    this.counter.position.set(PLOT_LOCAL.counter.lx, 0, PLOT_LOCAL.counter.lz);
    this.root.add(this.counter);
    this.counterTag.sprite.position.set(PLOT_LOCAL.counter.lx, 2.6, 0);
    this.root.add(this.counterTag.sprite);

    this.machine = createMachine(accent);
    this.machine.position.set(PLOT_LOCAL.machine.lx, 0, PLOT_LOCAL.machine.lz);
    this.root.add(this.machine);
    this.stockBar = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1, 0.3).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0x22c55e }));
    this.stockBar.position.set(PLOT_LOCAL.machine.lx + 1.25, 0.2, PLOT_LOCAL.machine.lz + 0.8);
    this.root.add(this.stockBar);
    this.machineTag.sprite.position.set(PLOT_LOCAL.machine.lx, 4, PLOT_LOCAL.machine.lz);
    this.root.add(this.machineTag.sprite);
    this.setFlagshipVisible(false);

    // Entrance arch
    const arch = new GeoBuilder();
    for (const z of [-3.6, 3.6]) arch.box(0.5, 3.8, 0.5, accent, PLOT_LOCAL.entrance.lx, 0, z);
    arch.box(0.6, 0.6, 7.7, accent, PLOT_LOCAL.entrance.lx, 3.8, 0);
    this.root.add(arch.build(true));

    for (let i = 0; i < 4; i++) {
      const a = new THREE.Mesh(auraGeo, auraMats[CUSTOMER_KIND.golden]);
      a.rotation.x = -Math.PI / 2;
      a.visible = false;
      this.root.add(a);
      this.auras.push(a);
    }
    this.customers = new CustomerManager(this.root, crowd, maxNpcs);
  }

  setOwnerLabel(text: string, color: string) {
    if (this.ownerSign) this.root.remove(this.ownerSign);
    const s = makeSign(text, 7.2, 1.1, '#0f172a', color);
    s.position.set(PLOT_LOCAL.entrance.lx + 0.32, 3.5, 0);
    this.root.add(s);
    this.ownerSign = s;
  }

  toWorld(local: THREE.Vector3) { return this.root.localToWorld(local.clone()); }

  private setFlagshipVisible(v: boolean) {
    this.counter.visible = v;
    this.machine.visible = v;
    this.stockBar.visible = v;
    this.counterTag.sprite.visible = v;
    this.machineTag.sprite.visible = v;
  }

  // ------------------------------------------------------------- state

  apply(s: BusinessState, animate: boolean) {
    const prev = this.state;
    this.state = s;
    if (s.tier !== this.tier) this.setTier(s.tier, animate && s.tier > this.tier);
    this.setFlagshipVisible(s.tier >= 1);
    for (const vid of VENUE_IDS) {
      const lvl = s.venues[vid];
      const cur = this.venueObjs.get(vid);
      if (lvl > 0 && (!cur || cur.level !== lvl)) this.setVenue(vid, lvl, animate);
    }
    for (const id of s.structures) if (!this.structures.has(id)) this.addStructure(id, animate);
    for (const [id, obj] of this.structures) if (!s.structures.includes(id)) { this.root.remove(obj); this.structures.delete(id); }
    this.syncUpgradeProps(s, animate && !!prev);
    this.syncStaff(s, animate && !!prev);
    this.updateTags();
    this.rebuildPads();
  }

  updateTick(stock: number, queue: number, cash: number) {
    if (!this.state) return;
    const cashChanged = Math.floor(this.state.cash / 50) !== Math.floor(cash / 50);
    this.state.stock = stock;
    this.state.queue = queue;
    this.state.cash = cash;
    this.updateTags();
    if (cashChanged) this.rebuildPads(); // affordability colors
  }

  private updateTags() {
    const s = this.state!;
    this.counterTag.draw([{ text: `👥 ${s.queue}  ·  E: обслужить`, color: '#fff', size: 30 }]);
    this.machineTag.draw([{ text: `📦 ${formatMoney(s.stock)}  ·  E: сделать`, color: s.stock < 1 ? '#fca5a5' : '#fff', size: 30 }]);
    this.stockBar.scale.y = Math.max(0.05, Math.min(2.5, s.stock / 20));
    (this.stockBar.material as THREE.MeshStandardMaterial).color.setHex(s.stock < 1 ? 0xef4444 : 0x22c55e);
  }

  private setTier(tier: number, animate: boolean) {
    const old = this.hq;
    this.tier = tier;
    if (tier === 0) { if (old) this.hqSlot.remove(old); this.hq = null; return; }
    const next = createTierBuilding(tier, this.accent);
    this.hq = next;
    this.collectSpinners(next);
    if (!animate) { if (old) this.hqSlot.remove(old); this.hqSlot.add(next); return; }
    if (old) this.anims.push({ target: old, extra: [], t: 0, dur: 0.4, label: '', dust: 0, sink: true, size: 0 });
    this.startBuild(next, this.hqSlot, TIER_SIZE[tier - 1], `${TIERS[tier - 1].icon} ${TIERS[tier - 1].name}`, TIER_HEIGHT[tier - 1]);
  }

  private setVenue(id: VenueId, level: number, animate: boolean) {
    const idx = VENUE_IDS.indexOf(id);
    const slot = this.venueSlots[idx];
    const cur = this.venueObjs.get(id);
    const obj = createVenue(id, level);
    this.collectSpinners(obj);
    this.venueObjs.set(id, { obj, level });
    if (!animate) { if (cur) slot.remove(cur.obj); slot.add(obj); return; }
    if (cur) this.anims.push({ target: cur.obj, extra: [], t: 0, dur: 0.35, label: '', dust: 0, sink: true, size: 0 });
    this.startBuild(obj, slot, 9, `${VENUES[id].icon} ${VENUES[id].name}${level > 1 ? ` ★${level}` : ''}`, 6);
  }

  private addStructure(id: StructureId, animate: boolean) {
    const g = createStructure(id, this.accent);
    this.collectSpinners(g);
    const at = PLOT_LOCAL.structures[id];
    const holder = new THREE.Group();
    holder.position.set(at.lx, 0, at.lz);
    this.root.add(holder);
    this.structures.set(id, holder);
    if (!animate) { holder.add(g); return; }
    this.startBuild(g, holder, 5, `${STRUCTURES[id].icon} ${STRUCTURES[id].name}`, 4);
  }

  private collectSpinners(o: THREE.Object3D) {
    o.traverse((c) => { if (c.name === 'spin') this.spinners.push(c); });
  }

  /** Foundation + glowing activation ring + scaffold, then the building rises (≈1.6 s). */
  private startBuild(obj: THREE.Object3D, parent: THREE.Object3D, size: number, label: string, height: number) {
    const b = new GeoBuilder();
    b.box(size + 1, 0.22, size + 1, 0x9ca3af);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.box(0.2, Math.min(8, height * 0.7), 0.2, 0xf59e0b, (x * (size + 1)) / 2, 0, (z * (size + 1)) / 2);
    const scaffold = b.build(false);
    parent.add(scaffold);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.6, 40), new THREE.MeshBasicMaterial({ color: 0x86efac, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.3;
    parent.add(ring);
    obj.scale.set(1, 0.001, 1);
    parent.add(obj);
    this.anims.push({ target: obj, extra: [scaffold, ring], t: 0, dur: 1.6, label, dust: 0, size });
  }

  // ------------------------------------------------------------- upgrade props

  private syncUpgradeProps(s: BusinessState, animate: boolean) {
    const u = s.upgrades;
    const key = s.tier >= 1 ? `${u.capacity}|${u.customers}|${u.price}|${u.speed}|${u.production}` : '';
    if (key === this.upgradeKey) return;
    this.upgradeKey = key;
    if (this.upgradeProps) this.root.remove(this.upgradeProps);
    this.upgradeProps = null;
    this.balloons = [];
    if (!key) return;
    const b = new GeoBuilder();
    const cx = PLOT_LOCAL.counter.lx;
    // CAPACITY: velvet-rope queue lane grows with the level.
    const posts = 2 + u.capacity; // ends before x≈11 where customers join the lane
    for (let i = 0; i < posts; i++) {
      const x = cx + 2.4 + i * 1.6;
      for (const z of [-0.95, 0.95]) {
        b.cyl(0.06, 0.95, 0xd4af37, x, 0, z, 6);
        b.blob(0.1, 0xd4af37, x, 0.98, z, 1);
        if (i > 0) b.box(1.6, 0.06, 0.06, 0xb91c1c, x - 0.8, 0.82, z);
      }
    }
    // PRICE: golden stars over the counter.
    for (let i = 0; i < u.price; i++) b.add(new THREE.OctahedronGeometry(0.22, 0), 0xfacc15, 1, 1, 1, { x: cx, y: 3.3, z: (i - (u.price - 1) / 2) * 0.55 });
    // SPEED: green neon bars on the counter front.
    for (let i = 0; i < u.speed; i++) b.box(0.06, 0.12, 2.6, 0x4ade80, cx + 0.72, 0.25 + i * 0.16, 0);
    // PRODUCTION: indicator lamps on the machine.
    for (let i = 0; i < u.production; i++) b.blob(0.13, 0xf97316, PLOT_LOCAL.machine.lx + 1.2, 0.5 + i * 0.3, PLOT_LOCAL.machine.lz - 0.9, 1);
    const g = b.build(false);
    // CUSTOMERS: balloon bunches at the entrance arch (animated).
    const colors = [0xef4444, 0x3b82f6, 0xfacc15, 0x22c55e, 0xec4899, 0xa855f7];
    for (let i = 0; i < u.customers; i++) {
      const bb = new GeoBuilder();
      bb.cyl(0.015, 2.2, 0xe5e7eb, 0, -2.2, 0, 6);
      bb.blob(0.42, colors[i % colors.length], 0, 0.2, 0, 1.25);
      const m = bb.build(false);
      m.position.set(PLOT_LOCAL.entrance.lx + 0.4, 4.4 + (i % 3) * 0.35, (i % 2 ? 1 : -1) * (3.6 + Math.floor(i / 2) * 0.55));
      m.userData.y = m.position.y;
      g.add(m);
      this.balloons.push(m);
    }
    this.root.add(g);
    this.upgradeProps = g;
    if (animate && this.isMine) this.effects.burst(this.toWorld(new THREE.Vector3(cx, 2.5, 0)), 'sparkle', 16);
  }

  // ------------------------------------------------------------- staff

  private syncStaff(s: BusinessState, animate: boolean) {
    for (const kind of WORKER_IDS) {
      const want = s.workers[kind];
      const have = this.staff.filter((x) => x.kind === kind);
      for (let i = have.length; i < want; i++) {
        const base = PLOT_LOCAL.staff[kind];
        const off = STAFF_OFFSETS[i];
        const slot = this.crowd.alloc({ shirt: STAFF_SHIRTS[kind], pants: 0x1f2937, skin: [0xf6d0b1, 0xc98e66, 0xe8b48f][i], hair: [0x2b1b12, 0xd9a441, 0x111827][i], hairStyle: i % 3, fixed: true });
        const st: Staff = { kind, idx: i, slot, x: base.lx + off[0], z: base.lz + off[1], rot: kind === 'cashier' ? Math.PI / 2 : -Math.PI / 2, props: this.staffProps(kind, base.lx + off[0], base.lz + off[1]) };
        this.staff.push(st);
        if (animate) this.effects.burst(this.toWorld(new THREE.Vector3(st.x, 1.2, st.z)), 'sparkle', 18);
      }
      for (const st of have.slice(want)) {
        this.crowd.release(st.slot);
        if (st.props) this.root.remove(st.props);
        this.staff = this.staff.filter((x) => x !== st);
      }
    }
  }

  private staffProps(kind: WorkerId, x: number, z: number): THREE.Object3D | null {
    const b = new GeoBuilder();
    if (kind === 'manager') {
      b.box(1.8, 0.1, 1, 0x8b5a2b, 0, 0.75, 0); b.box(0.1, 0.75, 0.9, 0x8b5a2b, -0.85, 0, 0); b.box(0.1, 0.75, 0.9, 0x8b5a2b, 0.85, 0, 0);
      b.box(0.6, 0.38, 0.05, 0x111827, 0, 0.85, 0.2);
    } else if (kind === 'delivery') {
      b.box(0.5, 0.45, 1.6, 0xdc2626, 0, 0.3, 0); b.box(0.7, 0.6, 0.6, 0xffffff, 0, 0.75, -0.55);
      b.add(new THREE.CylinderGeometry(1, 1, 1, 10), 0x111827, 0.3, 0.15, 0.3, { y: 0.3, z: 0.65, rz: Math.PI / 2 });
      b.add(new THREE.CylinderGeometry(1, 1, 1, 10), 0x111827, 0.3, 0.15, 0.3, { y: 0.3, z: -0.65, rz: Math.PI / 2 });
    } else if (kind === 'marketer') {
      b.cyl(0.05, 1.8, 0x6b7280, 0.6, 0, 0, 6);
    } else return null;
    const g = b.build(true);
    if (kind === 'marketer') {
      const s = makeSign('SALE!', 1.4, 0.8, '#ec4899', '#ffffff');
      s.position.set(0.6, 2.1, 0);
      g.add(s);
    }
    g.position.set(x, 0, z + (kind === 'manager' ? -0.9 : 0));
    this.root.add(g);
    return g;
  }

  private animateStaff() {
    const v = new THREE.Vector3();
    const rootRot = this.root.rotation.y;
    const recentSale = performance.now() - this.lastSaleAt < 400;
    for (const st of this.staff) {
      if (st.slot < 0) continue;
      const t = this.time + st.idx * 0.7;
      let x = st.x, z = st.z, rot = st.rot, armL: number | undefined, armR: number | undefined, bob = 0;
      switch (st.kind) {
        case 'cashier': armR = recentSale ? -1.4 : -0.3 + Math.sin(t * 2) * 0.1; armL = -0.3; break;
        case 'worker': armR = -1.6 + Math.abs(Math.sin(t * 6)) * 1.2; armL = -0.6; rot = Math.PI / 2; break; // hammering
        case 'manager': armL = armR = -1.0 + Math.sin(t * 14) * 0.08; rot = Math.PI; break; // typing at the desk
        case 'marketer': armR = -2.4 + Math.sin(t * 4) * 0.4; armL = -0.2; rot = Math.PI / 2; bob = Math.abs(Math.sin(t * 4)) * 0.05; break;
        case 'delivery': {
          // ride a short loop along the front: out and back
          const k = (Math.sin(t * 0.6) + 1) / 2;
          z = st.z - k * 7;
          rot = Math.cos(t * 0.6) > 0 ? Math.PI : 0;
          if (st.props) { st.props.position.set(st.x, 0, z); st.props.rotation.y = rot; }
          armL = armR = -1.2; bob = 0.45;
          break;
        }
      }
      v.set(x, 0, z);
      this.root.localToWorld(v);
      this.crowd.pose(st.slot, v.x, bob, v.z, rot + rootRot, 0, 0, 1, 0, 0, armL, armR);
    }
  }

  // ------------------------------------------------------------- pads

  /** Purchase pads for the owner. Each pad only REQUESTS a purchase; the server decides. */
  private computePads(s: BusinessState): PadDef[] {
    if (!this.isMine) return [];
    const pads: PadDef[] = [];
    const st = (ok: boolean, code?: string): PadDef['state'] => (ok ? 'ok' : code === 'LOCKED' ? 'locked' : 'poor');
    if (s.tier < TIERS.length) {
      const c = checkTier(s);
      const pos = s.tier === 0 ? { lx: 3, lz: 0 } : PLOT_LOCAL.pads.hq; // first pad a few steps from spawn
      pads.push({
        key: 'hq', ...pos, icon: TIERS[s.tier].icon, title: s.tier === 0 ? 'COFFEE STAND' : `HQ → ${TIERS[s.tier].name}`,
        price: tierCost(s.tier + 1), state: st(c.ok, c.ok ? undefined : c.code), send: { t: 'BUILD_BUSINESS', kind: 'tier' },
      });
    }
    if (s.tier < 1) return pads;
    pads.push({ key: 'upgrades', ...PLOT_LOCAL.pads.upgrades, icon: '⬆️', title: 'UPGRADE SHOP', price: null, state: 'ok', open: 'upgrades' });
    const nv = nextVenue(s);
    if (nv) {
      const i = VENUE_IDS.indexOf(nv);
      const c = checkVenue(s, nv);
      const unlocked = venueUnlocked(s, nv);
      pads.push({
        key: `venue:${nv}`, lx: PLOT_LOCAL.venues[i].lx, lz: PLOT_LOCAL.venues[i].lz, icon: VENUES[nv].icon, title: VENUES[nv].name.toUpperCase(),
        price: venueCost(nv, 0), state: unlocked ? st(c.ok) : 'locked', note: unlocked ? undefined : `нужен HQ ур. ${VENUES[nv].minTier}`,
        send: { t: 'BUILD_BUSINESS', kind: 'venue', id: nv },
      });
    }
    VENUE_IDS.forEach((vid, i) => {
      const lvl = s.venues[vid];
      if (!lvl || lvl >= 3) return;
      const c = checkVenue(s, vid);
      const v = PLOT_LOCAL.venues[i];
      pads.push({
        key: `expand:${vid}`, lx: v.lx + 3.2, lz: Math.sign(v.lz) * (Math.abs(v.lz) - 6.4), icon: '★', title: `EXPAND ${VENUES[vid].name}`,
        price: venueCost(vid, lvl), state: st(c.ok), send: { t: 'BUILD_BUSINESS', kind: 'venue', id: vid },
      });
    });
    // Staff pads are revealed progressively so the first minutes stay simple.
    const reveal: Record<WorkerId, number> = { cashier: 1, worker: 1, marketer: 2, delivery: 2, manager: 3 };
    for (const w of WORKER_IDS) {
      if (s.tier < reveal[w] || s.workers[w] >= WORKERS[w].max) continue;
      const c = checkWorker(s, w);
      pads.push({ key: `hire:${w}`, ...PLOT_LOCAL.pads.workers[w], icon: WORKERS[w].icon, title: `HIRE ${WORKERS[w].name}`, price: workerCost(w, s.workers[w]), state: st(c.ok), send: { t: 'HIRE_WORKER', id: w } });
    }
    for (const sid of STRUCTURE_IDS) {
      if (s.structures.includes(sid) || s.tier < STRUCTURES[sid].minTier) continue;
      const c = checkStructure(s, sid);
      pads.push({ key: `struct:${sid}`, ...PLOT_LOCAL.structures[sid], icon: STRUCTURES[sid].icon, title: STRUCTURES[sid].name.toUpperCase(), price: STRUCTURES[sid].cost, state: st(c.ok), send: { t: 'BUILD_BUSINESS', kind: 'structure', id: sid } });
    }
    return pads;
  }

  private rebuildPads() {
    if (!this.state) return;
    const defs = this.computePads(this.state);
    const keep = new Set(defs.map((d) => d.key));
    for (const [k, p] of this.pads) if (!keep.has(k)) { this.root.remove(p.group); this.pads.delete(k); }
    for (const d of defs) {
      let p = this.pads.get(d.key);
      if (!p) {
        const group = new THREE.Group();
        const disc = new THREE.Mesh(discGeo, padMats[d.state]);
        disc.rotation.x = -Math.PI / 2; disc.position.y = 0.08;
        const ring = new THREE.Mesh(ringGeo, ringMats[d.state]);
        ring.rotation.x = -Math.PI / 2; ring.position.y = 0.09;
        const label = new LabelSprite(420, 150, PAD_LABEL_SCALE);
        label.sprite.position.y = 2.4;
        group.add(disc, ring, label.sprite);
        this.root.add(group);
        p = { group, disc, ring, label, def: d, pending: 0, focus: 1, want: 1 };
        this.pads.set(d.key, p);
      }
      p.def = d;
      p.group.position.set(d.lx, 0, d.lz);
      p.disc.material = padMats[d.state];
      p.ring.material = ringMats[d.state];
      const priceLine = d.price === null ? 'Открыть' : d.state === 'locked' ? `🔒 ${d.note ?? 'недоступно'}` : `$${formatMoney(d.price)}`;
      p.label.draw([
        { text: `${d.icon} ${d.title}`, color: '#ffffff', size: 34 },
        { text: priceLine, color: d.state === 'ok' ? '#bbf7d0' : d.state === 'poor' ? '#fcd34d' : '#cbd5e1', size: 40 },
      ], d.state === 'ok' ? 'rgba(21,128,61,0.85)' : 'rgba(15,23,42,0.78)');
    }
  }

  /** Pads in world space for interaction lookup. */
  padTargets(): { def: PadDef; x: number; z: number }[] {
    const out: { def: PadDef; x: number; z: number }[] = [];
    const v = new THREE.Vector3();
    for (const p of this.pads.values()) {
      v.set(p.def.lx, 0, p.def.lz);
      this.root.localToWorld(v);
      out.push({ def: p.def, x: v.x, z: v.z });
    }
    return out;
  }

  /**
   * Declutter: only the pads closest to the player show a full-size label;
   * the rest shrink to small hints and far ones disappear.
   */
  focusPads(px: number, pz: number) {
    const v = new THREE.Vector3();
    const list: { p: PadVisual; d: number }[] = [];
    for (const p of this.pads.values()) {
      v.set(p.def.lx, 0, p.def.lz);
      this.root.localToWorld(v);
      list.push({ p, d: Math.hypot(v.x - px, v.z - pz) });
    }
    list.sort((a, b) => a.d - b.d);
    list.forEach(({ p, d }, i) => { p.want = d > 30 ? 0 : i < 3 && d < 18 ? 1 : 0.5; });
  }

  markPending(key: string) {
    const p = this.pads.get(key);
    if (p) p.pending = 0.6;
  }

  // ------------------------------------------------------------- customers

  onCustomers(sp?: number[], pd?: number[], lf?: number[]) {
    if (sp) for (let i = 0; i + 4 < sp.length; i += 5) this.customers.spawn(sp[i], sp[i + 1], sp[i + 2], sp[i + 3], sp[i + 4]);
    if (pd) {
      for (let i = 0; i + 1 < pd.length; i += 2) {
        const local = this.customers.paid(pd[i]);
        const amt = pd[i + 1];
        if (local.x < PLOT_LOCAL.counter.lx + 3) this.lastSaleAt = performance.now();
        const key = `${Math.round(local.x)}:${Math.round(local.z)}`;
        const agg = this.payAgg.get(key) ?? { pos: local.clone().setY(2.4), amt: 0, t: 0 };
        agg.amt += amt;
        this.payAgg.set(key, agg);
        // Rare happy reaction (max one every 2.5 s per business) — feedback without spam.
        if (this.time - this.lastReaction > 2.5 && Math.random() < 0.12) {
          this.lastReaction = this.time;
          this.reactions.push({ at: this.toWorld(local.clone().setY(2.6)), delay: 0.25 });
        }
        this.onPay(amt);
      }
    }
    if (lf) for (const id of lf) {
      const at = this.toWorld(this.customers.left(id).setY(2.5));
      this.effects.floatText(at, '😠', 'emoji');
    }
  }

  // ------------------------------------------------------------- frame

  update(dt: number, serverNow: number, time: number, nearCamera: boolean) {
    this.time = time;
    for (let i = this.anims.length - 1; i >= 0; i--) {
      const a = this.anims[i];
      a.t += dt;
      const k = Math.min(1, a.t / a.dur);
      if (a.sink) {
        a.target.scale.y = Math.max(0.001, 1 - k);
        if (k >= 1) { a.target.parent?.remove(a.target); this.anims.splice(i, 1); }
        continue;
      }
      const ring = a.extra[1] as THREE.Mesh;
      ring.scale.setScalar(1 + k * a.size * 1.2);
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
      const rise = Math.max(0, (k - 0.15) / 0.85);
      const e = rise < 1 ? 1 + 2.2 * Math.pow(rise - 1, 3) + 1.2 * Math.pow(rise - 1, 2) : 1;
      a.target.scale.y = Math.max(0.001, e);
      a.dust -= dt;
      if (a.dust <= 0 && k < 0.9 && nearCamera) { a.dust = 0.2; this.effects.burst(a.target.getWorldPosition(new THREE.Vector3()), 'dust', 6); }
      if (k >= 1) {
        a.target.scale.y = 1;
        for (const x of a.extra) x.parent?.remove(x);
        this.anims.splice(i, 1);
        const at = a.target.getWorldPosition(new THREE.Vector3()).setY(4.5);
        if (nearCamera) { this.effects.burst(at, 'sparkle', 40); this.effects.burst(at.clone().setY(0.5), 'dust', 14); this.effects.flash(at.clone().setY(a.size * 0.35), a.size * 0.8); }
        this.onBuilt(a.label, at, a.size >= 8);
      }
    }
    for (const sp of this.spinners) sp.rotation.y = time * 1.2;
    const prod = this.state?.upgrades.production ?? 0;
    const gear = this.machine.getObjectByName('gear');
    if (gear) gear.rotation.z = time * (3 + prod * 1.5);
    for (let i = 0; i < this.balloons.length; i++) {
      const bl = this.balloons[i];
      bl.position.y = bl.userData.y + Math.sin(time * 1.6 + i * 1.3) * 0.18;
      bl.rotation.z = Math.sin(time * 1.1 + i) * 0.08;
    }
    // Production smoke: denser with each PRODUCTION level (only when the camera is close).
    if (nearCamera && this.tier >= 1 && prod > 0) {
      this.smokeAcc += dt * (0.4 + prod * 0.35);
      if (this.smokeAcc >= 1) { this.smokeAcc = 0; this.effects.burst(this.toWorld(new THREE.Vector3(PLOT_LOCAL.machine.lx, 3.2, PLOT_LOCAL.machine.lz)), 'smoke', 1); }
    }
    for (const p of this.pads.values()) {
      const s = 1 + Math.sin(time * 4) * 0.08 + p.pending * 0.6;
      p.ring.scale.set(s, s, s);
      p.focus += (p.want - p.focus) * Math.min(1, dt * 6);
      const ls = PAD_LABEL_SCALE * (0.35 + 0.65 * p.focus);
      p.label.sprite.scale.set(ls, (ls * 150) / 420, 1);
      p.label.sprite.material.opacity = Math.min(1, p.focus * 1.6);
      p.label.sprite.visible = p.focus > 0.04;
      p.label.sprite.position.y = 1.2 + ls * 0.36 + Math.sin(time * 2 + p.group.position.x) * 0.08;
      if (p.pending > 0) p.pending = Math.max(0, p.pending - dt);
    }
    this.customers.update(dt, serverNow);
    this.animateStaff();
    // Golden / VIP auras
    this.specials.length = 0;
    this.customers.specials(this.specials);
    this.auras.forEach((a, i) => {
      const sp = this.specials[i];
      a.visible = !!sp;
      if (!sp) return;
      a.material = auraMats[sp.kind];
      a.position.set(sp.x, 0.1, sp.z);
      a.scale.setScalar(1 + Math.sin(time * 6) * 0.15);
      if (nearCamera && Math.random() < dt * 6) this.effects.burst(this.toWorld(new THREE.Vector3(sp.x, 1.6, sp.z)), 'sparkle', 2);
    });
    for (let i = this.reactions.length - 1; i >= 0; i--) {
      const r = this.reactions[i];
      r.delay -= dt;
      if (r.delay > 0) continue;
      this.reactions.splice(i, 1);
      if (nearCamera) this.effects.floatText(r.at, ['❤️', '⭐', '😍', '👍'][Math.floor(Math.random() * 4)], 'emoji');
    }
    // Aggregated money floats (one label per spot every ~0.8 s — no DOM spam)
    for (const [k, agg] of this.payAgg) {
      agg.t += dt;
      if (agg.t < 0.8) continue;
      this.payAgg.delete(k);
      if (!nearCamera) continue;
      const at = this.toWorld(agg.pos);
      this.effects.floatText(at, `💰 +$${formatMoney(agg.amt)}`, this.isMine ? 'money' : 'money dim');
      this.effects.burst(at, 'coins', Math.min(10, 3 + Math.floor(Math.log10(agg.amt + 1) * 2)));
    }
  }

  /** Big objects the camera must not pass through. */
  cameraBlockers(): THREE.Object3D[] {
    return [this.hqSlot, ...this.venueSlots.filter((s) => s.children.length > 0)];
  }

  /** Footprints for player collision (plot-local). */
  footprints(): { lx: number; lz: number; w: number; d: number }[] {
    const out: { lx: number; lz: number; w: number; d: number }[] = [];
    if (this.tier >= 1) {
      const s = TIER_SIZE[this.tier - 1];
      out.push({ lx: PLOT_LOCAL.building.lx, lz: 0, w: s, d: s });
      out.push({ lx: PLOT_LOCAL.counter.lx, lz: 0, w: 1.4, d: 3.3 });
      out.push({ lx: PLOT_LOCAL.machine.lx, lz: PLOT_LOCAL.machine.lz, w: 2.3, d: 2.1 });
    }
    VENUE_IDS.forEach((vid, i) => {
      if (!this.state?.venues[vid]) return;
      const v = PLOT_LOCAL.venues[i];
      out.push({ lx: v.lx, lz: v.lz, w: 9.4, d: 7.6 });
    });
    for (const sid of this.state?.structures ?? []) {
      if (sid === 'parking' || sid === 'terrace' || sid === 'billboard') continue;
      const at = PLOT_LOCAL.structures[sid];
      const size = sid === 'fountain' ? 4.8 : 6;
      out.push({ lx: at.lx, lz: at.lz, w: size, d: size });
    }
    return out;
  }

  dispose() {
    this.customers.clear();
    for (const st of this.staff) { this.crowd.release(st.slot); if (st.props) this.root.remove(st.props); }
    this.staff = [];
  }
}
