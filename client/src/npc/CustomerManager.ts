import * as THREE from 'three';
import { PLOT_LOCAL } from '../../../shared/constants/world';
import { hatMesh } from '../player/Character';
import { mulberry, pedestrianMesh } from '../world/World';

// Visual NPC customers. Timing comes from the server (arrive time in server
// clock), so both devices show customers reaching the counter together.

interface Npc {
  id: number;
  mesh: THREE.Group | null;
  state: 'walking' | 'queued' | 'leaving';
  arrive: number;
  golden: boolean;
  exit: THREE.Vector3;
  phase: number;
  fade: number;
}

const SHIRTS = [0x60a5fa, 0xf472b6, 0x34d399, 0xfbbf24, 0xa78bfa, 0xf87171, 0x2dd4bf, 0xfb923c];
const MAX_VISIBLE = 26;

export class CustomerManager {
  private npcs = new Map<number, Npc>();
  private order: number[] = []; // walking + queued, by arrival
  private rnd = mulberry(3);
  private tmp = new THREE.Vector3();

  constructor(private root: THREE.Group) {}

  private slotPos(i: number, out: THREE.Vector3) {
    const c = PLOT_LOCAL.counter;
    // Snake the line when it gets long.
    const row = Math.floor(i / 8), col = i % 8;
    const lz = row === 0 ? 0 : (row % 2 ? -1 : 1) * Math.ceil(row / 2) * 1.3;
    return out.set(c.lx + 1.6 + col * 1.05, 0, lz);
  }

  spawn(id: number, golden: boolean, arrive: number, side: number) {
    const visible = [...this.npcs.values()].filter((n) => n.mesh).length < MAX_VISIBLE || golden;
    let mesh: THREE.Group | null = null;
    if (visible) {
      mesh = pedestrianMesh(golden ? 0xfacc15 : SHIRTS[Math.floor(this.rnd() * SHIRTS.length)]);
      if (golden) {
        const crown = hatMesh('crown', 0xfacc15)!;
        crown.position.y = 2.05;
        crown.scale.setScalar(0.7);
        mesh.add(crown);
      }
      const s = PLOT_LOCAL.customerSpawn[side % PLOT_LOCAL.customerSpawn.length];
      mesh.position.set(s.lx, 0, s.lz + (this.rnd() - 0.5) * 3);
      this.root.add(mesh);
    }
    const exitSide = PLOT_LOCAL.customerSpawn[(side + 1) % PLOT_LOCAL.customerSpawn.length];
    this.npcs.set(id, { id, mesh, state: 'walking', arrive, golden, exit: new THREE.Vector3(exitSide.lx + 4, 0, exitSide.lz), phase: this.rnd() * 6, fade: 1 });
    this.order.push(id);
  }

  /** Returns the npc's local position (for effects), or the counter if unknown. */
  served(id: number): THREE.Vector3 {
    return this.release(id, false);
  }

  left(id: number): THREE.Vector3 {
    return this.release(id, true);
  }

  private release(id: number, angry: boolean): THREE.Vector3 {
    const c = PLOT_LOCAL.counter;
    const n = this.npcs.get(id);
    this.order = this.order.filter((x) => x !== id);
    if (!n) return new THREE.Vector3(c.lx + 1.5, 0, 0);
    n.state = 'leaving';
    if (angry && n.mesh) n.mesh.rotation.z = 0;
    return n.mesh ? n.mesh.position.clone() : new THREE.Vector3(c.lx + 1.5, 0, 0);
  }

  get goldenWaiting() { return [...this.npcs.values()].some((n) => n.golden && n.state !== 'leaving'); }

  update(dt: number, serverNow: number) {
    this.order.forEach((id, i) => {
      const n = this.npcs.get(id)!;
      if (n.state === 'walking' && serverNow >= n.arrive) n.state = 'queued';
      if (!n.mesh) return;
      const target = this.slotPos(i, this.tmp);
      const d = target.clone().sub(n.mesh.position);
      const dist = d.length();
      let speed = 3.2;
      if (n.state === 'walking') speed = Math.min(7, Math.max(1.5, dist / Math.max(0.15, (n.arrive - serverNow) / 1000)));
      this.moveNpc(n, d, dist, speed, dt);
    });
    for (const n of [...this.npcs.values()]) {
      if (n.state !== 'leaving') continue;
      if (!n.mesh) { this.npcs.delete(n.id); continue; }
      const d = n.exit.clone().sub(n.mesh.position);
      const dist = d.length();
      this.moveNpc(n, d, dist, 3.5, dt);
      if (dist < 1.2) {
        n.fade -= dt * 2;
        n.mesh.scale.setScalar(Math.max(0.01, n.fade));
        if (n.fade <= 0) {
          this.root.remove(n.mesh);
          this.npcs.delete(n.id);
        }
      }
    }
  }

  private moveNpc(n: Npc, d: THREE.Vector3, dist: number, speed: number, dt: number) {
    const m = n.mesh!;
    const legs = m.userData.legs as THREE.Object3D[];
    if (dist > 0.08) {
      d.normalize();
      m.position.addScaledVector(d, Math.min(dist, speed * dt));
      m.rotation.y = Math.atan2(d.x, d.z);
      n.phase += dt * speed * 3;
      legs[0].rotation.x = Math.sin(n.phase) * 0.7;
      legs[1].rotation.x = -Math.sin(n.phase) * 0.7;
    } else {
      legs[0].rotation.x = legs[1].rotation.x = 0;
      m.rotation.y = -Math.PI / 2; // face the counter
    }
  }

  clear() {
    for (const n of this.npcs.values()) if (n.mesh) this.root.remove(n.mesh);
    this.npcs.clear();
    this.order = [];
  }
}
