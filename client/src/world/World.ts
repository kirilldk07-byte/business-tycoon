import * as THREE from 'three';
import { PLOTS, POWER_SWITCHES } from '../../../shared/constants/world';

// Stylized low-poly city. Purely visual — nothing here affects gameplay.

const matCache = new Map<number, THREE.MeshStandardMaterial>();
export function mat(color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  if (Object.keys(opts).length) return new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...opts });
  let m = matCache.get(color);
  if (!m) { m = new THREE.MeshStandardMaterial({ color, roughness: 0.8, flatShading: true }); matCache.set(color, m); }
  return m;
}

export function box(w: number, h: number, d: number, color: number | THREE.Material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), typeof color === 'number' ? mat(color) : color);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function cyl(rt: number, rb: number, h: number, color: number, seg = 8, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat(color));
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Windowed facade texture, cached per color. */
const facadeCache = new Map<string, THREE.Texture>();
export function facadeTexture(base: string, win = '#bfe3ff', cols = 4, rows = 6): THREE.Texture {
  const key = `${base}|${win}|${cols}|${rows}`;
  const hit = facadeCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = base; g.fillRect(0, 0, 128, 256);
  const cw = 128 / cols, rh = 256 / rows;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    g.fillStyle = Math.random() < 0.25 ? '#ffe9a8' : win;
    g.fillRect(x * cw + cw * 0.18, y * rh + rh * 0.2, cw * 0.64, rh * 0.55);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  facadeCache.set(key, t);
  return t;
}

interface Car { mesh: THREE.Group; lane: number; speed: number; dir: 1 | -1 }
interface Walker { mesh: THREE.Group; path: THREE.Vector3[]; i: number; speed: number; phase: number }

export class World {
  readonly root = new THREE.Group();
  private cars: Car[] = [];
  private walkers: Walker[] = [];
  private fountainWater?: THREE.Mesh;
  switchMeshes: THREE.Group[] = [];
  readonly sun: THREE.DirectionalLight;

  constructor(scene: THREE.Scene, lowQuality: boolean) {
    scene.add(this.root);
    scene.background = new THREE.Color(0x9ad8ff);
    scene.fog = new THREE.Fog(0x9ad8ff, 70, 150);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x88aa66, 1.1);
    this.root.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff2d6, 1.8);
    this.sun.position.set(30, 50, 20);
    this.sun.castShadow = !lowQuality;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 50; sc.bottom = -50; sc.near = 1; sc.far = 140;
    this.sun.shadow.bias = -0.0005;
    this.root.add(this.sun);

    this.buildGround();
    this.buildRoads();
    this.buildPlaza();
    this.buildPlotsGround();
    this.buildCityBlocks();
    this.buildTrees();
    this.buildLamps();
    this.buildParkingLots();
    this.buildSwitches();
    this.spawnCars(lowQuality ? 4 : 8);
    this.spawnWalkers(lowQuality ? 4 : 10);
  }

  private buildGround() {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(260, 200), mat(0x7cc96a));
    g.rotation.x = -Math.PI / 2;
    g.receiveShadow = true;
    this.root.add(g);
  }

  private buildRoads() {
    const asphalt = mat(0x4b5563);
    const stripe = mat(0xfef3c7);
    const side = mat(0xd6d3d1);
    for (const z of [-26, 26]) {
      const r = new THREE.Mesh(new THREE.PlaneGeometry(200, 8), asphalt);
      r.rotation.x = -Math.PI / 2; r.position.set(0, 0.02, z); r.receiveShadow = true;
      this.root.add(r);
      for (let x = -96; x < 100; x += 6) {
        const s = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.25), stripe);
        s.rotation.x = -Math.PI / 2; s.position.set(x, 0.03, z);
        this.root.add(s);
      }
      for (const dz of [-4.8, 4.8]) this.root.add(box(200, 0.15, 1.6, side.color.getHex(), 0, 0, z + dz));
    }
    // Vertical connector roads at the map edges
    for (const x of [-56, 56]) {
      const r = new THREE.Mesh(new THREE.PlaneGeometry(8, 44), asphalt);
      r.rotation.x = -Math.PI / 2; r.position.set(x, 0.021, 0); r.receiveShadow = true;
      this.root.add(r);
    }
  }

  private buildPlaza() {
    const plaza = new THREE.Mesh(new THREE.CircleGeometry(13, 32), mat(0xe7e0d3));
    plaza.rotation.x = -Math.PI / 2; plaza.position.y = 0.025; plaza.receiveShadow = true;
    this.root.add(plaza);
    const ring = new THREE.Mesh(new THREE.RingGeometry(12.6, 13.2, 40), mat(0xc4b8a3));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03;
    this.root.add(ring);
    // Paths from plaza to plots
    for (const p of PLOTS) {
      const path = new THREE.Mesh(new THREE.PlaneGeometry(Math.abs(p.x) - 13 - 16 + 2, 5), mat(0xe7e0d3));
      path.rotation.x = -Math.PI / 2;
      path.position.set(Math.sign(p.x) * (13 + (Math.abs(p.x) - 16 - 13) / 2), 0.024, 0);
      this.root.add(path);
    }
    // Fountain
    this.root.add(cyl(4, 4.4, 0.8, 0xb8c1cc, 20));
    const water = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.6, 0.1, 20), new THREE.MeshStandardMaterial({ color: 0x4fc3f7, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.85 }));
    water.position.y = 0.75;
    this.fountainWater = water;
    this.root.add(water);
    this.root.add(cyl(0.5, 0.7, 2.6, 0xb8c1cc, 10));
    this.root.add(cyl(1.6, 1.2, 0.3, 0xb8c1cc, 14, 0, 2.6));
    // Benches
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.5;
      const b = new THREE.Group();
      b.add(box(2.2, 0.15, 0.6, 0x9a6b3f, 0, 0.45));
      b.add(box(2.2, 0.6, 0.12, 0x9a6b3f, 0, 0.55, -0.3));
      b.add(box(0.15, 0.45, 0.5, 0x374151, -0.9));
      b.add(box(0.15, 0.45, 0.5, 0x374151, 0.9));
      b.position.set(Math.cos(a) * 9.5, 0, Math.sin(a) * 9.5);
      b.rotation.y = -a - Math.PI / 2;
      this.root.add(b);
    }
  }

  private buildPlotsGround() {
    for (const p of PLOTS) {
      const tile = new THREE.Mesh(new THREE.PlaneGeometry(34, 34), mat(0xd9e7c3));
      tile.rotation.x = -Math.PI / 2; tile.position.set(p.x, 0.022, p.z); tile.receiveShadow = true;
      this.root.add(tile);
      // Low fence on 3 sides (front open toward plaza)
      const fence = 0xf5f5f4;
      const back = p.x - p.dir * 17;
      this.root.add(box(0.3, 0.8, 34, fence, back, 0, p.z));
      for (const s of [-17, 17]) {
        const segLen = 14;
        this.root.add(box(segLen, 0.8, 0.3, fence, back + p.dir * segLen / 2, 0, p.z + s));
      }
    }
  }

  private buildCityBlocks() {
    const palette = ['#f2b880', '#c9d6df', '#f7d6e0', '#b8e0d2', '#eac4d5', '#d6eadf', '#ffd6a5', '#cdb4db'];
    const rnd = mulberry(7);
    const place = (x: number, z: number, w: number, d: number, h: number) => {
      const col = palette[Math.floor(rnd() * palette.length)];
      const tex = facadeTexture(col, '#9fd3ff', 3 + Math.floor(rnd() * 3), Math.max(2, Math.round(h / 3))).clone();
      tex.needsUpdate = true;
      tex.repeat.set(Math.max(1, Math.round(w / 6)), 1);
      const side = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 });
      const top = mat(0x9ca3af);
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [side, side, top, top, side, side]);
      m.position.set(x, h / 2, z);
      m.castShadow = true; m.receiveShadow = true;
      this.root.add(m);
      if (rnd() < 0.5) this.root.add(box(w * 0.4, 1.2, d * 0.4, 0x6b7280, x, h, z));
    };
    for (const z of [-38, 38]) {
      for (let x = -90; x <= 90; x += 12) {
        if (rnd() < 0.15) continue;
        place(x + rnd() * 2, z + Math.sign(z) * rnd() * 3, 8 + rnd() * 3, 8 + rnd() * 3, 6 + rnd() * 22);
      }
    }
    for (const x of [-72, 72]) {
      for (let z = -18; z <= 18; z += 12) place(x, z, 10, 9, 8 + rnd() * 16);
    }
  }

  private buildTrees() {
    const rnd = mulberry(11);
    const spots: [number, number][] = [];
    for (let i = 0; i < 70; i++) {
      const x = -95 + rnd() * 190, z = -60 + rnd() * 120;
      if (Math.abs(z) < 31 && Math.abs(x) < 50) continue; // keep play area clear
      if (Math.abs(Math.abs(z) - 26) < 6) continue; // roads
      if (Math.abs(Math.abs(x) - 56) < 5 && Math.abs(z) < 24) continue;
      spots.push([x, z]);
    }
    // Plaza ring trees
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; spots.push([Math.cos(a) * 15.5, Math.sin(a) * 15.5 + (Math.abs(Math.sin(a)) > 0.9 ? 0 : 0)]); }
    for (const [x, z] of spots) {
      if (Math.abs(x) < 17 && Math.abs(z) < 4) continue;
      this.root.add(tree(x, z, rnd));
    }
  }

  private buildLamps() {
    for (const z of [-21, 21]) {
      for (let x = -48; x <= 48; x += 12) this.root.add(lamp(x, z));
    }
  }

  private buildParkingLots() {
    for (const sx of [-1, 1]) {
      const x = sx * 44, z = 0;
      const lot = new THREE.Mesh(new THREE.PlaneGeometry(10, 30), mat(0x6b7280));
      lot.rotation.x = -Math.PI / 2; lot.position.set(x, 0.023, z);
      this.root.add(lot);
      for (let i = -3; i <= 3; i++) {
        const l = new THREE.Mesh(new THREE.PlaneGeometry(4, 0.15), mat(0xffffff));
        l.rotation.x = -Math.PI / 2; l.position.set(x - 2.5, 0.03, z + i * 4);
        this.root.add(l);
        if ((i + sx) % 2 === 0) { const c = carMesh(carColor(i * 3 + sx)); c.position.set(x - 2.5, 0, z + i * 4 + 2); c.rotation.y = Math.PI / 2; this.root.add(c); }
      }
    }
  }

  private buildSwitches() {
    for (const s of POWER_SWITCHES) {
      const g = new THREE.Group();
      g.add(box(1.2, 1.8, 0.6, 0x475569));
      g.add(box(1.25, 0.2, 0.65, 0xfacc15, 0, 1.8));
      const lever = box(0.18, 0.7, 0.18, 0xef4444, 0, 0.9, 0.4);
      lever.name = 'lever';
      g.add(lever);
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshStandardMaterial({ color: 0x64748b, emissive: 0x000000 }));
      light.position.set(0, 2.25, 0);
      light.name = 'light';
      g.add(light);
      g.position.set(s.x, 0, s.z);
      g.rotation.y = Math.atan2(-s.x, -s.z);
      this.switchMeshes[s.id] = g;
      this.root.add(g);
    }
  }

  setSwitchState(id: number, state: 'idle' | 'alarm' | 'on') {
    const g = this.switchMeshes[id];
    if (!g) return;
    const light = g.getObjectByName('light') as THREE.Mesh;
    const m = light.material as THREE.MeshStandardMaterial;
    const col = state === 'on' ? 0x22c55e : state === 'alarm' ? 0xef4444 : 0x64748b;
    m.color.setHex(col);
    m.emissive.setHex(state === 'idle' ? 0 : col);
    (g.getObjectByName('lever') as THREE.Mesh).rotation.x = state === 'on' ? -0.8 : 0.3;
  }

  private spawnCars(n: number) {
    for (let i = 0; i < n; i++) {
      const dir: 1 | -1 = i % 2 === 0 ? 1 : -1;
      const z = (i % 4 < 2 ? -26 : 26) + (dir === 1 ? 2 : -2);
      const mesh = carMesh(carColor(i));
      mesh.position.set(-90 + ((i * 47) % 180), 0, z);
      mesh.rotation.y = dir === 1 ? Math.PI / 2 : -Math.PI / 2;
      this.root.add(mesh);
      this.cars.push({ mesh, lane: z, speed: 8 + (i % 3) * 3, dir });
    }
  }

  private spawnWalkers(n: number) {
    const rnd = mulberry(5);
    for (let i = 0; i < n; i++) {
      const zLine = rnd() < 0.5 ? -21.5 : 21.5;
      const path = [new THREE.Vector3(-60, 0, zLine), new THREE.Vector3(60, 0, zLine)];
      if (rnd() < 0.5) path.reverse();
      const mesh = pedestrianMesh(Math.floor(rnd() * 0xffffff));
      mesh.position.copy(path[0]).lerp(path[1], rnd());
      this.root.add(mesh);
      this.walkers.push({ mesh, path, i: 1, speed: 1.4 + rnd() * 0.8, phase: rnd() * 6 });
    }
  }

  update(dt: number, t: number) {
    for (const c of this.cars) {
      c.mesh.position.x += c.dir * c.speed * dt;
      if (c.mesh.position.x > 100) c.mesh.position.x = -100;
      if (c.mesh.position.x < -100) c.mesh.position.x = 100;
    }
    for (const w of this.walkers) {
      const target = w.path[w.i];
      const d = target.clone().sub(w.mesh.position);
      if (d.length() < 0.5) { w.i = (w.i + 1) % w.path.length; continue; }
      d.normalize();
      w.mesh.position.addScaledVector(d, w.speed * dt);
      w.mesh.rotation.y = Math.atan2(d.x, d.z);
      w.phase += dt * 8;
      const legs = w.mesh.userData.legs as THREE.Object3D[];
      legs[0].rotation.x = Math.sin(w.phase) * 0.6;
      legs[1].rotation.x = -Math.sin(w.phase) * 0.6;
    }
    if (this.fountainWater) this.fountainWater.position.y = 0.75 + Math.sin(t * 2) * 0.03;
  }
}

export function mulberry(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tree(x: number, z: number, rnd: () => number) {
  const g = new THREE.Group();
  const h = 1.2 + rnd() * 1.2;
  g.add(cyl(0.2, 0.3, h, 0x8b5a2b, 6));
  const greens = [0x4caf50, 0x43a047, 0x66bb6a, 0x2e7d32];
  if (rnd() < 0.5) {
    const c = new THREE.Mesh(new THREE.ConeGeometry(1.4 + rnd() * 0.6, 3 + rnd() * 1.5, 7), mat(greens[Math.floor(rnd() * 4)]));
    c.position.y = h + 1.4; c.castShadow = true;
    g.add(c);
  } else {
    const s = new THREE.Mesh(new THREE.IcosahedronGeometry(1.4 + rnd() * 0.6, 0), mat(greens[Math.floor(rnd() * 4)]));
    s.position.y = h + 1.1; s.castShadow = true;
    g.add(s);
  }
  g.position.set(x, 0, z);
  return g;
}

function lamp(x: number, z: number) {
  const g = new THREE.Group();
  g.add(cyl(0.1, 0.14, 4, 0x374151, 6));
  g.add(box(1.2, 0.12, 0.12, 0x374151, 0.5, 4));
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 6), new THREE.MeshStandardMaterial({ color: 0xfff7cc, emissive: 0xffe08a, emissiveIntensity: 0.8 }));
  bulb.position.set(1, 3.85, 0);
  g.add(bulb);
  g.position.set(x, 0, z);
  return g;
}

const CAR_COLORS = [0xef4444, 0x3b82f6, 0xfacc15, 0x10b981, 0xf97316, 0x8b5cf6, 0xffffff, 0x0ea5e9];
const carColor = (i: number) => CAR_COLORS[Math.abs(i) % CAR_COLORS.length];

export function carMesh(color: number) {
  const g = new THREE.Group();
  g.add(box(1.8, 0.7, 3.8, color, 0, 0.35));
  g.add(box(1.6, 0.6, 2, color, 0, 1.05, -0.2));
  g.add(box(1.62, 0.45, 1.9, 0x1e3a5f, 0, 1.1, -0.2));
  for (const [x, zz] of [[-0.9, 1.2], [0.9, 1.2], [-0.9, -1.2], [0.9, -1.2]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.3, 10), mat(0x111827));
    w.rotation.z = Math.PI / 2; w.position.set(x, 0.38, zz);
    g.add(w);
  }
  return g;
}

export function pedestrianMesh(shirt: number) {
  const g = new THREE.Group();
  const legs: THREE.Object3D[] = [];
  for (const x of [-0.15, 0.15]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.75, 0);
    const leg = box(0.2, 0.75, 0.22, 0x374151, 0, -0.75);
    pivot.add(leg);
    g.add(pivot);
    legs.push(pivot);
  }
  g.add(box(0.6, 0.75, 0.35, shirt, 0, 0.75));
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), mat(0xf1c27d));
  head.position.y = 1.78; head.castShadow = true;
  g.add(head);
  g.userData.legs = legs;
  return g;
}
