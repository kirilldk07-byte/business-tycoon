import * as THREE from 'three';
import { PLOT_LOCAL } from '../../../shared/constants/world';
import { CUSTOMER_KIND } from '../../../shared/events';
import { customerPath, walkMs, type P2 } from '../../../shared/game/paths';
import { mulberry } from '../world/geo';
import { randomLook, type Crowd } from './Crowd';

// Visual NPC customers for one business, rendered through the shared instanced
// Crowd. Timing comes from the server clock (arrive time), so both devices show
// a customer reaching the door at the same moment.

interface Npc {
  id: number;
  slot: number; // crowd instance, -1 = simulated but not drawn (over budget)
  dest: number;
  kind: number;
  path: P2[];
  cum: number[];
  startAt: number;
  arrive: number;
  state: 'walk' | 'queue' | 'enter' | 'leave';
  x: number; z: number; rot: number;
  phase: number;
  t: number; // state timer
  exit: P2[];
  exitI: number;
}

export interface SpecialMarker { kind: number; x: number; z: number }

const QUEUE_START = PLOT_LOCAL.counter.lx + 1.8;

export class CustomerManager {
  private npcs = new Map<number, Npc>();
  private order: number[] = []; // flagship queue (walking + waiting) in arrival order
  private rnd = mulberry(3);
  private v = new THREE.Vector3();
  visibleCount = 0;

  constructor(private root: THREE.Object3D, private crowd: Crowd, private maxVisible: number) {}

  private cumulative(path: P2[]) {
    const c = [0];
    for (let i = 1; i < path.length; i++) c.push(c[i - 1] + Math.hypot(path[i].lx - path[i - 1].lx, path[i].lz - path[i - 1].lz));
    return c;
  }

  spawn(id: number, dest: number, kind: number, arrive: number, side: number) {
    if (this.npcs.has(id)) return;
    const path = customerPath(dest, side);
    const special = kind !== CUSTOMER_KIND.normal;
    let slot = -1;
    if (this.visibleCount < this.maxVisible || special) {
      const look = randomLook(this.rnd, kind === CUSTOMER_KIND.golden ? 0xfacc15 : kind === CUSTOMER_KIND.vip ? 0x312e81 : undefined);
      slot = this.crowd.alloc(look);
      if (slot >= 0) this.visibleCount++;
    }
    const n: Npc = {
      id, slot, dest, kind, path, cum: this.cumulative(path), startAt: arrive - walkMs(dest, side), arrive,
      state: 'walk', x: path[0].lx, z: path[0].lz, rot: 0, phase: this.rnd() * 6, t: 0, exit: [], exitI: 0,
    };
    this.npcs.set(id, n);
    if (dest < 0) this.order.push(id);
  }

  /** Returns local position of the payment (for effects). */
  paid(id: number): THREE.Vector3 {
    const n = this.npcs.get(id);
    if (!n) return this.fallbackPos();
    if (n.dest >= 0) {
      n.state = 'enter';
      n.t = 0;
      const door = n.path[n.path.length - 1];
      return new THREE.Vector3(door.lx, 0, door.lz);
    }
    this.startLeaving(n);
    return new THREE.Vector3(PLOT_LOCAL.counter.lx + 1.2, 0, PLOT_LOCAL.counter.lz);
  }

  left(id: number): THREE.Vector3 {
    const n = this.npcs.get(id);
    if (!n) return this.fallbackPos();
    this.startLeaving(n);
    return new THREE.Vector3(n.x, 0, n.z);
  }

  private fallbackPos() { return new THREE.Vector3(PLOT_LOCAL.counter.lx + 1.5, 0, 0); }

  private startLeaving(n: Npc) {
    this.order = this.order.filter((x) => x !== n.id);
    n.state = 'leave';
    const sg = n.z >= 0 ? 1 : -1;
    const s = PLOT_LOCAL.customerSpawn[sg > 0 ? 0 : 1];
    n.exit = [{ lx: n.x, lz: sg * 3.6 }, { lx: 23, lz: sg * 3.6 }, { lx: s.lx, lz: sg * 3.6 }, { lx: s.lx, lz: s.lz }];
    n.exitI = 0;
  }

  /** Golden / VIP customers currently visible (for auras), plot-local coords. */
  specials(out: SpecialMarker[]) {
    for (const n of this.npcs.values()) if (n.kind !== CUSTOMER_KIND.normal && n.state !== 'enter') out.push({ kind: n.kind, x: n.x, z: n.z });
  }

  get queueLength() { return this.order.length; }

  update(dt: number, serverNow: number) {
    // Flagship queue slots
    let qi = 0;
    for (const id of this.order) {
      const n = this.npcs.get(id)!;
      if (n.state === 'walk' && serverNow >= n.arrive) n.state = 'queue';
      if (n.state === 'queue') {
        const tx = QUEUE_START + (qi % 12) * 1.05;
        const row = Math.floor(qi / 12);
        const tz = row === 0 ? 0 : (row % 2 ? -1 : 1) * Math.ceil(row / 2) * 1.3;
        this.moveTo(n, tx, tz, 3.2, dt, Math.PI * -0.5);
      }
      qi++;
    }
    for (const n of [...this.npcs.values()]) {
      if (n.state === 'walk') {
        const total = n.cum[n.cum.length - 1];
        const k = Math.min(1, Math.max(0, (serverNow - n.startAt) / Math.max(1, n.arrive - n.startAt)));
        const d = k * total;
        let i = 1;
        while (i < n.cum.length - 1 && n.cum[i] < d) i++;
        const a = n.path[i - 1], b = n.path[i];
        const seg = n.cum[i] - n.cum[i - 1] || 1;
        const f = Math.min(1, Math.max(0, (d - n.cum[i - 1]) / seg));
        n.x = a.lx + (b.lx - a.lx) * f;
        n.z = a.lz + (b.lz - a.lz) * f;
        n.rot = Math.atan2(b.lx - a.lx, b.lz - a.lz);
        n.phase += dt * 8;
        if (n.dest >= 0 && k >= 1) { n.state = 'enter'; n.t = 0; }
        this.draw(n, 0.6);
      } else if (n.state === 'enter') {
        n.t += dt;
        const door = n.path[n.path.length - 1];
        n.x += (door.lx - n.x) * Math.min(1, dt * 6);
        n.z += (door.lz - n.z) * Math.min(1, dt * 6);
        const scale = Math.max(0.01, 1 - n.t / 0.45);
        this.draw(n, 0.6, scale);
        if (n.t > 0.45) this.remove(n);
      } else if (n.state === 'leave') {
        const target = n.exit[n.exitI];
        const arrived = this.moveTo(n, target.lx, target.lz, 3.4, dt);
        if (arrived) {
          n.exitI++;
          if (n.exitI >= n.exit.length) this.remove(n);
        }
      }
    }
  }

  private moveTo(n: Npc, tx: number, tz: number, speed: number, dt: number, idleRot?: number): boolean {
    const dx = tx - n.x, dz = tz - n.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.08) {
      if (idleRot !== undefined) n.rot = idleRot;
      this.draw(n, 0);
      return true;
    }
    const step = Math.min(d, speed * dt);
    n.x += (dx / d) * step;
    n.z += (dz / d) * step;
    n.rot = Math.atan2(dx, dz);
    n.phase += dt * speed * 2.6;
    this.draw(n, 0.6);
    return false;
  }

  private draw(n: Npc, swing: number, scale = 1) {
    if (n.slot < 0) return;
    this.v.set(n.x, 0, n.z);
    this.root.localToWorld(this.v);
    const rot = n.rot + this.root.rotation.y;
    const s = n.kind === CUSTOMER_KIND.normal ? scale : scale * 1.12;
    this.crowd.pose(n.slot, this.v.x, 0, this.v.z, rot, n.phase, swing, s, 0, n.kind === CUSTOMER_KIND.golden ? Math.abs(Math.sin(n.phase)) * 0.04 : 0);
  }

  private remove(n: Npc) {
    if (n.slot >= 0) { this.crowd.release(n.slot); this.visibleCount--; }
    this.npcs.delete(n.id);
    this.order = this.order.filter((x) => x !== n.id);
  }

  clear() {
    for (const n of [...this.npcs.values()]) this.remove(n);
    this.order = [];
  }
}
