import * as THREE from 'three';
import { PLOTS, PLOT_HALF, POWER_SWITCHES, ROADS } from '../../../shared/constants/world';
import type { Quality } from '../config/quality';
import { Crowd, randomLook } from '../npc/Crowd';
import { GeoBuilder, PAL, makeSign, mulberry } from './geo';

// Stylized low-poly city. Purely visual — nothing here affects gameplay.
// Static scenery is baked into a handful of merged vertex-colored meshes.

export { mulberry };

/** Axis-aligned box used for camera collision (and optional player blocking). */
export interface AABB { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }

const A = ROADS.avenueX, CZ = ROADS.crossZ, RW = ROADS.width / 2, SW = ROADS.sidewalk;
const PARK_X = A - RW - SW; // park half-width
const PARK_Z = CZ - RW - SW;

interface Car { mesh: THREE.Object3D; axis: 'x' | 'z'; lane: number; dir: 1 | -1; speed: number; min: number; max: number }
interface Walker { id: number; a: THREE.Vector2; b: THREE.Vector2; t: number; speed: number; phase: number; wait: number; forward: boolean; len: number }

export class World {
  readonly root = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly crowd: Crowd;
  readonly colliders: AABB[] = [];
  switchMeshes: THREE.Group[] = [];
  private cars: Car[] = [];
  private walkers: Walker[] = [];
  private sky: THREE.Mesh;
  private clouds: THREE.Group;
  private water: THREE.Mesh | null = null;
  private jets: THREE.Mesh | null = null;

  constructor(scene: THREE.Scene, private q: Quality) {
    scene.add(this.root);
    const horizon = new THREE.Color(0xcfeeff);
    scene.background = horizon;
    scene.fog = new THREE.Fog(horizon, 90, 230);

    const hemi = new THREE.HemisphereLight(0xe8f4ff, 0x8fbf6a, 1.25);
    this.root.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.1);
    this.sun.position.set(40, 70, 25);
    this.sun.castShadow = q.shadows;
    this.sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
    const sc = this.sun.shadow.camera;
    sc.left = -85; sc.right = 85; sc.top = 60; sc.bottom = -60; sc.near = 10; sc.far = 180;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.root.add(this.sun);
    this.root.add(this.sun.target);

    this.sky = this.makeSky();
    this.root.add(this.sky);
    this.clouds = this.makeClouds(q.clouds);
    this.root.add(this.clouds);

    const ground = new GeoBuilder();
    this.buildGround(ground);
    this.buildRoads(ground);
    this.root.add(ground.build(false));

    const props = new GeoBuilder();
    this.buildPark(props);
    this.buildStreetProps(props);
    this.buildPlotEdges(props);
    this.root.add(props.build(q.shadows));

    const city = new GeoBuilder();
    this.buildCity(city);
    this.buildParkingLots(city);
    this.root.add(city.build(q.shadows));

    this.buildBillboards();
    this.buildFountainDynamic();
    this.buildSwitches();
    this.spawnCars(q.cars);
    this.crowd = new Crowd(scene, 220, q.shadows);
    this.spawnWalkers(q.pedestrians);
  }

  // ------------------------------------------------------------- sky

  private makeSky(): THREE.Mesh {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        zenith: { value: new THREE.Color(0x4aa8ff) },
        horizon: { value: new THREE.Color(0xcfeeff) },
        ground: { value: new THREE.Color(0xb9dcae) },
        sunDir: { value: new THREE.Vector3(40, 70, 25).normalize() },
      },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; }',
      fragmentShader: `uniform vec3 zenith; uniform vec3 horizon; uniform vec3 ground; uniform vec3 sunDir; varying vec3 vDir;
        void main(){ float h = vDir.y; vec3 c = h > 0.0 ? mix(horizon, zenith, pow(h, 0.55)) : mix(horizon, ground, min(1.0, -h * 6.0));
        float s = max(dot(normalize(vDir), sunDir), 0.0); c += vec3(1.0,0.9,0.7) * (pow(s, 64.0) * 0.9 + pow(s, 6.0) * 0.12);
        gl_FragColor = vec4(c, 1.0); }`,
    });
    const m = new THREE.Mesh(new THREE.SphereGeometry(320, 24, 12), mat);
    m.renderOrder = -10;
    m.frustumCulled = false;
    return m;
  }

  private makeClouds(n: number): THREE.Group {
    const b = new GeoBuilder();
    const rnd = mulberry(21);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd();
      const r = 120 + rnd() * 90;
      const cx = Math.cos(a) * r, cz = Math.sin(a) * r, cy = 60 + rnd() * 30;
      const k = 4 + Math.floor(rnd() * 4);
      for (let j = 0; j < k; j++) {
        b.blob(5 + rnd() * 6, j % 3 === 0 ? 0xf1f5f9 : 0xffffff, cx + (j - k / 2) * 6 + rnd() * 3, cy + rnd() * 3, cz + rnd() * 6, 0.6);
      }
    }
    const g = b.build(false);
    g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.material = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }); } });
    return g;
  }

  // ------------------------------------------------------------- ground & roads

  private buildGround(b: GeoBuilder) {
    b.flat(420, 320, PAL.grass, 0, 0, 0);
    // Darker grass patches for variety
    const rnd = mulberry(4);
    for (let i = 0; i < 40; i++) {
      const x = -120 + rnd() * 240, z = -90 + rnd() * 180;
      if (Math.abs(z) < 40 && Math.abs(x) < 78) continue;
      b.flat(8 + rnd() * 14, 6 + rnd() * 10, PAL.grassDark, x, 0.005, z, rnd() * 3);
    }
    // Plot paving: 2 m stone tiles with subtle per-tile tint, a warm brick
    // boulevard from the entrance to the HQ, and a striped loading zone.
    const trnd = mulberry(9);
    for (const p of PLOTS) {
      const hx = PLOT_HALF.x, hz = PLOT_HALF.z;
      b.flat(hx * 2 + 0.6, hz * 2 + 0.6, PAL.curb, p.x, 0.012, p.z);
      const tile = 2;
      const tint = new THREE.Color();
      for (let ix = -hx; ix < hx; ix += tile) {
        for (let iz = -hz; iz < hz; iz += tile) {
          const base = (Math.floor(ix / tile) + Math.floor(iz / tile)) % 2 === 0 ? PAL.paving : PAL.pavingDark;
          tint.setHex(base).offsetHSL(0, 0, (trnd() - 0.5) * 0.035);
          b.flat(tile - 0.07, tile - 0.07, tint.getHex(), p.x + ix + tile / 2, 0.02, p.z + iz + tile / 2);
        }
      }
      // Boulevard (plot-local lx from the HQ front to the entrance), herringbone-ish bricks
      const lx0 = -9, lx1 = hx;
      for (let lx = lx0; lx < lx1; lx += 1.5) {
        for (let lz = -2.25; lz < 2.25; lz += 1.5) {
          const c = (Math.floor(lx / 1.5) + Math.floor(lz / 1.5)) % 2 === 0 ? 0xd9a77c : 0xcf9b70;
          b.flat(1.42, 1.42, c, p.x + p.dir * (lx + 0.75), 0.026, p.z + lz + 0.75);
        }
      }
      for (const s of [-1, 1]) b.flat((lx1 - lx0), 0.3, 0xa16207, p.x + p.dir * (lx0 + lx1) / 2, 0.028, p.z + s * 2.4);
      // Loading zone (delivery van / crate drops), yellow-black hatch
      const zx = p.x + p.dir * 16, zz = p.z - p.dir * 7;
      b.flat(7.4, 5.6, 0x3f3f46, zx, 0.027, zz);
      for (let i = -3; i <= 3; i++) b.flat(0.45, 4.4, 0xfacc15, zx + i * 1.0, 0.029, zz, 0.5);
      b.flat(7.4, 0.25, 0xfacc15, zx, 0.03, zz - 2.8); b.flat(7.4, 0.25, 0xfacc15, zx, 0.03, zz + 2.8);
    }
  }

  private buildRoads(b: GeoBuilder) {
    const LONG = 300;
    // Avenues (N-S) and cross roads (E-W)
    for (const sx of [-1, 1]) {
      b.flat(ROADS.width, LONG, PAL.asphalt, sx * A, 0.03, 0);
      for (let z = -140; z < 140; z += 6) {
        if (Math.abs(Math.abs(z) - CZ) < RW + 1 || Math.abs(z) < 4) continue;
        b.flat(0.22, 2.6, PAL.stripe, sx * A, 0.04, z);
      }
      // Sidewalks both sides
      for (const side of [-1, 1]) {
        const x = sx * A + side * (RW + SW / 2);
        for (const [z0, z1] of [[-150, -CZ - RW], [-CZ + RW, CZ - RW], [CZ + RW, 150]]) {
          b.box(SW, 0.16, z1 - z0, PAL.sidewalk, x, 0, (z0 + z1) / 2);
          b.box(0.25, 0.2, z1 - z0, PAL.curb, x - side * (SW / 2 - 0.12), 0, (z0 + z1) / 2);
        }
      }
      // Crosswalk at z=0 linking plot entrances with the park
      this.crosswalk(b, sx * A, 0, 'x');
    }
    for (const sz of [-1, 1]) {
      b.flat(LONG + 120, ROADS.width, PAL.asphalt, 0, 0.031, sz * CZ);
      for (let x = -200; x < 200; x += 6) {
        if (Math.abs(Math.abs(x) - A) < RW + 1) continue;
        b.flat(2.6, 0.22, PAL.stripe, x, 0.041, sz * CZ);
      }
      for (const side of [-1, 1]) {
        const z = sz * CZ + side * (RW + SW / 2);
        for (const [x0, x1] of [[-210, -A - RW], [-A + RW, A - RW], [A + RW, 210]]) {
          b.box(x1 - x0, 0.16, SW, PAL.sidewalk, (x0 + x1) / 2, 0, z);
          b.box(x1 - x0, 0.2, 0.25, PAL.curb, (x0 + x1) / 2, 0, z - side * (SW / 2 - 0.12));
        }
      }
      // Intersections with zebra crossings on all four arms
      for (const sx of [-1, 1]) {
        const ix = sx * A, iz = sz * CZ;
        b.flat(ROADS.width, ROADS.width, PAL.asphaltDark, ix, 0.035, iz);
        this.crosswalk(b, ix, iz - (RW + 1.4), 'x');
        this.crosswalk(b, ix, iz + (RW + 1.4), 'x');
        this.crosswalk(b, ix - (RW + 1.4), iz, 'z');
        this.crosswalk(b, ix + (RW + 1.4), iz, 'z');
      }
    }
  }

  /** Zebra stripes across a road. axis = direction people walk ('x' crosses an N-S avenue). */
  private crosswalk(b: GeoBuilder, x: number, z: number, axis: 'x' | 'z') {
    for (let i = -3; i <= 3; i++) {
      if (axis === 'x') b.flat(ROADS.width - 0.6, 0.55, PAL.white, x, 0.045, z + i * 1.0);
      else b.flat(0.55, ROADS.width - 0.6, PAL.white, x + i * 1.0, 0.045, z);
    }
  }

  // ------------------------------------------------------------- park

  private buildPark(b: GeoBuilder) {
    // Grass with curb
    b.box(PARK_X * 2, 0.12, PARK_Z * 2, PAL.curb, 0, 0, 0);
    b.box(PARK_X * 2 - 0.5, 0.14, PARK_Z * 2 - 0.5, 0x9ad97a, 0, 0, 0);
    // Paths: E-W main path (plot to plot) + N-S path
    b.box(PARK_X * 2, 0.16, 4.2, PAL.paving, 0, 0, 0);
    b.box(3.2, 0.16, PARK_Z * 2, PAL.paving, 0, 0, 0);
    // Plaza with fountain
    b.cyl(7.2, 0.17, PAL.pavingDark, 0, 0, 0, 12);
    b.cyl(6.6, 0.18, PAL.paving, 0, 0, 0, 12);
    b.cyl(3.9, 0.8, 0xc3ccd6, 0, 0, 0, 12);
    b.cyl(3.4, 0.82, 0x8fb7cf, 0, 0, 0, 12);
    b.cyl(0.6, 2.2, 0xc3ccd6, 0, 0.8, 0, 8);
    b.cyl(1.7, 0.3, 0xc3ccd6, 0, 2.5, 0, 12);
    this.colliders.push({ minX: -4, maxX: 4, minY: 0, maxY: 3, minZ: -4, maxZ: 4 });
    // Benches around plaza
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      this.bench(b, Math.cos(a) * 5.6, Math.sin(a) * 5.6, -a + Math.PI / 2);
    }
    // Flower beds and trees in the four park quadrants
    const rnd = mulberry(9);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        for (let k = 0; k < 3; k++) {
          const z = sz * (11 + k * 5.2);
          const x = sx * (4.6 + rnd() * 2.8);
          if (Math.hypot(x, z - 20) < 3.5 || Math.hypot(x, z + 20) < 3.5) continue;
          this.tree(b, x, z, rnd);
        }
        // flower bed
        const fx = sx * 5.5, fz = sz * 6.8;
        b.box(3, 0.35, 1.6, 0x8d6e63, fx, 0, fz);
        for (let f = 0; f < 6; f++) b.ball(0.32, PAL.flower[(f + (sx > 0 ? 1 : 0)) % 4], fx - 1.1 + (f % 3) * 1.1, 0.5, fz - 0.35 + Math.floor(f / 3) * 0.7);
      }
    }
    // Bushes along park edge
    for (let z = -PARK_Z + 2; z < PARK_Z - 1; z += 3.2) {
      if (Math.abs(z) < 3.2) continue;
      for (const sx of [-1, 1]) b.blob(0.9, PAL.leaf[Math.abs(Math.round(z)) % 4], sx * (PARK_X - 0.9), 0.6, z, 0.8);
    }
    // Gazebo near the north generator path
    b.cyl(2.4, 0.3, PAL.pavingDark, 0, 0, -20, 8);
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; b.cyl(0.12, 2.6, 0xffffff, Math.cos(a) * 2, 0.3, -20 + Math.sin(a) * 2, 6); }
    b.taper(2.9, 0.2, 1.4, 0xe76f51, 0, 2.9, -20, 6);
    // Path to generator at (0, 20)
    b.cyl(2.2, 0.17, PAL.pavingDark, 0, 0, 20, 12);
  }

  private bench(b: GeoBuilder, x: number, z: number, ry: number) {
    const base = new THREE.Matrix4().makeRotationY(ry).setPosition(x, 0, z);
    const prev = b.base.clone();
    b.base.copy(base);
    b.box(2.2, 0.12, 0.6, 0xb7793f, 0, 0.45, 0);
    b.box(2.2, 0.5, 0.1, 0xb7793f, 0, 0.6, -0.28);
    b.box(0.12, 0.45, 0.55, PAL.metal, -0.9, 0, 0);
    b.box(0.12, 0.45, 0.55, PAL.metal, 0.9, 0, 0);
    b.base.copy(prev);
  }

  tree(b: GeoBuilder, x: number, z: number, rnd: () => number, scale = 1) {
    const h = (1.4 + rnd() * 1.2) * scale;
    b.cyl(0.22 * scale, h, PAL.trunk, x, 0, z, 6);
    const leaf = PAL.leaf[Math.floor(rnd() * PAL.leaf.length)];
    const kind = rnd();
    if (kind < 0.35) {
      b.cone(1.6 * scale, 3.4 * scale, leaf, x, h - 0.3, z, 7);
      b.cone(1.2 * scale, 2.4 * scale, leaf, x, h + 1.3 * scale, z, 7);
    } else if (kind < 0.75) {
      b.blob(1.5 * scale, leaf, x, h + 1.0 * scale, z, 1);
      b.blob(1.0 * scale, PAL.leaf[(PAL.leaf.indexOf(leaf) + 1) % 4], x + 0.6 * scale, h + 1.7 * scale, z + 0.3, 1);
    } else {
      b.ball(1.5 * scale, leaf, x, h + 1.1 * scale, z);
    }
  }

  private lamp(b: GeoBuilder, x: number, z: number, armDir: number) {
    b.cyl(0.11, 4.6, 0x334155, x, 0, z, 6);
    b.box(0.1, 0.1, 1.2, 0x334155, x, 4.5, z + armDir * 0.55);
    b.box(0.5, 0.18, 0.5, 0x334155, x, 4.38, z + armDir * 1.1);
    b.boxC(0.36, 0.12, 0.36, 0xfff1b8, x, 4.3, z + armDir * 1.1);
  }

  private buildStreetProps(b: GeoBuilder) {
    const rnd = mulberry(17);
    // Avenue: street trees + lamps on both sidewalks
    for (const sx of [-1, 1]) {
      for (const side of [-1, 1]) {
        const x = sx * A + side * (RW + SW / 2);
        for (let z = -CZ + RW + 3; z < CZ - RW - 2; z += 7) {
          if (Math.abs(z) < 5) continue; // keep crosswalk clear
          if (Math.round(z / 7) % 2 === 0) this.lamp(b, x + side * 0.6, z, -side);
          else if (side === -sx) this.tree(b, x + side * 0.5, z, rnd, 0.8);
        }
      }
    }
    // Cross roads: lamps, trees, benches, bus stops, bins
    for (const sz of [-1, 1]) {
      for (const side of [-1, 1]) {
        const z = sz * CZ + side * (RW + SW / 2);
        for (let x = -74; x <= 74; x += 9) {
          if (Math.abs(Math.abs(x) - A) < RW + 3) continue;
          if (Math.round(x / 9) % 2 === 0) this.lamp(b, x, z + side * 0.6, 0);
          else this.tree(b, x, z + side * 0.4, rnd, 0.75);
        }
      }
      // Bus stop
      const bz = sz * (CZ + RW + SW / 2 + 0.2);
      b.box(4, 0.1, 1.6, 0x334155, -32, 2.6, bz);
      b.glassBox(0.08, 2.4, 1.4, 0xbfe6ff, -33.9, 0.2, bz);
      b.glassBox(0.08, 2.4, 1.4, 0xbfe6ff, -30.1, 0.2, bz);
      b.box(3.6, 0.12, 0.5, 0xb7793f, -32, 0.5, bz + sz * 0.3);
      b.box(0.2, 3.2, 0.2, 0xef4444, -29.5, 0, bz);
      b.box(0.9, 0.9, 0.1, 0xef4444, -29.5, 2.6, bz);
    }
    // Fire hydrants & bins near the crosswalks
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const x = sx * (A + RW + SW / 2), z = sz * 6.5;
        b.cyl(0.22, 0.7, 0xef4444, x, 0.16, z, 8);
        b.ball(0.2, 0xef4444, x, 0.88, z);
        b.cyl(0.32, 0.9, 0x16a34a, sx * (A - RW - SW / 2), 0.16, sz * 6.5, 8);
      }
    }
  }

  private buildPlotEdges(b: GeoBuilder) {
    for (const p of PLOTS) {
      const hx = PLOT_HALF.x, hz = PLOT_HALF.z;
      const back = p.x - p.dir * (hx + 0.4);
      // Hedge on the back and sides; front is open to the avenue except the corners.
      b.box(1, 1, hz * 2 + 1.6, 0x4f9d4a, back, 0, p.z);
      for (const s of [-1, 1]) {
        b.box(hx * 2 - 6, 1, 1, 0x4f9d4a, p.x - p.dir * 3, 0, p.z + s * (hz + 0.4));
        // corner planters at the front
        b.box(3, 0.6, 1.4, 0xc08457, p.x + p.dir * (hx - 1.5), 0, p.z + s * (hz - 0.6));
        b.blob(0.8, PAL.leaf[0], p.x + p.dir * (hx - 2.2), 0.95, p.z + s * (hz - 0.6), 0.8);
        b.blob(0.7, PAL.flower[0], p.x + p.dir * (hx - 0.9), 0.9, p.z + s * (hz - 0.6), 0.8);
      }
      // Trees behind the plot
      const rnd = mulberry(p.dir > 0 ? 31 : 37);
      for (let z = -hz; z <= hz; z += 6) this.tree(b, back - p.dir * 3, z + rnd() * 2, rnd, 1.1);
    }
  }

  // ------------------------------------------------------------- city blocks

  private buildCity(b: GeoBuilder) {
    const rnd = mulberry(7);
    const walls = [0xf4c095, 0xd6e4f0, 0xf7d6e0, 0xbfe3d0, 0xe9d5ff, 0xfde68a, 0xfecaca, 0xc7d2fe, 0xe7e5e4];
    const rowZ = CZ + RW + SW + 3; // first building line beyond the cross-road sidewalk
    for (const sz of [-1, 1]) {
      let x = -126;
      while (x < 126) {
        const w = 9 + Math.floor(rnd() * 6);
        const d = 9 + rnd() * 5;
        const kind = rnd();
        const cx = x + w / 2, cz = sz * (rowZ + d / 2 + rnd() * 1.5);
        const wall = walls[Math.floor(rnd() * walls.length)];
        if (kind < 0.45) this.apartment(b, cx, cz, w - 1.2, d, 3 + Math.floor(rnd() * 5), wall, sz, rnd);
        else if (kind < 0.8) this.shopBuilding(b, cx, cz, w - 1.2, d, 2 + Math.floor(rnd() * 2), wall, sz, rnd);
        else this.tower(b, cx, cz, Math.min(w - 1.2, 10), d, 8 + Math.floor(rnd() * 8), sz, rnd);
        x += w;
      }
    }
    // Distant metropolis: cheap silhouettes far outside the playable area, tinted by fog.
    const far = [0x94a3b8, 0xa5b4c8, 0x8ea3bd, 0xb6c2d4, 0x7f93ad];
    for (let i = 0; i < 90; i++) {
      const a = (i / 90) * Math.PI * 2 + rnd() * 0.05;
      const r = 135 + rnd() * 50;
      const w = 10 + rnd() * 14, h = 18 + Math.pow(rnd(), 1.6) * 70;
      const cx = Math.cos(a) * r * 1.1, cz = Math.sin(a) * r;
      b.box(w, h, w * (0.7 + rnd() * 0.6), far[i % far.length], cx, 0, cz);
      if (h > 55) b.box(w * 0.5, h * 0.12, w * 0.5, far[(i + 2) % far.length], cx, h, cz);
    }
    // Far east/west skyline behind the plots
    for (const sx of [-1, 1]) {
      for (let z = -36; z <= 36; z += 12) {
        const h = 6 + Math.floor(rnd() * 10);
        this.tower(b, sx * (92 + rnd() * 6), z, 9, 10, h, 0, rnd);
      }
    }
  }

  /** Window grid on the face pointing toward the play area (facing = -sign(z)). */
  private windows(b: GeoBuilder, cx: number, cz: number, w: number, d: number, floors: number, y0: number, sz: number, lit: () => number) {
    const face = sz === 0 ? 0 : cz - sz * (d / 2) - sz * 0.04;
    const cols = Math.max(2, Math.floor(w / 2.4));
    for (let f = 0; f < floors; f++) {
      for (let c = 0; c < cols; c++) {
        const x = cx - w / 2 + (c + 0.5) * (w / cols);
        const col = lit() < 0.2 ? 0xffe9a8 : 0x9fd3ff;
        if (sz !== 0) b.box(w / cols * 0.55, 1.4, 0.12, col, x, y0 + f * 3 + 0.9, face);
      }
    }
  }

  private apartment(b: GeoBuilder, cx: number, cz: number, w: number, d: number, floors: number, wall: number, sz: number, rnd: () => number) {
    const h = floors * 3 + 0.6;
    b.box(w, h, d, wall, cx, 0, cz);
    b.box(w + 0.4, 0.4, d + 0.4, 0x9ca3af, cx, h, cz);
    this.windows(b, cx, cz, w, d, floors, 0, sz, rnd);
    this.colliders.push({ minX: cx - w / 2, maxX: cx + w / 2, minY: 0, maxY: h, minZ: cz - d / 2, maxZ: cz + d / 2 });
    if (rnd() < 0.5) { b.cyl(1, 1.6, 0x8b5a2b, cx + w / 4, h + 0.4, cz, 8); b.cone(1.1, 0.8, 0x6b3f1d, cx + w / 4, h + 2, cz, 8); }
    else b.box(1.6, 1, 1.4, 0xcbd5e1, cx - w / 4, h + 0.4, cz);
  }

  private shopBuilding(b: GeoBuilder, cx: number, cz: number, w: number, d: number, floors: number, wall: number, sz: number, rnd: () => number) {
    const h = floors * 3 + 1;
    b.box(w, h, d, wall, cx, 0, cz);
    b.gable(w + 0.6, 2.2, d + 0.8, [0xe76f51, 0x2a9d8f, 0x6d597a, 0xb5838d][Math.floor(rnd() * 4)], cx, h, cz);
    const face = cz - sz * (d / 2);
    // Shop window + awning at the ground floor
    b.box(w * 0.8, 2, 0.12, 0xbfe6ff, cx, 0.4, face - sz * 0.06);
    const aw = [0xef4444, 0x22c55e, 0x3b82f6, 0xf59e0b][Math.floor(rnd() * 4)];
    for (let i = 0; i < 6; i++) b.boxC(w * 0.85 / 6, 0.12, 1.4, i % 2 ? aw : 0xffffff, cx - w * 0.425 + (i + 0.5) * (w * 0.85 / 6), 2.9, face - sz * 0.7, { rx: sz * 0.35 });
    this.windows(b, cx, cz, w, d, floors - 1, 3, sz, rnd);
    this.colliders.push({ minX: cx - w / 2, maxX: cx + w / 2, minY: 0, maxY: h + 2, minZ: cz - d / 2, maxZ: cz + d / 2 });
  }

  private tower(b: GeoBuilder, cx: number, cz: number, w: number, d: number, floors: number, sz: number, rnd: () => number) {
    const h = floors * 3;
    const col = [0x93c5fd, 0xa5b4fc, 0x99f6e4, 0xcbd5e1][Math.floor(rnd() * 4)];
    b.box(w, h, d, col, cx, 0, cz);
    for (let f = 1; f < floors; f += 1) b.box(w + 0.15, 0.3, d + 0.15, 0xf8fafc, cx, f * 3, cz);
    b.box(w * 0.6, 2, d * 0.6, 0x64748b, cx, h, cz);
    b.cyl(0.08, 4, 0xe5e7eb, cx, h + 2, cz, 6);
    this.colliders.push({ minX: cx - w / 2, maxX: cx + w / 2, minY: 0, maxY: h + 2, minZ: cz - d / 2, maxZ: cz + d / 2 });
    void sz;
  }

  private buildParkingLots(b: GeoBuilder) {
    const rnd = mulberry(23);
    const carCols = [0xef4444, 0x3b82f6, 0xfacc15, 0x10b981, 0xffffff, 0x8b5cf6, 0x111827, 0xf97316];
    for (const [lx, lz] of [[-48, -1], [48, 1]] as const) {
      const z = lz * (CZ + RW + SW + 6.5);
      // carve a lot in front of the skyline
      b.flat(26, 9, 0x5b6170, lx, 0.06, z);
      for (let i = 0; i <= 6; i++) b.flat(0.15, 4.2, 0xffffff, lx - 12 + i * 4, 0.07, z - lz * 1.8);
      for (let i = 0; i < 6; i++) {
        if (rnd() < 0.3) continue;
        const cx = lx - 10 + i * 4, cz = z - lz * 1.8;
        this.bakedCar(b, cx, cz, Math.PI / 2 * 0 + (lz > 0 ? 0 : Math.PI), carCols[Math.floor(rnd() * carCols.length)]);
      }
    }
  }

  bakedCar(b: GeoBuilder, x: number, z: number, ry: number, color: number) {
    const prev = b.base.clone();
    b.base.copy(new THREE.Matrix4().makeRotationY(ry).setPosition(x, 0, z));
    carParts(b, color);
    b.base.copy(prev);
  }

  // ------------------------------------------------------------- textured & dynamic

  private buildBillboards() {
    const ads: [string, string, string][] = [
      ['BUSINESS TYCOON', '#7c3aed', '#fde047'], ['COFFEE 24/7 ☕', '#92400e', '#fff7ed'],
      ['MEGA SALE -50%', '#dc2626', '#ffffff'], ['INVEST IN YOURSELF', '#0f766e', '#ecfeff'],
    ];
    const spots = [[-36, 1], [36, 1], [-36, -1], [36, -1]] as const;
    const b = new GeoBuilder();
    spots.forEach(([x, sz], i) => {
      const z = sz * (CZ + RW + SW + 1.2);
      b.cyl(0.25, 6.5, 0x475569, x - 4, 0, z, 6);
      b.cyl(0.25, 6.5, 0x475569, x + 4, 0, z, 6);
      b.box(11, 4.4, 0.4, 0x1f2937, x, 5.4, z + sz * 0.25);
      const s = makeSign(ads[i][0], 10.4, 3.9, ads[i][1], ads[i][2]);
      s.rotation.y = sz > 0 ? Math.PI : 0;
      s.position.set(x, 7.6, z - sz * 0.0);
      this.root.add(s);
      this.colliders.push({ minX: x - 5.5, maxX: x + 5.5, minY: 5.4, maxY: 9.8, minZ: z - 0.5, maxZ: z + 0.5 });
    });
    this.root.add(b.build(this.q.shadows));
  }

  private buildFountainDynamic() {
    this.water = new THREE.Mesh(new THREE.CylinderGeometry(3.35, 3.35, 0.12, 20), new THREE.MeshStandardMaterial({ color: 0x5ec8f2, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.85 }));
    this.water.position.y = 0.76;
    this.root.add(this.water);
    this.jets = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.2, 10, 1, true), new THREE.MeshStandardMaterial({ color: 0xd8f3ff, transparent: true, opacity: 0.55, roughness: 0.1 }));
    this.jets.position.y = 3.9;
    this.jets.rotation.x = Math.PI;
    this.root.add(this.jets);
  }

  private buildSwitches() {
    for (const s of POWER_SWITCHES) {
      const b = new GeoBuilder();
      b.box(2.4, 0.3, 1.8, 0x64748b);
      b.box(2, 1.8, 1.4, 0xfacc15, 0, 0.3);
      b.box(2.05, 0.25, 1.45, 0x111827, 0, 1.2);
      b.cyl(0.25, 0.9, 0x475569, 0.6, 2.1, 0, 8);
      const g = b.build(this.q.shadows);
      const lever = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.9, 0.18), new THREE.MeshStandardMaterial({ color: 0xef4444 }));
      lever.position.set(-0.5, 2.3, 0.75);
      lever.name = 'lever';
      g.add(lever);
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), new THREE.MeshStandardMaterial({ color: 0x64748b, emissive: 0x000000 }));
      light.position.set(0.6, 3.2, 0);
      light.name = 'light';
      g.add(light);
      const sign = makeSign('⚡ ГЕНЕРАТОР', 2.4, 0.6, '#111827', '#fde047');
      sign.position.set(0, 1.55, 0.73); sign.rotation.y = 0;
      g.add(sign);
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
    (g.getObjectByName('lever') as THREE.Mesh).rotation.x = state === 'on' ? -0.9 : 0.4;
  }

  private spawnCars(n: number) {
    const colors = [0xef4444, 0x3b82f6, 0xfacc15, 0x10b981, 0xf97316, 0x8b5cf6, 0xffffff, 0x0ea5e9, 0xec4899, 0x111827];
    const geoCache = new Map<number, THREE.Group>();
    const make = (c: number) => {
      let tpl = geoCache.get(c);
      if (!tpl) { const b = new GeoBuilder(); carParts(b, c); tpl = b.build(this.q.shadows); geoCache.set(c, tpl); }
      return tpl.clone();
    };
    for (let i = 0; i < n; i++) {
      const onAvenue = i % 3 === 0;
      const dir: 1 | -1 = i % 2 === 0 ? 1 : -1;
      const mesh = make(colors[i % colors.length]);
      let car: Car;
      if (onAvenue) {
        const sx = i % 4 < 2 ? -1 : 1;
        car = { mesh, axis: 'z', lane: sx * A + dir * 1.75, dir, speed: 7 + (i % 3) * 2, min: -120, max: 120 };
        mesh.position.set(car.lane, 0, -100 + ((i * 53) % 200));
        mesh.rotation.y = dir > 0 ? 0 : Math.PI;
      } else {
        const sz = i % 4 < 2 ? -1 : 1;
        car = { mesh, axis: 'x', lane: sz * CZ - dir * 1.75, dir, speed: 8 + (i % 3) * 2.5, min: -170, max: 170 };
        mesh.position.set(-150 + ((i * 61) % 300), 0, car.lane);
        mesh.rotation.y = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
      }
      this.root.add(mesh);
      this.cars.push(car);
    }
  }

  private spawnWalkers(n: number) {
    const rnd = mulberry(5);
    const lines: [number, number, number, number][] = [];
    for (const sx of [-1, 1]) for (const side of [-1, 1]) {
      const x = sx * A + side * (RW + SW / 2);
      lines.push([x, -CZ + RW + 1, x, CZ - RW - 1]);
    }
    for (const sz of [-1, 1]) for (const side of [-1, 1]) {
      const z = sz * CZ + side * (RW + SW / 2);
      lines.push([-75, z, -A - RW - 1, z], [-A + RW + 1, z, A - RW - 1, z], [A + RW + 1, z, 75, z]);
    }
    lines.push([-PARK_X + 1, 0.8, PARK_X - 1, 0.8], [0.6, -PARK_Z + 1, 0.6, PARK_Z - 1]);
    for (let i = 0; i < n; i++) {
      const l = lines[i % lines.length];
      const a = new THREE.Vector2(l[0], l[1]), bb = new THREE.Vector2(l[2], l[3]);
      const id = this.crowd.alloc(randomLook(rnd));
      this.walkers.push({ id, a, b: bb, t: rnd(), speed: 1.2 + rnd() * 0.7, phase: rnd() * 6, wait: 0, forward: rnd() < 0.5, len: a.distanceTo(bb) });
    }
  }

  update(dt: number, t: number, camPos: THREE.Vector3) {
    this.sky.position.copy(camPos);
    this.clouds.rotation.y += dt * 0.004;
    for (const c of this.cars) {
      const p = c.mesh.position;
      if (c.axis === 'x') { p.x += c.dir * c.speed * dt; if (p.x > c.max) p.x = c.min; if (p.x < c.min) p.x = c.max; }
      else { p.z += c.dir * c.speed * dt; if (p.z > c.max) p.z = c.min; if (p.z < c.min) p.z = c.max; }
    }
    for (const w of this.walkers) {
      if (w.wait > 0) { w.wait -= dt; this.posWalker(w, 0); continue; }
      w.t += ((w.forward ? 1 : -1) * w.speed * dt) / w.len;
      if (w.t > 1 || w.t < 0) { w.t = Math.min(1, Math.max(0, w.t)); w.forward = !w.forward; w.wait = 0.5 + Math.random() * 2.5; }
      w.phase += dt * w.speed * 5;
      this.posWalker(w, 0.65);
    }
    if (this.water) this.water.position.y = 0.76 + Math.sin(t * 2) * 0.03;
    if (this.jets) this.jets.scale.y = 1 + Math.sin(t * 6) * 0.08;
  }

  private posWalker(w: Walker, swing: number) {
    const x = w.a.x + (w.b.x - w.a.x) * w.t, z = w.a.y + (w.b.y - w.a.y) * w.t;
    const dx = (w.b.x - w.a.x) * (w.forward ? 1 : -1), dz = (w.b.y - w.a.y) * (w.forward ? 1 : -1);
    this.crowd.pose(w.id, x, 0.16, z, Math.atan2(dx, dz), w.phase, swing);
  }
}

/** Shared low-poly car (baked). Faces +Z. */
export function carParts(b: GeoBuilder, color: number) {
  b.box(1.9, 0.75, 4.1, color, 0, 0.3, 0);
  b.box(1.7, 0.7, 2.2, color, 0, 1.05, -0.25);
  b.box(1.72, 0.5, 2.0, 0x1e3a5f, 0, 1.12, -0.25);
  b.box(1.92, 0.2, 0.2, 0xfef3c7, 0, 0.75, 2.02);
  b.box(1.92, 0.2, 0.2, 0xef4444, 0, 0.75, -2.02);
  for (const [x, z] of [[-0.9, 1.3], [0.9, 1.3], [-0.9, -1.3], [0.9, -1.3]]) {
    b.add(new THREE.CylinderGeometry(1, 1, 1, 10), 0x111827, 0.4, 0.3, 0.4, { x, y: 0.4, z, rz: Math.PI / 2 });
  }
}

// ---------------------------------------------------------------------------
// Legacy helpers still used by other client modules (will move with their rewrites).
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
    g.fillStyle = (x * 7 + y * 3) % 5 === 0 ? '#ffe9a8' : win;
    g.fillRect(x * cw + cw * 0.18, y * rh + rh * 0.2, cw * 0.64, rh * 0.55);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  facadeCache.set(key, t);
  return t;
}
export function carMesh(color: number) {
  const b = new GeoBuilder();
  carParts(b, color);
  return b.build(true);
}
export function pedestrianMesh(shirt: number) {
  const g = new THREE.Group();
  const legs: THREE.Object3D[] = [];
  for (const x of [-0.15, 0.15]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.75, 0);
    pivot.add(box(0.2, 0.75, 0.22, 0x374151, 0, -0.75));
    g.add(pivot);
    legs.push(pivot);
  }
  g.add(box(0.6, 0.75, 0.35, shirt, 0, 0.75));
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), mat(0xf1c27d));
  head.position.y = 1.78;
  g.add(head);
  g.userData.legs = legs;
  return g;
}
