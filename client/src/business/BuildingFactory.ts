import * as THREE from 'three';
import { VENUES, type StructureId, type VenueId } from '../../../shared/constants/config';
import { GeoBuilder, PAL, makeSign } from '../world/geo';

// Procedural low-poly buildings, baked into merged vertex-colored meshes.
// Local frame: +X faces the park (front) unless stated otherwise.

const shade = (c: number, l: number) => new THREE.Color(c).offsetHSL(0, 0, l).getHex();

function withSign(g: THREE.Group, text: string, w: number, h: number, x: number, y: number, z: number, bg: string, fg: string, ry = 0) {
  const s = makeSign(text, w, h, bg, fg);
  s.position.set(x, y, z);
  s.rotation.y = Math.PI / 2 + ry;
  g.add(s);
  return s;
}

function awning(b: GeoBuilder, x: number, y: number, z: number, width: number, a: number, c: number, axis: 'z' | 'x' = 'z') {
  const n = Math.max(3, Math.round(width / 0.7));
  for (let i = 0; i < n; i++) {
    const off = -width / 2 + (i + 0.5) * (width / n);
    if (axis === 'z') b.boxC(1.3, 0.12, width / n, i % 2 ? a : c, x, y, z + off, { rz: -0.38 });
    else b.boxC(width / n, 0.12, 1.3, i % 2 ? a : c, x + off, y, z, { rx: 0.38 });
  }
}

/** Glass front on the +X face. */
function glassFront(b: GeoBuilder, x: number, y: number, w: number, h: number, z = 0) {
  b.glassBox(0.12, h, w, PAL.glass, x, y, z);
  b.box(0.16, 0.18, w + 0.2, 0xf8fafc, x, y + h, z);
}

function windowRows(b: GeoBuilder, faceX: number, depth: number, floors: number, y0: number, floorH: number, color = 0x9fd3ff) {
  const cols = Math.max(2, Math.floor(depth / 1.9));
  for (let f = 0; f < floors; f++) for (let c = 0; c < cols; c++) {
    const z = -depth / 2 + (c + 0.5) * (depth / cols);
    b.box(0.1, floorH * 0.5, depth / cols * 0.6, (c + f) % 5 === 0 ? 0xffe9a8 : color, faceX, y0 + f * floorH + floorH * 0.25, z);
  }
}

/** Visual footprint per HQ tier (index = tier-1). */
export const TIER_SIZE = [3.6, 5.2, 7, 9, 10, 12, 13, 12, 12, 13];
export const TIER_HEIGHT = [3.4, 4.2, 6.2, 7.5, 7, 8.5, 12, 22, 34, 48];

export function createTierBuilding(tier: number, accent: number): THREE.Group {
  const b = new GeoBuilder();
  const g = new THREE.Group();
  const acc = '#' + accent.toString(16).padStart(6, '0');
  switch (tier) {
    case 1: { // Coffee / lemonade stand
      b.box(3.4, 0.2, 3.4, 0x9ca3af);
      b.box(3, 2.1, 2.6, 0xfff3d6, 0, 0.2);
      b.box(3.1, 0.25, 2.7, accent, 0, 2.3);
      b.box(0.2, 1.0, 2.4, 0xb7793f, 1.55, 0.2); // counter front
      awning(b, 1.9, 2.25, 0, 3.0, 0xfacc15, 0xffffff);
      b.cyl(0.55, 0.9, 0xffffff, 0, 2.55, 0, 12);
      b.cyl(0.5, 0.06, 0x6b3e26, 0, 3.42, 0, 12);
      b.box(0.1, 0.9, 0.7, 0x111827, 1.7, 0.2, 1.1); // menu board
      withSign(g, 'COFFEE', 2.4, 0.5, 1.56, 1.85, 0, '#fde047', '#3b2416');
      break;
    }
    case 2: { // Coffee shop
      b.box(5.2, 0.2, 4.6, 0x9ca3af);
      b.box(5, 3.2, 4.2, 0xe9cfae, 0, 0.2);
      b.box(5.3, 0.35, 4.5, 0x6b3e26, 0, 3.4);
      glassFront(b, 2.52, 0.6, 3, 1.8);
      awning(b, 3.1, 2.95, 0, 4.2, 0x6b3e26, 0xfef3c7);
      b.cyl(0.65, 1, 0xffffff, -0.6, 3.75, 0, 12);
      b.cyl(0.6, 0.06, 0x4b2e1e, -0.6, 4.72, 0, 12);
      for (const z of [-1.4, 1.4]) { b.cyl(0.35, 0.05, 0xffffff, 3.6, 0.75, z, 8); b.cyl(0.05, 0.75, PAL.metal, 3.6, 0, z, 6); }
      withSign(g, '☕ COFFEE SHOP', 3.6, 0.6, 2.62, 2.55, 0, '#3b2416', '#fde68a');
      break;
    }
    case 3: { // Cafe
      b.box(7, 0.2, 6.2, 0x9ca3af);
      b.box(7, 5.6, 6, 0xfde2c8, 0, 0.2);
      b.box(7.3, 0.35, 6.3, accent, 0, 5.8);
      glassFront(b, 3.52, 0.5, 3.4, 2.2, -1.2);
      b.box(0.12, 2.3, 1.2, 0x7c4a1e, 3.52, 0.2, 1.8);
      windowRows(b, 3.52, 6, 1, 3.4, 2.4);
      awning(b, 4.1, 3.0, 0, 6, accent, 0xffffff);
      for (let i = -2; i <= 2; i++) b.box(0.1, 0.8, 0.1, 0xffffff, 3.3, 6.15, i * 1.4);
      b.box(0.1, 0.1, 5.8, 0xffffff, 3.3, 6.9, 0);
      withSign(g, '🍔 CAFÉ', 4.2, 0.9, 3.54, 4.9, 0, acc, '#ffffff');
      break;
    }
    case 4: { // Restaurant
      b.box(9, 0.2, 7.4, 0x9ca3af);
      b.box(9, 6.6, 7.2, 0xf4c7a1, 0, 0.2);
      b.gable(9.6, 2.4, 7.8, 0x991b1b, 0, 6.8, 0);
      b.box(1, 2.4, 1, 0x57534e, -2.5, 7.2, 2.3);
      glassFront(b, 4.52, 0.5, 3.6, 2.3, -1.8);
      b.box(0.12, 2.4, 1.4, 0x7c4a1e, 4.52, 0.2, 1.9);
      windowRows(b, 4.52, 7.2, 1, 3.6, 2.6);
      awning(b, 5.1, 3.0, 0, 7.2, 0x991b1b, 0xffffff);
      for (let i = 0; i < 8; i++) b.ball(0.12, [0xfde047, 0xf472b6, 0x60a5fa][i % 3], 5.6, 3.4 - Math.sin(i / 7 * Math.PI) * 0.4, -3.4 + i);
      withSign(g, '🍽 RESTAURANT', 6, 1, 4.6, 5.6, 0, '#7f1d1d', '#fde68a');
      break;
    }
    case 5: { // Shop
      b.box(10.2, 0.2, 8.4, 0x9ca3af);
      b.box(10, 6.2, 8, 0xdbeafe, 0, 0.2);
      glassFront(b, 5.02, 0.4, 7.4, 3.2);
      b.box(10.4, 1.3, 8.4, accent, 0, 6.4);
      b.box(1.8, 1, 1.4, 0xcbd5e1, -2.5, 7.7, 2);
      b.box(1.8, 1, 1.4, 0xcbd5e1, -2.5, 7.7, -2);
      windowRows(b, 5.02, 8, 1, 3.8, 2.4);
      withSign(g, '🏪 SHOP', 6, 1.1, 5.22, 7.05, 0, acc, '#ffffff');
      break;
    }
    case 6: { // Supermarket
      b.box(12.4, 0.2, 11.4, 0x9ca3af);
      b.box(12, 7.4, 11, 0xecfccb, 0, 0.2);
      glassFront(b, 6.02, 0.4, 9, 3.4);
      b.box(2.4, 0.3, 4.5, 0x16a34a, 7.1, 3.6, 0);
      b.cyl(0.1, 3.5, PAL.metal, 8.1, 0.2, -2, 6);
      b.cyl(0.1, 3.5, PAL.metal, 8.1, 0.2, 2, 6);
      b.box(12.4, 1.6, 11.4, 0x16a34a, 0, 7.6);
      for (let i = 0; i < 4; i++) b.box(0.8, 0.8, 0.5, 0x94a3b8, 7.6, 0.2, -4.8 + i * 0.65);
      withSign(g, '🛒 SUPERMARKET', 9, 1.4, 6.27, 8.4, 0, '#15803d', '#ffffff');
      break;
    }
    case 7: { // Mall
      b.box(13.4, 0.2, 12.4, 0x9ca3af);
      b.box(13, 10.5, 12, 0xf5f3ff, 0, 0.2);
      glassFront(b, 6.52, 0.4, 11, 9.4);
      for (let f = 1; f < 3; f++) b.box(0.3, 0.2, 12, 0xffffff, 6.6, f * 3.4, 0);
      b.ball(4.2, 0x99e5f5, 0, 10.7, 0, true);
      b.box(9, 0.6, 9, 0xf5f3ff, 0, 10.6);
      withSign(g, '🏬 MALL', 7, 1.4, 6.62, 11.2, 0, '#6d28d9', '#ffffff');
      break;
    }
    case 8: { // Business center
      b.box(12.4, 0.2, 12.4, 0x9ca3af);
      b.box(12, 4.2, 12, 0xe5e7eb, 0, 0.2);
      glassFront(b, 6.02, 0.4, 9, 3.2);
      b.box(9, 17, 9, 0x93c5fd, 0, 4.4);
      for (let f = 0; f < 6; f++) b.box(9.15, 0.35, 9.15, 0xf8fafc, 0, 6 + f * 2.7);
      b.box(4, 2, 4, 0x1e3a8a, 0, 21.4);
      withSign(g, '🏢 BUSINESS CENTER', 7.6, 1.3, 4.6, 19, 0, '#1e3a8a', '#ffffff');
      break;
    }
    case 9: { // Skyscraper
      b.box(12.4, 0.2, 12.4, 0x9ca3af);
      b.box(12, 3.2, 12, 0xe5e7eb, 0, 0.2);
      b.box(8.4, 14, 8.4, 0x7dd3fc, 0, 3.4);
      b.box(7, 10, 7, 0x7dd3fc, 0, 17.4);
      b.box(5.4, 6, 5.4, 0x7dd3fc, 0, 27.4);
      for (let f = 0; f < 10; f++) { const w = f < 5 ? 8.55 : f < 8 ? 7.15 : 5.55; b.box(w, 0.3, w, 0xf8fafc, 0, 5 + f * 2.8); }
      b.cyl(0.15, 7, 0xe5e7eb, 0, 33.4, 0, 6);
      b.ball(0.35, 0xef4444, 0, 40.5, 0);
      withSign(g, '🌆 TOWER', 6, 1.4, 4.25, 15.5, 0, '#0c4a6e', '#ffffff');
      break;
    }
    default: { // 10: BUSINESS EMPIRE
      const gold = 0xfacc15, goldD = 0xca8a04;
      b.box(13.4, 0.3, 13.4, goldD);
      b.box(13, 4.4, 13, 0xfef3c7, 0, 0.3);
      glassFront(b, 6.52, 0.6, 10, 3.4);
      b.box(9.4, 20, 9.4, 0xfde68a, 0, 4.7);
      b.box(7.4, 14, 7.4, 0xfcd34d, 0, 24.7);
      for (let f = 0; f < 11; f++) { const w = f < 7 ? 9.6 : 7.6; b.box(w, 0.35, w, gold, 0, 7 + f * 2.9); }
      b.cone(5, 8, gold, 0, 38.7, 0, 4);
      b.cyl(3, 0.3, 0xffffff, 0, 46.8, 0, 12);
      withSign(g, '👑 EMPIRE', 7, 1.8, 4.75, 21, 0, '#78350f', '#fde047');
      const orb = new THREE.Mesh(new THREE.OctahedronGeometry(1.3), new THREE.MeshStandardMaterial({ color: gold, metalness: 0.8, roughness: 0.25, emissive: 0x6b4f00 }));
      orb.position.y = 48.6; orb.name = 'spin';
      g.add(orb);
      break;
    }
  }
  g.add(b.build(true));
  return g;
}

/** Venue buildings: door faces +Z. Level 1..3 grows height/details. */
export function createVenue(id: VenueId, level: number): THREE.Group {
  const b = new GeoBuilder();
  const g = new THREE.Group();
  const d = VENUES[id];
  const col = d.color;
  const L = Math.max(1, level);
  const signBg = '#' + col.toString(16).padStart(6, '0');
  const frontSign = (text: string, w: number, h: number, y: number, z: number) => {
    const s = makeSign(text, w, h, signBg, '#ffffff');
    s.rotation.y = 0; // facing +Z
    s.position.set(0, y, z);
    g.add(s);
  };
  const glassZ = (z: number, y: number, w: number, h: number) => { b.add(new THREE.BoxGeometry(1, 1, 1), PAL.glass, w, h, 0.12, { y: y + h / 2, z }, true); };
  switch (id) {
    case 'burger': {
      const h = 3.6 + (L - 1) * 2.4;
      b.box(8, 0.2, 7, 0x9ca3af);
      b.box(7.6, h, 6.6, 0xfef2f2, 0, 0.2);
      b.box(7.8, 0.6, 6.8, col, 0, h + 0.2);
      glassZ(3.32, 0.6, 5, 2);
      for (let i = 0; i < 8; i++) b.boxC(7.6 / 8, 0.12, 1.3, i % 2 ? col : 0xffffff, -3.8 + (i + 0.5) * 0.95, 3, 3.9, { rx: 0.38 });
      // giant burger on the roof
      const ry = h + 0.8;
      b.cyl(1.4, 0.5, 0xd97706, 0, ry, 0, 12); b.cyl(1.5, 0.3, 0x7c2d12, 0, ry + 0.5, 0, 12);
      b.cyl(1.55, 0.12, 0x22c55e, 0, ry + 0.8, 0, 12); b.add(new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0xf59e0b, 1.4, 0.9, 1.4, { y: ry + 0.92 });
      if (L >= 2) windowRows2(b, 3.32, 7.6, L - 1, 3.6, 2.4);
      if (L >= 3) b.box(7.9, 0.3, 6.9, 0xfacc15, 0, h + 0.8);
      frontSign('🍔 BURGERS', 4.4, 0.8, 2.55, 3.35);
      break;
    }
    case 'restaurant': {
      const h = 5.4 + (L - 1) * 2.6;
      b.box(9, 0.2, 8, 0x9ca3af);
      b.box(8.6, h, 7.4, 0xede9fe, 0, 0.2);
      b.gable(9.2, 2.2, 8, 0x5b21b6, 0, h + 0.2, 0, Math.PI / 2);
      glassZ(3.72, 0.6, 3.4, 2.2);
      windowRows2(b, 3.72, 8.6, 1 + (L - 1), 3.2, 2.6);
      for (const x of [-3, 3]) { b.cyl(0.05, 2.2, 0xe5e7eb, x, 0.2, 5, 6); b.cone(1.3, 0.6, col, x, 2.4, 5, 8); b.cyl(0.5, 0.05, 0xffffff, x, 0.95, 5, 8); }
      if (L >= 3) for (let i = 0; i < 9; i++) b.ball(0.13, [0xfde047, 0xf472b6, 0x60a5fa][i % 3], -4 + i, h - 0.4, 3.85);
      frontSign('🍝 RESTAURANT', 5.4, 0.9, h - 1.2 + 0.3, 3.75);
      break;
    }
    case 'supermarket': {
      const h = 5.6 + (L - 1) * 1.6;
      b.box(10, 0.2, 8.6, 0x9ca3af);
      b.box(9.8, h, 8.2, 0xf0fdf4, 0, 0.2);
      b.box(10, 1.4, 8.4, col, 0, h + 0.2);
      glassZ(4.12, 0.4, 7.4, 3);
      b.box(5, 0.25, 1.8, col, 0, 3.6, 4.9);
      for (let i = 0; i < 4 + L; i++) b.box(0.6, 0.7, 0.9, 0x94a3b8, -4.4 + i * 0.75, 0.2, 5.6);
      if (L >= 2) { b.box(2, 1, 1.6, 0xcbd5e1, -2.5, h + 1.6, 0); b.box(2, 1, 1.6, 0xcbd5e1, 2.5, h + 1.6, 0); }
      frontSign('🛒 SUPERMARKET', 7, 1.1, h + 0.9, 4.25);
      break;
    }
    case 'cars': {
      const h = 4.6 + (L - 1) * 1.8;
      b.box(10, 0.2, 8.6, 0x9ca3af);
      b.glassBox(9.6, h, 6.4, 0xbfe6ff, 0, 0.2, -0.8);
      b.box(9.8, 0.5, 6.6, 0x0f172a, 0, h + 0.2, -0.8);
      b.box(9.8, 0.2, 6.6, 0x0f172a, 0, 0.2, -0.8);
      const carCols = [0xef4444, 0xfacc15, 0x22c55e];
      for (let i = 0; i < Math.min(3, L + 1); i++) {
        const base = new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(-3 + i * 3, 0.2, i === 2 ? -1.5 : 3.2);
        const prev = b.base.clone(); b.base.copy(base);
        b.box(1.9, 0.75, 4.1, carCols[i], 0, 0.3, 0); b.box(1.7, 0.7, 2.2, carCols[i], 0, 1.05, -0.25); b.box(1.72, 0.5, 2.0, 0x1e3a5f, 0, 1.12, -0.25);
        b.base.copy(prev);
      }
      for (const x of [-4.6, 4.6]) { b.cyl(0.06, 4.5, 0xe5e7eb, x, 0.2, 4, 6); b.box(0.05, 0.9, 1.2, col, x, 3.6, 4.6); }
      frontSign('🚗 AUTO CENTER', 6, 1, h - 0.4, 2.42);
      break;
    }
    case 'hotel': {
      const floors = 4 + (L - 1) * 2;
      const h = floors * 2.8;
      b.box(9, 0.2, 8, 0x9ca3af);
      b.box(8.4, h, 7, 0xfce7f3, 0, 0.2);
      b.box(8.8, 0.5, 7.4, col, 0, h + 0.2);
      for (let f = 1; f < floors; f++) for (let c = -1; c <= 1; c++) {
        b.box(1.8, 1.3, 0.1, 0x9fd3ff, c * 2.6, f * 2.8 + 0.9, 3.52);
        b.box(2, 0.12, 0.8, 0xffffff, c * 2.6, f * 2.8 + 0.6, 3.9); // balcony
      }
      b.box(3.6, 0.25, 2.2, col, 0, 3, 4.6);
      glassZ(3.52, 0.2, 2.4, 2.6);
      frontSign('🏨 HOTEL', 3.6, 0.9, 3.75, 5.75);
      if (L >= 3) b.box(2, 1.6, 2, 0xfacc15, 0, h + 0.7);
      break;
    }
    default: { // mall
      const h = 7 + (L - 1) * 3;
      b.box(11, 0.2, 9.4, 0x9ca3af);
      b.box(10.6, h, 9, 0xfffbeb, 0, 0.2);
      glassZ(4.52, 0.4, 8, h - 1.2);
      for (let f = 1; f < Math.floor(h / 3.4) + 1; f++) b.box(10.6, 0.25, 0.3, 0xffffff, 0, f * 3.4, 4.6);
      b.ball(3, 0xfde68a, 0, h + 0.2, 0, true);
      b.box(10.8, 0.6, 9.2, col, 0, h + 0.2);
      frontSign('🏬 SHOPPING MALL', 7, 1.2, h - 0.6, 4.7);
      break;
    }
  }
  g.add(b.build(true));
  return g;
}

/** Window rows on a +Z face. */
function windowRows2(b: GeoBuilder, faceZ: number, width: number, floors: number, y0: number, floorH: number) {
  const cols = Math.max(2, Math.floor(width / 1.9));
  for (let f = 0; f < floors; f++) for (let c = 0; c < cols; c++) {
    const x = -width / 2 + (c + 0.5) * (width / cols);
    b.box(width / cols * 0.6, floorH * 0.5, 0.1, (c + f) % 4 === 0 ? 0xffe9a8 : 0x9fd3ff, x, y0 + f * floorH + floorH * 0.25, faceZ);
  }
}

export function createStructure(id: StructureId, accent: number): THREE.Group {
  const b = new GeoBuilder();
  const g = new THREE.Group();
  switch (id) {
    case 'billboard': {
      b.cyl(0.18, 5, PAL.metal, 0, 0, -2, 6); b.cyl(0.18, 5, PAL.metal, 0, 0, 2, 6);
      b.box(0.35, 2.8, 6.2, 0x1f2937, 0, 4.4, 0);
      const s = makeSign('BEST PRICES!', 6, 2.5, '#' + shade(accent, -0.1).toString(16).padStart(6, '0'), '#ffffff');
      s.position.set(0.2, 5.8, 0);
      g.add(s);
      break;
    }
    case 'parking': {
      b.flat(9, 6, 0x4b5563, 0, 0.05, 0);
      for (let i = -1; i <= 2; i++) b.flat(0.15, 5, 0xffffff, -4.5 + i * 3 + 1.5, 0.06, 0);
      const base = new THREE.Matrix4();
      for (const [x, c] of [[-1.5, 0xef4444], [1.5, 0x3b82f6]] as const) {
        b.base.copy(base.makeTranslation(x, 0, 0));
        b.box(1.9, 0.75, 4.1, c, 0, 0.3, 0); b.box(1.7, 0.7, 2.2, c, 0, 1.05, -0.25); b.box(1.72, 0.5, 2.0, 0x1e3a5f, 0, 1.12, -0.25);
      }
      b.base.identity();
      b.cyl(0.06, 2.2, PAL.metal, 4.4, 0, -2.8, 6);
      const p = makeSign('P', 0.9, 0.9, '#1d4ed8', '#ffffff');
      p.position.set(4.45, 2.4, -2.8);
      g.add(p);
      break;
    }
    case 'warehouse': {
      b.box(6, 3.6, 6, 0xb45309);
      b.add(new THREE.CylinderGeometry(3.1, 3.1, 6.2, 12, 1, false, 0, Math.PI), 0x78716c, 1, 1, 1, { y: 3.6, rz: Math.PI / 2, ry: Math.PI / 2 });
      b.box(0.1, 2.6, 2.6, 0x57534e, 3.02, 0, 0);
      for (let i = 0; i < 3; i++) b.box(0.9, 0.9, 0.9, 0xd6a35c, 3.8, 0, -1.4 + i * 1.1);
      break;
    }
    case 'terrace': {
      b.box(6, 0.2, 4, 0xc08a5b);
      for (const [x, z] of [[-1.8, -1], [1.6, -1], [0, 1.1]]) {
        b.cyl(0.55, 0.06, 0xffffff, x, 0.95, z, 12);
        b.cyl(0.06, 0.8, PAL.metal, x, 0.2, z, 6);
        b.cyl(0.04, 2.4, 0xe5e7eb, x, 0.2, z, 6);
        b.cone(1.4, 0.7, accent, x, 2.5, z, 8);
      }
      break;
    }
    case 'fountain': {
      b.cyl(2.4, 0.7, 0xd6d3d1, 0, 0, 0, 12);
      b.cyl(2.1, 0.72, 0x5ec8f2, 0, 0, 0, 12);
      b.cyl(0.3, 2, 0xd6d3d1, 0, 0, 0, 8);
      const gold = new THREE.Mesh(new THREE.TorusKnotGeometry(0.45, 0.15, 40, 6), new THREE.MeshStandardMaterial({ color: 0xfacc15, metalness: 0.7, roughness: 0.3 }));
      gold.position.y = 2.5; gold.name = 'spin';
      g.add(gold);
      break;
    }
  }
  g.add(b.build(true));
  return g;
}

export function createCounter(accent: number): THREE.Group {
  const b = new GeoBuilder();
  b.box(1.3, 1.1, 3.2, 0xffffff);
  b.box(1.5, 0.12, 3.4, accent, 0, 1.1);
  b.box(0.5, 0.4, 0.5, 0x111827, 0, 1.22, 0.9); // register
  b.cyl(0.2, 0.6, 0xfde047, 0, 1.22, -0.7, 8);
  return b.build(true);
}

export function createMachine(accent: number): THREE.Group {
  const b = new GeoBuilder();
  b.box(2.2, 1.8, 2, 0x94a3b8);
  b.box(2.3, 0.2, 2.1, accent, 0, 1.8);
  b.cyl(0.6, 0.1, 0x64748b, 0, 3.2, 0, 12);
  const g = b.build(true);
  const gear = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.15, 6, 10), new THREE.MeshStandardMaterial({ color: 0xfacc15, flatShading: true }));
  gear.position.set(1.15, 1.1, 0); gear.rotation.y = Math.PI / 2; gear.name = 'gear';
  g.add(gear);
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.2, 12), new THREE.MeshStandardMaterial({ color: 0xfde047, transparent: true, opacity: 0.8 }));
  tank.position.set(0, 2.6, 0);
  g.add(tank);
  return g;
}

export function createCrate(): THREE.Group {
  const b = new GeoBuilder();
  b.box(1, 1, 1, 0xd6a35c);
  b.box(1.04, 0.14, 1.04, 0x92400e, 0, 0.42);
  b.box(0.14, 1.02, 1.04, 0x92400e, 0, 0);
  return b.build(true);
}

export function createDeliveryTruck(): THREE.Group {
  const b = new GeoBuilder();
  b.box(2.4, 2.6, 5, 0xffffff, 0, 0.5, -0.8);
  b.box(2.3, 1.8, 1.8, 0xef4444, 0, 0.5, 2.6);
  b.box(2.32, 0.7, 0.1, 0x1e3a5f, 0, 1.4, 3.52);
  for (const [x, z] of [[-1.1, 2.4], [1.1, 2.4], [-1.1, -2.2], [1.1, -2.2]]) {
    b.add(new THREE.CylinderGeometry(1, 1, 1, 10), 0x111827, 0.45, 0.35, 0.45, { x, y: 0.45, z, rz: Math.PI / 2 });
  }
  const g = b.build(true);
  const s = makeSign('📦 BIG DELIVERY', 4.6, 1.2, '#ef4444', '#ffffff');
  s.rotation.y = Math.PI / 2;
  s.position.set(1.22, 1.9, -0.8);
  g.add(s);
  return g;
}

export function createMegaMall(): THREE.Group {
  const b = new GeoBuilder();
  const g = new THREE.Group();
  b.box(24, 10, 26, 0xfdf4ff);
  b.box(16, 8, 18, 0xf5d0fe, -2, 10);
  b.glassBox(0.2, 8, 18, PAL.glass, 12, 0.5, 0);
  for (let f = 1; f < 3; f++) b.box(0.4, 0.3, 26, 0xffffff, 12.1, f * 3.3, 0);
  b.ball(6, 0xfacc15, -2, 18, 0, true);
  b.box(24.4, 0.6, 26.4, 0xa21caf, 0, 10);
  g.add(b.build(true));
  const s = makeSign('🏬 MEGA MALL', 14, 2.4, '#a21caf', '#fde047');
  s.position.set(12.2, 8.2, 0);
  g.add(s);
  return g;
}

export function createConstructionSite(): THREE.Group {
  const b = new GeoBuilder();
  const g = new THREE.Group();
  b.flat(26, 26, 0xa16207, 0, 0.05, 0);
  for (let i = -12; i <= 12; i += 2) { b.box(0.15, 1.6, 0.15, 0xf97316, 13, 0, i); b.box(0.15, 1.6, 0.15, 0xf97316, -13, 0, i); }
  b.box(0.1, 0.25, 26, 0xfacc15, 13, 1.2, 0);
  b.box(1, 22, 1, 0xfacc15, -6, 0, -8);
  for (let y = 2; y < 22; y += 2) b.box(1.1, 0.1, 1.1, 0x111827, -6, y, -8);
  g.add(b.build(true));
  const jb = new GeoBuilder();
  jb.box(16, 0.8, 0.8, 0xfacc15, 4, 0, 0);
  jb.box(2.4, 1.6, 1.4, 0x475569, -3.4, -0.4, 0);
  const jib = jb.build(true);
  jib.position.set(-6, 22, -8);
  jib.name = 'spin';
  g.add(jib);
  const s = makeSign('MEGA MALL — СКОРО', 9, 1.4, '#a21caf', '#ffffff');
  s.position.set(13.1, 2.6, 0);
  g.add(s);
  return g;
}
