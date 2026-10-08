import * as THREE from 'three';

// All NPC humans (customers + pedestrians) rendered with 7 InstancedMeshes:
// adding people costs no extra draw calls. Each person = set of part matrices.

export interface Look { shirt: number; pants: number; skin: number; hair: number }

const SKINS = [0xf6d0b1, 0xe8b48f, 0xc98e66, 0x9a6845, 0xf1c27d];
const HAIRS = [0x2b1b12, 0x5a3a22, 0xd9a441, 0x1f1f1f, 0xa0522d, 0xe5e5e5];
const SHIRTS = [0x60a5fa, 0xf472b6, 0x34d399, 0xfbbf24, 0xa78bfa, 0xf87171, 0x2dd4bf, 0xfb923c, 0x94a3b8, 0x4ade80];
const PANTS = [0x334155, 0x1e3a8a, 0x3f3f46, 0x78350f, 0x0f766e];

export function randomLook(rnd: () => number = Math.random, shirt?: number): Look {
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  return { shirt: shirt ?? pick(SHIRTS), pants: pick(PANTS), skin: pick(SKINS), hair: pick(HAIRS) };
}

type Part = 'torso' | 'head' | 'hair' | 'legL' | 'legR' | 'armL' | 'armR';
const PARTS: Part[] = ['torso', 'head', 'hair', 'legL', 'legR', 'armL', 'armR'];

export class Crowd {
  private meshes: Record<Part, THREE.InstancedMesh>;
  private free: number[] = [];
  private m = new THREE.Matrix4();
  private base = new THREE.Matrix4();
  private local = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private dirty = false;
  private tmpColor = new THREE.Color();
  readonly capacity: number;

  constructor(scene: THREE.Scene, capacity: number, shadows: boolean) {
    this.capacity = capacity;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true });
    const geos: Record<Part, THREE.BufferGeometry> = {
      torso: new THREE.CylinderGeometry(0.24, 0.3, 0.72, 7),
      head: new THREE.IcosahedronGeometry(0.27, 1),
      hair: new THREE.SphereGeometry(0.29, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.55),
      legL: new THREE.BoxGeometry(0.19, 0.78, 0.22).translate(0, -0.39, 0),
      legR: new THREE.BoxGeometry(0.19, 0.78, 0.22).translate(0, -0.39, 0),
      armL: new THREE.BoxGeometry(0.14, 0.62, 0.16).translate(0, -0.31, 0),
      armR: new THREE.BoxGeometry(0.14, 0.62, 0.16).translate(0, -0.31, 0),
    };
    this.meshes = {} as Record<Part, THREE.InstancedMesh>;
    for (const p of PARTS) {
      const im = new THREE.InstancedMesh(geos[p], mat, capacity);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = shadows && (p === 'torso' || p === 'head');
      im.frustumCulled = false;
      for (let i = 0; i < capacity; i++) { im.setMatrixAt(i, this.zero); im.setColorAt(i, this.tmpColor.setHex(0xffffff)); }
      scene.add(im);
      this.meshes[p] = im;
    }
    for (let i = capacity - 1; i >= 0; i--) this.free.push(i);
  }

  get available() { return this.free.length; }

  alloc(look: Look): number {
    const i = this.free.pop();
    if (i === undefined) return -1;
    const set = (p: Part, c: number) => this.meshes[p].setColorAt(i, this.tmpColor.setHex(c));
    set('torso', look.shirt); set('armL', look.shirt); set('armR', look.shirt);
    set('legL', look.pants); set('legR', look.pants);
    set('head', look.skin); set('hair', look.hair);
    for (const p of PARTS) if (this.meshes[p].instanceColor) this.meshes[p].instanceColor!.needsUpdate = true;
    return i;
  }

  release(i: number) {
    if (i < 0) return;
    for (const p of PARTS) this.meshes[p].setMatrixAt(i, this.zero);
    this.free.push(i);
    this.dirty = true;
  }

  /**
   * Pose a person. phase drives the walk cycle; swing 0 = standing.
   * armsUp (0..1) raises both arms (cheering / carrying).
   */
  pose(i: number, x: number, y: number, z: number, rotY: number, phase: number, swing: number, scale = 1, armsUp = 0, bob = 0, armL?: number, armR?: number) {
    if (i < 0) return;
    this.q.setFromEuler(this.e.set(0, rotY, 0));
    this.base.compose(this.v.set(x, y + bob, z), this.q, this.s.set(scale, scale, scale));
    const leg = Math.sin(phase) * swing;
    const set = (p: Part, lx: number, ly: number, lz: number, rx = 0, rz = 0) => {
      this.q.setFromEuler(this.e.set(rx, 0, rz));
      this.local.compose(this.v.set(lx, ly, lz), this.q, this.s.set(1, 1, 1));
      this.m.multiplyMatrices(this.base, this.local);
      this.meshes[p].setMatrixAt(i, this.m);
    };
    set('torso', 0, 1.14, 0, swing * 0.08);
    set('head', 0, 1.74, 0);
    set('hair', 0, 1.8, -0.02);
    set('legL', -0.12, 0.8, 0, leg);
    set('legR', 0.12, 0.8, 0, -leg);
    set('armL', -0.33, 1.44, 0, armL ?? (armsUp ? -2.6 * armsUp : -leg * 0.9), 0.08);
    set('armR', 0.33, 1.44, 0, armR ?? (armsUp ? -2.6 * armsUp : leg * 0.9), -0.08);
    this.dirty = true;
  }

  commit() {
    if (!this.dirty) return;
    this.dirty = false;
    for (const p of PARTS) this.meshes[p].instanceMatrix.needsUpdate = true;
  }
}
