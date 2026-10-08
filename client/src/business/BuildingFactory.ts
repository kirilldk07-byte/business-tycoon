import * as THREE from 'three';
import type { StructureId, WorkerId } from '../../../shared/constants/config';
import { box, carMesh, cyl, facadeTexture, mat, pedestrianMesh } from '../world/World';

// Procedural low-poly buildings. Local frame: +X faces the plaza (front).

export function signMesh(text: string, w: number, h: number, bg = '#111827', fg = '#fde047'): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 512; c.height = Math.round((512 * h) / w);
  const g = c.getContext('2d')!;
  g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = fg; g.lineWidth = 10; g.strokeRect(8, 8, c.width - 16, c.height - 16);
  g.fillStyle = fg;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  let size = c.height * 0.55;
  g.font = `900 ${size}px system-ui, sans-serif`;
  while (g.measureText(text).width > c.width * 0.88 && size > 10) { size -= 2; g.font = `900 ${size}px system-ui, sans-serif`; }
  g.fillText(text, c.width / 2, c.height / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.25 }));
  return m;
}

/** A sign facing +X placed at (x, y, z). */
function frontSign(g: THREE.Group, text: string, x: number, y: number, z: number, w: number, h: number, bg?: string, fg?: string) {
  const s = signMesh(text, w, h, bg, fg);
  s.position.set(x + 0.02, y, z);
  s.rotation.y = Math.PI / 2;
  g.add(s);
}

function facadeBox(w: number, h: number, d: number, base: string, floors: number, x = 0, y = 0, z = 0, roof = 0x9ca3af) {
  const tex = facadeTexture(base, '#a5d8ff', Math.max(2, Math.round(d / 2)), floors);
  const side = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 });
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [side, side, mat(roof), mat(roof), side, side]);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

function awning(g: THREE.Group, x: number, y: number, z: number, width: number, a: number, b: number) {
  const n = Math.max(3, Math.round(width / 0.6));
  for (let i = 0; i < n; i++) {
    const s = box(1.2, 0.12, width / n, i % 2 ? a : b, x, y, z - width / 2 + (i + 0.5) * (width / n));
    s.rotation.z = -0.35;
    g.add(s);
  }
}

function glassFront(g: THREE.Group, x: number, y: number, z: number, w: number, h: number) {
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ color: 0x9fd8ff, metalness: 0.3, roughness: 0.1, transparent: true, opacity: 0.85 }));
  glass.position.set(x + 0.03, y + h / 2, z);
  glass.rotation.y = Math.PI / 2;
  g.add(glass);
}

function door(g: THREE.Group, x: number, z: number) {
  const d = box(0.1, 2.1, 1.4, 0x7c4a1e, x + 0.05, 0, z);
  g.add(d);
}

export const TIER_SIZE = [3, 5, 7, 9, 10, 12, 13, 9, 8, 9];

export function createTierBuilding(tier: number, accent: number): THREE.Group {
  const g = new THREE.Group();
  const acc = '#' + accent.toString(16).padStart(6, '0');
  switch (tier) {
    case 1: { // Lemonade kiosk
      g.add(box(3, 2.2, 3, 0xfff7d6));
      g.add(box(3.3, 0.25, 3.3, accent, 0, 2.2));
      awning(g, 1.9, 2.0, 0, 3.2, 0xfacc15, 0xffffff);
      const lemon = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 10), mat(0xfde047));
      lemon.scale.set(1.25, 1, 1); lemon.position.set(0, 3.1, 0);
      g.add(lemon);
      frontSign(g, 'LEMONADE', 1.51, 1.75, 0, 2.6, 0.5, '#fde047', '#111827');
      break;
    }
    case 2: { // Coffee shop
      g.add(box(5, 3, 4, 0xe9d5b7));
      g.add(box(5.4, 0.3, 4.4, 0x6b3e26, 0, 3));
      glassFront(g, 2.5, 0.4, 0, 3, 1.8);
      awning(g, 3.0, 2.7, 0, 4, 0x6b3e26, 0xfef3c7);
      const cup = cyl(0.6, 0.45, 0.9, 0xffffff, 12, 0, 3.3);
      g.add(cup);
      g.add(cyl(0.55, 0.55, 0.05, 0x4b2e1e, 12, 0, 4.18));
      frontSign(g, 'COFFEE', 2.52, 2.35, 0, 3, 0.55, '#3b2416', '#fde68a');
      break;
    }
    case 3: { // Cafe
      g.add(facadeBox(7, 5, 6, '#fde2c8', 2));
      g.add(box(7.4, 0.35, 6.4, accent, 0, 5));
      glassFront(g, 3.5, 0.3, -1.2, 3, 2);
      door(g, 3.5, 1.6);
      awning(g, 4.0, 2.8, 0, 6, accent, 0xffffff);
      frontSign(g, 'CAFÉ', 3.52, 4.2, 0, 4, 0.8, acc, '#ffffff');
      break;
    }
    case 4: { // Restaurant
      g.add(facadeBox(9, 6.5, 7, '#f4c7a1', 2, 0, 0, 0, 0x7f1d1d));
      g.add(box(9.6, 0.5, 7.6, 0x7f1d1d, 0, 6.5));
      g.add(box(1, 2, 1, 0x57534e, -3, 7, 2.2));
      glassFront(g, 4.5, 0.3, -2, 3.4, 2.2);
      door(g, 4.5, 1.8);
      awning(g, 5.0, 2.9, 0, 7, 0x991b1b, 0xffffff);
      frontSign(g, 'RESTAURANT', 4.52, 5.4, 0, 6, 1, '#7f1d1d', '#fde68a');
      break;
    }
    case 5: { // Shop
      g.add(facadeBox(10, 6, 8, '#dbeafe', 2, 0, 0, 0, 0x1e3a8a));
      glassFront(g, 5, 0.2, 0, 8, 3);
      g.add(box(10.4, 1.2, 8.4, accent, 0, 6));
      frontSign(g, 'SHOP', 5.22, 6.6, 0, 6, 1.1, acc, '#ffffff');
      break;
    }
    case 6: { // Supermarket
      g.add(facadeBox(12, 7, 12, '#ecfccb', 2, 0, 0, 0, 0x365314));
      glassFront(g, 6, 0.2, 0, 10, 3.2);
      g.add(box(12.5, 1.6, 12.5, 0x16a34a, 0, 7));
      frontSign(g, 'SUPERMARKET', 6.27, 7.8, 0, 9, 1.4, '#15803d', '#ffffff');
      for (let i = 0; i < 3; i++) g.add(box(0.8, 0.8, 0.5, 0x94a3b8, 7.2, 0, -4 + i * 0.7));
      break;
    }
    case 7: { // Mall
      g.add(facadeBox(13, 9, 12, '#f5f3ff', 3, 0, 0, 0, 0x6d28d9));
      glassFront(g, 6.5, 0.2, 0, 11, 8.5);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(4, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xa5f3fc, metalness: 0.4, roughness: 0.1, transparent: true, opacity: 0.8 }));
      dome.position.y = 9;
      g.add(dome);
      frontSign(g, 'MALL', 6.52, 9.6, 0, 7, 1.3, '#6d28d9', '#ffffff');
      break;
    }
    case 8: { // Corporation
      g.add(facadeBox(12, 4, 12, '#e5e7eb', 1, 0, 0, 0, 0x374151));
      g.add(facadeBox(9, 16, 9, '#93c5fd', 8, 0, 4, 0, 0x1e40af));
      frontSign(g, 'CORP', 4.52, 17, 0, 6, 1.6, '#1e3a8a', '#ffffff');
      g.add(box(1.4, 2.4, 1.4, 0x1e3a8a, 2.5, 20, 2.5));
      break;
    }
    case 9: { // Skyscraper
      g.add(facadeBox(12, 3, 12, '#e5e7eb', 1));
      g.add(facadeBox(8, 14, 8, '#7dd3fc', 7, 0, 3));
      g.add(facadeBox(6.5, 10, 6.5, '#7dd3fc', 5, 0, 17));
      g.add(facadeBox(5, 6, 5, '#7dd3fc', 3, 0, 27));
      g.add(cyl(0.12, 0.2, 6, 0xd1d5db, 6, 0, 33));
      frontSign(g, 'TOWER', 4.02, 15.5, 0, 6, 1.4, '#0c4a6e', '#ffffff');
      break;
    }
    default: { // 10: BUSINESS EMPIRE
      g.add(facadeBox(13, 4, 13, '#fef3c7', 1, 0, 0, 0, 0x78350f));
      g.add(facadeBox(9, 20, 9, '#fde68a', 10, 0, 4, 0, 0xca8a04));
      g.add(facadeBox(7, 14, 7, '#fcd34d', 7, 0, 24, 0, 0xca8a04));
      const gold = mat(0xfacc15, { metalness: 0.8, roughness: 0.25, emissive: 0x6b4f00 });
      const top = new THREE.Mesh(new THREE.ConeGeometry(4.5, 8, 4), gold);
      top.rotation.y = Math.PI / 4; top.position.y = 42; top.castShadow = true;
      g.add(top);
      const orb = new THREE.Mesh(new THREE.OctahedronGeometry(1.2), gold);
      orb.position.y = 47.5; orb.name = 'spin';
      g.add(orb);
      frontSign(g, 'EMPIRE', 4.52, 21, 0, 7, 1.8, '#78350f', '#fde047');
      break;
    }
  }
  return g;
}

export function createStructure(id: StructureId, accent: number): THREE.Group {
  const g = new THREE.Group();
  switch (id) {
    case 'billboard': {
      g.add(cyl(0.15, 0.15, 4, 0x6b7280, 6, 0, 0, -1.5));
      g.add(cyl(0.15, 0.15, 4, 0x6b7280, 6, 0, 0, 1.5));
      const s = signMesh('BEST PRICES!', 5, 2.2, '#' + accent.toString(16).padStart(6, '0'), '#ffffff');
      s.position.set(0.2, 5, 0); s.rotation.y = Math.PI / 2;
      g.add(s);
      g.add(box(0.3, 2.4, 5.2, 0x374151, 0, 3.9, 0));
      break;
    }
    case 'parking': {
      const lot = new THREE.Mesh(new THREE.PlaneGeometry(9, 6), mat(0x4b5563));
      lot.rotation.x = -Math.PI / 2; lot.position.y = 0.04;
      g.add(lot);
      for (let i = -1; i <= 1; i++) {
        const l = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 5), mat(0xffffff));
        l.rotation.x = -Math.PI / 2; l.position.set(i * 3, 0.05, 0);
        g.add(l);
      }
      const c1 = carMesh(0xef4444); c1.position.set(-1.5, 0, 0); g.add(c1);
      const c2 = carMesh(0x3b82f6); c2.position.set(4.3, 0, 0.3); g.add(c2);
      const p = signMesh('P', 1, 1, '#1d4ed8', '#ffffff');
      p.position.set(4.5, 2.6, -2.8); p.rotation.y = Math.PI / 2;
      g.add(p); g.add(cyl(0.06, 0.06, 2.2, 0x6b7280, 6, 4.5, 0, -2.8));
      break;
    }
    case 'warehouse': {
      g.add(box(6, 3.4, 6, 0xb45309));
      const roof = new THREE.Mesh(new THREE.CylinderGeometry(3.1, 3.1, 6.2, 12, 1, false, 0, Math.PI), mat(0x78716c));
      roof.rotation.z = Math.PI / 2; roof.rotation.y = Math.PI / 2; roof.position.y = 3.4;
      g.add(roof);
      g.add(box(0.1, 2.4, 2.4, 0x57534e, 3.02, 0, 0));
      for (let i = 0; i < 3; i++) g.add(box(0.9, 0.9, 0.9, 0xd6a35c, 3.8, 0, -1.5 + i * 1.1));
      break;
    }
    case 'terrace': {
      const deck = box(7, 0.2, 5, 0xc08a5b);
      g.add(deck);
      for (const [x, z] of [[-2, -1.2], [1.5, -1.2], [-0.2, 1.4]]) {
        g.add(cyl(0.6, 0.6, 0.08, 0xffffff, 12, x, 0.95, z));
        g.add(cyl(0.08, 0.08, 0.9, 0x374151, 6, x, 0.15, z));
        g.add(cyl(0.05, 0.05, 2.4, 0xe5e7eb, 6, x, 0.15, z));
        const um = new THREE.Mesh(new THREE.ConeGeometry(1.5, 0.7, 8), mat(accent));
        um.position.set(x, 2.7, z); um.castShadow = true;
        g.add(um);
      }
      break;
    }
    case 'fountain': {
      g.add(cyl(2.4, 2.6, 0.7, 0xd6d3d1, 16));
      const w = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.1, 0.1, 16), new THREE.MeshStandardMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.85 }));
      w.position.y = 0.65; g.add(w);
      g.add(cyl(0.3, 0.4, 2, 0xd6d3d1, 8));
      const gold = new THREE.Mesh(new THREE.TorusKnotGeometry(0.45, 0.15, 40, 6), mat(0xfacc15, { metalness: 0.7, roughness: 0.3 }));
      gold.position.y = 2.5; gold.name = 'spin';
      g.add(gold);
      break;
    }
    case 'branch': {
      g.add(facadeBox(6, 5, 5, '#fecdd3', 2, 0, 0, 0, 0x9f1239));
      g.add(box(6.3, 0.4, 5.3, accent, 0, 5));
      glassFront(g, 3, 0.2, 0, 3.5, 2);
      frontSign(g, 'BRANCH', 3.02, 3.8, 0, 4, 0.8, '#9f1239', '#ffffff');
      break;
    }
  }
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export function createCounter(accent: number): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.2, 1.1, 3, 0xffffff));
  g.add(box(1.4, 0.12, 3.2, accent, 0, 1.1));
  g.add(box(0.5, 0.4, 0.5, 0x111827, 0, 1.22, 0.8)); // register
  g.add(cyl(0.2, 0.2, 0.6, 0xfde047, 10, 0, 1.22, -0.6)); // jug
  return g;
}

export function createMachine(accent: number): THREE.Group {
  const g = new THREE.Group();
  g.add(box(2.2, 1.8, 2, 0x94a3b8));
  g.add(box(2.3, 0.2, 2.1, accent, 0, 1.8));
  const gear = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.15, 6, 10), mat(0xfacc15));
  gear.position.set(1.15, 1.1, 0); gear.rotation.y = Math.PI / 2; gear.name = 'gear';
  g.add(gear);
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.2, 12), new THREE.MeshStandardMaterial({ color: 0xfde047, transparent: true, opacity: 0.8 }));
  tank.position.set(0, 2.6, 0);
  g.add(tank);
  g.add(cyl(0.6, 0.6, 0.1, 0x64748b, 12, 0, 3.2));
  return g;
}

export function createCrate(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1, 1, 1, 0xd6a35c));
  g.add(box(1.02, 0.15, 1.02, 0x92400e, 0, 0.42));
  return g;
}

export function createDeliveryTruck(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(2.4, 2.6, 5, 0xffffff, 0, 0.5, -0.8));
  g.add(box(2.3, 1.8, 1.8, 0xef4444, 0, 0.5, 2.6));
  for (const [x, z] of [[-1.1, 2.4], [1.1, 2.4], [-1.1, -2.2], [1.1, -2.2]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.35, 10), mat(0x111827));
    w.rotation.z = Math.PI / 2; w.position.set(x, 0.45, z); g.add(w);
  }
  return g;
}

/** Staff figure (NPC) — visual representation of a hired worker. */
export function createStaff(kind: WorkerId): THREE.Group {
  const colors: Record<WorkerId, number> = { cashier: 0x0ea5e9, worker: 0xf59e0b, manager: 0x111827, delivery: 0xdc2626, marketer: 0xec4899 };
  const g = pedestrianMesh(colors[kind]);
  if (kind === 'manager') g.add(box(0.12, 0.5, 0.05, 0xdc2626, 0, 1.0, 0.19)); // tie
  if (kind === 'worker') g.add(cyl(0.32, 0.32, 0.18, 0xfacc15, 10, 0, 2.0)); // hard hat
  if (kind === 'marketer') {
    const s = signMesh('SALE!', 1.2, 0.7, '#ec4899', '#ffffff');
    s.position.set(0, 2.6, 0.2); g.add(s);
    g.add(cyl(0.04, 0.04, 1.4, 0x6b7280, 4, 0, 1.2, 0.2));
  }
  if (kind === 'delivery') {
    const scooter = new THREE.Group();
    scooter.add(box(0.5, 0.4, 1.6, 0xdc2626, 0, 0.3));
    scooter.add(box(0.7, 0.6, 0.6, 0xffffff, 0, 0.7, -0.5));
    scooter.position.set(0.9, 0, 0);
    g.add(scooter);
  }
  return g;
}

export function createMegaMall(): THREE.Group {
  const g = new THREE.Group();
  g.add(facadeBox(24, 10, 26, '#fdf4ff', 3, 0, 0, 0, 0xa21caf));
  g.add(facadeBox(16, 8, 18, '#f5d0fe', 2, -2, 10, 0, 0xa21caf));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(6, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xfacc15, { metalness: 0.6, roughness: 0.2 }));
  dome.position.set(-2, 18, 0); g.add(dome);
  frontSign(g, 'MEGA MALL', 12.02, 7.5, 0, 14, 2.4, '#a21caf', '#fde047');
  glassFront(g, 12, 0.2, 0, 18, 5);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export function createConstructionSite(): THREE.Group {
  const g = new THREE.Group();
  const dirt = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), mat(0xa16207));
  dirt.rotation.x = -Math.PI / 2; dirt.position.y = 0.04; g.add(dirt);
  for (let i = -12; i <= 12; i += 2) {
    g.add(box(0.15, 1.6, 0.15, 0xf97316, 13, 0, i));
    g.add(box(0.15, 1.6, 0.15, 0xf97316, -13, 0, i));
  }
  g.add(box(0.1, 0.25, 26, 0xfacc15, 13, 1.2, 0));
  // Crane
  g.add(box(1, 22, 1, 0xfacc15, -6, 0, -8));
  const jib = box(16, 0.8, 0.8, 0xfacc15, 0, 22, -8);
  jib.name = 'spin';
  g.add(jib);
  frontSign(g, 'MEGA MALL — СКОРО', 13.1, 2.6, 0, 9, 1.4, '#a21caf', '#ffffff');
  return g;
}
