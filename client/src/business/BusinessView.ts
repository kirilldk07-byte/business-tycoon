import * as THREE from 'three';
import { TIERS, WORKER_IDS, type StructureId, type WorkerId } from '../../../shared/constants/config';
import { PLOT_LOCAL, PLOTS } from '../../../shared/constants/world';
import { formatMoney } from '../../../shared/game/economy';
import type { BusinessState } from '../../../shared/types/state';
import type { Effects } from '../game/Effects';
import { CustomerManager } from '../npc/CustomerManager';
import { LabelSprite } from '../player/Character';
import { box } from '../world/World';
import {
  TIER_SIZE, createCounter, signMesh, createMachine, createStaff, createStructure, createTierBuilding,
} from './BuildingFactory';

interface BuildAnim {
  target: THREE.Object3D;
  scaffold: THREE.Object3D;
  t: number;
  dur: number;
  height: number;
  label: string;
  dustTimer: number;
}

const STAFF_SPOTS: Record<WorkerId, { lx: number; lz: number }[]> = {
  cashier: [{ lx: 2.8, lz: 0.8 }, { lx: 2.8, lz: -0.8 }, { lx: 2.8, lz: 2 }],
  worker: [{ lx: -3, lz: -11 }, { lx: 1.2, lz: -12.5 }, { lx: -2.5, lz: -9 }],
  manager: [{ lx: 1.5, lz: 4.5 }, { lx: 0, lz: 5.5 }, { lx: 1.5, lz: -4.5 }],
  delivery: [{ lx: 14, lz: -3 }, { lx: 14, lz: 3 }, { lx: 15, lz: 0 }],
  marketer: [{ lx: 15.5, lz: 7 }, { lx: 15.5, lz: -7 }, { lx: 15.5, lz: 10 }],
};

/** Everything that renders one business plot. Driven by authoritative BusinessState. */
export class BusinessView {
  readonly root = new THREE.Group();
  readonly customers: CustomerManager;
  private buildingSlot = new THREE.Group();
  private building: THREE.Object3D | null = null;
  private tier = 0;
  private structures = new Map<StructureId, THREE.Object3D>();
  private staff = new Map<string, THREE.Object3D>();
  private anims: BuildAnim[] = [];
  private machine: THREE.Group;
  private stockBar: THREE.Mesh;
  private counterTag = new LabelSprite(400, 80, 4);
  private machineTag = new LabelSprite(400, 80, 4);
  state: BusinessState | null = null;
  onBuilt: (label: string, at: THREE.Vector3) => void = () => {};

  constructor(public plot: number, public accent: number, private effects: Effects) {
    const p = PLOTS[plot];
    this.root.position.set(p.x, 0, p.z);
    this.root.rotation.y = p.dir > 0 ? 0 : Math.PI;
    this.buildingSlot.position.set(PLOT_LOCAL.building.lx, 0, PLOT_LOCAL.building.lz);
    this.root.add(this.buildingSlot);

    const counter = createCounter(accent);
    counter.position.set(PLOT_LOCAL.counter.lx, 0, PLOT_LOCAL.counter.lz);
    this.root.add(counter);
    this.counterTag.sprite.position.set(PLOT_LOCAL.counter.lx, 2.6, 0);
    this.root.add(this.counterTag.sprite);

    this.machine = createMachine(accent);
    this.machine.position.set(PLOT_LOCAL.machine.lx, 0, PLOT_LOCAL.machine.lz);
    this.root.add(this.machine);
    this.stockBar = box(0.3, 1, 0.3, 0x22c55e, 0, 0, 0);
    this.stockBar.position.set(PLOT_LOCAL.machine.lx + 1.25, 0.2, PLOT_LOCAL.machine.lz + 0.8);
    this.root.add(this.stockBar);
    this.machineTag.sprite.position.set(PLOT_LOCAL.machine.lx, 4, PLOT_LOCAL.machine.lz);
    this.root.add(this.machineTag.sprite);

    // Entry arch posts
    for (const z of [-3.2, 3.2]) this.root.add(box(0.4, 3.4, 0.4, accent, 16.5, 0, z));
    this.root.add(box(0.5, 0.5, 6.8, accent, 16.5, 3.4, 0));

    this.customers = new CustomerManager(this.root);
  }

  private ownerSign: THREE.Mesh | null = null;

  /** Flat sign on the entry arch, readable from the plaza. */
  setOwnerLabel(text: string, color: string) {
    if (this.ownerSign) this.root.remove(this.ownerSign);
    const s = signMesh(text, 6.6, 1.1, '#0f172a', color);
    s.position.set(16.78, 3.15, 0);
    s.rotation.y = Math.PI / 2;
    this.root.add(s);
    this.ownerSign = s;
  }

  toWorld(local: THREE.Vector3) { return this.root.localToWorld(local.clone()); }

  /** Apply authoritative state. animate=false for initial sync / reconnect. */
  apply(s: BusinessState, animate: boolean) {
    this.state = s;
    if (s.tier !== this.tier) this.setTier(s.tier, animate && this.tier > 0);
    for (const id of s.structures) {
      if (!this.structures.has(id)) this.addStructure(id, animate);
    }
    for (const [id, obj] of this.structures) {
      if (!s.structures.includes(id)) { this.root.remove(obj); this.structures.delete(id); }
    }
    for (const w of WORKER_IDS) {
      for (let i = 0; i < 3; i++) {
        const key = `${w}${i}`;
        const want = i < s.workers[w];
        const has = this.staff.get(key);
        if (want && !has) {
          const m = createStaff(w);
          const spot = STAFF_SPOTS[w][i];
          m.position.set(spot.lx, 0, spot.lz);
          m.rotation.y = w === 'cashier' ? Math.PI / 2 : -Math.PI / 2 + (i - 1) * 0.5;
          this.root.add(m);
          this.staff.set(key, m);
          if (animate) this.effects.burst(this.toWorld(m.position.clone().setY(1)), 'sparkle', 16);
        } else if (!want && has) {
          this.root.remove(has);
          this.staff.delete(key);
        }
      }
    }
    this.updateTags();
  }

  updateTick(stock: number, queue: number) {
    if (!this.state) return;
    this.state.stock = stock;
    this.state.queue = queue;
    this.updateTags();
  }

  private updateTags() {
    const s = this.state!;
    this.counterTag.draw([{ text: `👥 ${s.queue}  ·  E: обслужить`, color: '#fff', size: 30 }]);
    this.machineTag.draw([{ text: `📦 ${formatMoney(s.stock)}  ·  E: сделать`, color: s.stock < 1 ? '#fca5a5' : '#fff', size: 30 }]);
    const h = Math.max(0.05, Math.min(2.5, s.stock / 20));
    this.stockBar.scale.y = h;
    (this.stockBar.material as THREE.MeshStandardMaterial).color.setHex(s.stock < 1 ? 0xef4444 : 0x22c55e);
  }

  private setTier(tier: number, animate: boolean) {
    this.tier = tier;
    const next = createTierBuilding(tier, this.accent);
    next.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const old = this.building;
    this.building = next;
    if (!animate) {
      if (old) this.buildingSlot.remove(old);
      this.buildingSlot.add(next);
      return;
    }
    if (old) {
      // Old building sinks quickly.
      this.anims.push({ target: old, scaffold: new THREE.Group(), t: 0, dur: 0.45, height: -1, label: '', dustTimer: 0 });
    }
    this.startBuildAnim(next, this.buildingSlot, TIER_SIZE[tier - 1], TIERS[tier - 1].name);
  }

  private addStructure(id: StructureId, animate: boolean) {
    const g = createStructure(id, this.accent);
    const at = PLOT_LOCAL.structures[id];
    const holder = new THREE.Group();
    holder.position.set(at.lx, 0, at.lz);
    this.root.add(holder);
    this.structures.set(id, holder);
    if (!animate) { holder.add(g); return; }
    this.startBuildAnim(g, holder, 6, 'Постройка');
  }

  private startBuildAnim(obj: THREE.Object3D, parent: THREE.Object3D, size: number, label: string) {
    // Foundation + scaffold frame, then the building rises out of it.
    const scaffold = new THREE.Group();
    const slab = box(size + 1, 0.25, size + 1, 0x9ca3af);
    scaffold.add(slab);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      scaffold.add(box(0.2, 5, 0.2, 0xf59e0b, (x * (size + 1)) / 2, 0, (z * (size + 1)) / 2));
    }
    parent.add(scaffold);
    obj.scale.set(1, 0.001, 1);
    parent.add(obj);
    this.anims.push({ target: obj, scaffold, t: 0, dur: 1.9, height: 1, label, dustTimer: 0 });
  }

  update(dt: number, serverNow: number, time: number) {
    for (let i = this.anims.length - 1; i >= 0; i--) {
      const a = this.anims[i];
      a.t += dt;
      const k = Math.min(1, a.t / a.dur);
      if (a.height < 0) {
        a.target.scale.y = Math.max(0.001, 1 - k);
        if (k >= 1) { a.target.parent?.remove(a.target); this.anims.splice(i, 1); }
        continue;
      }
      // Hold briefly on the foundation, then rise with ease-out-back.
      const rise = Math.max(0, (k - 0.2) / 0.8);
      const e = rise < 1 ? 1 + 2.2 * Math.pow(rise - 1, 3) + 1.2 * Math.pow(rise - 1, 2) : 1;
      a.target.scale.y = Math.max(0.001, e);
      a.dustTimer -= dt;
      if (a.dustTimer <= 0 && k < 0.95) {
        a.dustTimer = 0.25;
        this.effects.burst(a.target.getWorldPosition(new THREE.Vector3()), 'dust', 6);
      }
      if (k >= 1) {
        a.target.scale.y = 1;
        a.scaffold.parent?.remove(a.scaffold);
        this.anims.splice(i, 1);
        const at = a.target.getWorldPosition(new THREE.Vector3()).setY(4);
        this.effects.burst(at, 'sparkle', 40);
        this.onBuilt(a.label, at);
      }
    }
    // Small idle animations.
    const gear = this.machine.getObjectByName('gear');
    if (gear) gear.rotation.z = time * 3;
    this.root.traverse((o) => { if (o.name === 'spin') o.rotation.y = time * 1.2; });
    this.customers.update(dt, serverNow);
  }

  clearDynamic() { this.customers.clear(); }
}
