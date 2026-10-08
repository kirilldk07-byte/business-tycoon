import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Low-poly geometry builder with baked vertex colors. Everything added to a
// builder is merged into ONE mesh (one draw call) that shares one material.

const UNIT = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl8: new THREE.CylinderGeometry(1, 1, 1, 8),
  cyl12: new THREE.CylinderGeometry(1, 1, 1, 12),
  cyl6: new THREE.CylinderGeometry(1, 1, 1, 6),
  ico0: new THREE.IcosahedronGeometry(1, 0),
  ico1: new THREE.IcosahedronGeometry(1, 1),
  sphere: new THREE.SphereGeometry(1, 10, 8),
  plane: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
};

let sharedMat: THREE.MeshStandardMaterial | null = null;
/** The one material used by all baked geometry. */
export function vcMaterial() {
  if (!sharedMat) sharedMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.02, flatShading: true });
  return sharedMat;
}
let glassMat: THREE.MeshStandardMaterial | null = null;
export function vcGlassMaterial() {
  if (!glassMat) glassMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.15, metalness: 0.35, flatShading: true });
  return glassMat;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const tmpC = new THREE.Color();

export interface Xform { x?: number; y?: number; z?: number; rx?: number; ry?: number; rz?: number }

export class GeoBuilder {
  private parts: THREE.BufferGeometry[] = [];
  private glass: THREE.BufferGeometry[] = [];
  /** Extra transform applied to everything added (for building in a local frame). */
  base = new THREE.Matrix4();

  add(src: THREE.BufferGeometry, color: number, sx: number, sy: number, sz: number, t: Xform = {}, isGlass = false) {
    const g = (src.index ? src.toNonIndexed() : src.clone());
    tmpE.set(t.rx ?? 0, t.ry ?? 0, t.rz ?? 0);
    tmpQ.setFromEuler(tmpE);
    tmpP.set(t.x ?? 0, t.y ?? 0, t.z ?? 0);
    tmpS.set(sx, sy, sz);
    tmpM.compose(tmpP, tmpQ, tmpS).premultiply(this.base);
    g.applyMatrix4(tmpM);
    const n = g.attributes.position.count;
    const cols = new Float32Array(n * 3);
    tmpC.setHex(color); // setHex already converts sRGB → linear working space
    for (let i = 0; i < n; i++) { cols[i * 3] = tmpC.r; cols[i * 3 + 1] = tmpC.g; cols[i * 3 + 2] = tmpC.b; }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    if (g.attributes.uv) g.deleteAttribute('uv');
    if (g.attributes.uv1) g.deleteAttribute('uv1');
    (isGlass ? this.glass : this.parts).push(g);
    return this;
  }

  /** Box resting on y (bottom at y). */
  box(w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0, ry = 0) {
    return this.add(UNIT.box, color, w, h, d, { x, y: y + h / 2, z, ry });
  }
  /** Box centered at y. */
  boxC(w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0, t: Xform = {}) {
    return this.add(UNIT.box, color, w, h, d, { x, y, z, ...t });
  }
  glassBox(w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0) {
    return this.add(UNIT.box, color, w, h, d, { x, y: y + h / 2, z }, true);
  }
  cyl(r: number, h: number, color: number, x = 0, y = 0, z = 0, seg: 6 | 8 | 12 = 8, t: Xform = {}) {
    const g = seg === 6 ? UNIT.cyl6 : seg === 12 ? UNIT.cyl12 : UNIT.cyl8;
    return this.add(g, color, r, h, r, { x, y: y + h / 2, z, ...t });
  }
  /** Tapered cylinder / cone (rb bottom radius, rt top radius). */
  taper(rb: number, rt: number, h: number, color: number, x = 0, y = 0, z = 0, seg = 8, t: Xform = {}) {
    const g = new THREE.CylinderGeometry(rt, rb, h, seg);
    this.add(g, color, 1, 1, 1, { x, y: y + h / 2, z, ...t });
    g.dispose();
    return this;
  }
  cone(r: number, h: number, color: number, x = 0, y = 0, z = 0, seg = 7) {
    return this.taper(r, 0.001, h, color, x, y, z, seg);
  }
  ball(r: number, color: number, x = 0, y = 0, z = 0, smooth = false) {
    return this.add(smooth ? UNIT.sphere : UNIT.ico1, color, r, r, r, { x, y, z });
  }
  blob(r: number, color: number, x = 0, y = 0, z = 0, sy = 1) {
    return this.add(UNIT.ico0, color, r, r * sy, r, { x, y, z });
  }
  /** Flat horizontal quad at height y. */
  flat(w: number, d: number, color: number, x = 0, y = 0.02, z = 0, ry = 0) {
    return this.add(UNIT.plane, color, w, 1, d, { x, y, z, ry });
  }
  /** Gable roof (triangular prism) along X, ridge height h. */
  gable(w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0, ry = 0) {
    const shape = new THREE.Shape();
    shape.moveTo(-d / 2, 0); shape.lineTo(d / 2, 0); shape.lineTo(0, h); shape.lineTo(-d / 2, 0);
    const g = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false });
    g.translate(0, 0, -w / 2);
    g.rotateY(Math.PI / 2);
    this.add(g, color, 1, 1, 1, { x, y, z, ry });
    g.dispose();
    return this;
  }

  get empty() { return this.parts.length === 0 && this.glass.length === 0; }

  /** Merge into a Group (1 mesh for opaque + 1 for glass). */
  build(shadows = true): THREE.Group {
    const group = new THREE.Group();
    const mk = (list: THREE.BufferGeometry[], mat: THREE.Material) => {
      if (!list.length) return;
      const merged = mergeGeometries(list, false);
      list.forEach((g) => g.dispose());
      if (!merged) return;
      merged.computeBoundingSphere();
      const m = new THREE.Mesh(merged, mat);
      m.castShadow = shadows;
      m.receiveShadow = true;
      group.add(m);
    };
    mk(this.parts, vcMaterial());
    mk(this.glass, vcGlassMaterial());
    this.parts = [];
    this.glass = [];
    return group;
  }
}

/** Canvas text sign (separate textured mesh — keep the count small). */
const signCache = new Map<string, THREE.MeshStandardMaterial>();
export function signMaterial(text: string, bg: string, fg: string, aspect: number): THREE.MeshStandardMaterial {
  const key = `${text}|${bg}|${fg}|${aspect.toFixed(2)}`;
  const hit = signCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 512; c.height = Math.max(32, Math.round(512 / aspect));
  const g = c.getContext('2d')!;
  const r = Math.min(c.height * 0.25, 40);
  g.fillStyle = bg;
  g.beginPath(); g.roundRect(0, 0, c.width, c.height, r); g.fill();
  g.strokeStyle = fg; g.globalAlpha = 0.35; g.lineWidth = 8;
  g.beginPath(); g.roundRect(10, 10, c.width - 20, c.height - 20, r * 0.7); g.stroke();
  g.globalAlpha = 1;
  g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
  let size = c.height * 0.6;
  const font = (s: number) => `900 ${s}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
  g.font = font(size);
  while (g.measureText(text).width > c.width * 0.86 && size > 10) { size -= 2; g.font = font(size); }
  g.fillText(text, c.width / 2, c.height / 2 + size * 0.05);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  const m = new THREE.MeshStandardMaterial({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.35, roughness: 0.6 });
  signCache.set(key, m);
  return m;
}

const signGeo = new THREE.PlaneGeometry(1, 1);
/** Sign plane facing +X (default) at local position. */
export function makeSign(text: string, w: number, h: number, bg = '#0f172a', fg = '#fde047'): THREE.Mesh {
  const m = new THREE.Mesh(signGeo, signMaterial(text, bg, fg, w / h));
  m.scale.set(w, h, 1);
  m.rotation.y = Math.PI / 2;
  return m;
}

/** Deterministic PRNG for reproducible decoration. */
export function mulberry(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PAL = {
  grass: 0x8fd16a, grassDark: 0x6fbf55, asphalt: 0x4a5160, asphaltDark: 0x3d4350, stripe: 0xfff4c2, white: 0xf8fafc,
  sidewalk: 0xdcd6cc, curb: 0xbfb8ad, paving: 0xece4d6, pavingDark: 0xd9cfbf, trunk: 0x8b5a2b,
  leaf: [0x5cc45a, 0x4cae4c, 0x7bd36a, 0x3f9e48], flower: [0xff7aa8, 0xffd166, 0xb388ff, 0xff8a65],
  metal: 0x3f4654, glass: 0x9fd8ff, roofGrey: 0x8b93a1,
};
