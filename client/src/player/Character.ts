import * as THREE from 'three';
import type { CosmeticId } from '../../../shared/constants/config';
import { ANIM } from '../../../shared/types/state';

// Stylized low-poly humanoid with procedural animation for player avatars.
// Appearance (outfit color, hair, hat) is purely cosmetic.

const matCache = new Map<string, THREE.MeshStandardMaterial>();
function m(color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  const key = color + JSON.stringify(extra);
  let mm = matCache.get(key);
  if (!mm) { mm = new THREE.MeshStandardMaterial({ color, roughness: 0.75, flatShading: true, ...extra }); matCache.set(key, mm); }
  return mm;
}
function mesh(geo: THREE.BufferGeometry, color: number, x = 0, y = 0, z = 0, extra?: Partial<THREE.MeshStandardMaterialParameters>) {
  const o = new THREE.Mesh(geo, m(color, extra));
  o.position.set(x, y, z);
  o.castShadow = true;
  return o;
}

/** Canvas-backed sprite for name tags / emotes. */
export class LabelSprite {
  readonly sprite: THREE.Sprite;
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private tex: THREE.CanvasTexture;
  private last = '';
  constructor(w = 256, h = 96, scale = 3) {
    this.canvas.width = w; this.canvas.height = h;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, depthTest: false, transparent: true }));
    this.sprite.scale.set(scale, (scale * h) / w, 1);
    this.sprite.renderOrder = 10;
  }
  draw(lines: { text: string; color: string; size: number }[], bg = 'rgba(15,23,42,0.72)') {
    const key = JSON.stringify(lines) + bg;
    if (key === this.last) return;
    this.last = key;
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (bg) {
      // Shrink-wrap the pill to the widest line.
      let maxW = 0;
      for (const l of lines) { ctx.font = `800 ${l.size}px system-ui, sans-serif`; maxW = Math.max(maxW, ctx.measureText(l.text).width); }
      const w = Math.min(canvas.width - 8, maxW + 36);
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.roundRect((canvas.width - w) / 2, 4, w, canvas.height - 8, 22);
      ctx.fill();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const total = lines.reduce((a, l) => a + l.size * 1.15, 0);
    let y = canvas.height / 2 - total / 2;
    for (const l of lines) {
      ctx.font = `800 ${l.size}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
      ctx.fillStyle = l.color;
      y += (l.size * 1.15) / 2;
      ctx.fillText(l.text, canvas.width / 2, y);
      y += (l.size * 1.15) / 2;
    }
    this.tex.needsUpdate = true;
  }
}

const at = <T extends THREE.Object3D>(o: T, x: number, y: number, z: number) => { o.position.set(x, y, z); return o; };

export function hatMesh(id: CosmeticId, color: number): THREE.Object3D | null {
  const g = new THREE.Group();
  switch (id) {
    case 'cap': {
      g.add(new THREE.Mesh(new THREE.SphereGeometry(0.47, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), m(color)));
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.06, 12, 1, false, -Math.PI / 2, Math.PI), m(color));
      brim.position.set(0, 0.02, 0.32);
      g.add(brim);
      g.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 4), m(0xffffff)), 0, 0.46, 0));
      break;
    }
    case 'tophat':
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.06, 16), m(0x111827)));
      g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.7, 16), m(0x111827)), 0, 0.36, 0));
      g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.39, 0.39, 0.12, 16), m(0xdc2626)), 0, 0.1, 0));
      break;
    case 'crown': {
      const gold = m(0xfacc15, { metalness: 0.7, roughness: 0.3, emissive: 0x6b4f00 });
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.25, 12, 1, true), gold));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        g.add(at(new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.25, 4), gold), Math.cos(a) * 0.38, 0.24, Math.sin(a) * 0.38));
      }
      break;
    }
    case 'chef':
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.38, 0.4, 14), m(0xffffff)));
      g.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 10), m(0xffffff)), 0, 0.45, 0));
      break;
    case 'cowboy':
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.06, 18), m(0x92400e)));
      g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 0.45, 12), m(0x92400e)), 0, 0.22, 0));
      break;
    default:
      return null;
  }
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return g;
}

/** Outfit palette per player slot (clearly distinct silhouettes/colors). */
const OUTFITS = [
  { pants: 0x1e3a8a, shoes: 0xf8fafc, hair: 0x3b2314, hairStyle: 0 },
  { pants: 0x3f3f46, shoes: 0x111827, hair: 0xd97706, hairStyle: 1 },
  { pants: 0x14532d, shoes: 0xf8fafc, hair: 0x111827, hairStyle: 0 },
  { pants: 0x581c87, shoes: 0xfef3c7, hair: 0x7c2d12, hairStyle: 1 },
];

export class Character {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private hips = new THREE.Group();
  private chest = new THREE.Group();
  private head = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private foreL = new THREE.Group();
  private foreR = new THREE.Group();
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private shinL = new THREE.Group();
  private shinR = new THREE.Group();
  private hatSlot = new THREE.Group();
  private crate: THREE.Mesh;
  readonly tag = new LabelSprite(360, 112, 3.6);
  private emoteLabel = new LabelSprite(160, 128, 1.8);
  private emoteUntil = 0;
  private phase = 0;
  private animTime = 0;
  private lastAnim = -1;
  private blend = 0; // 0 idle … 1 full stride (smoothed)
  private poseTgt = new Float32Array(14);
  private poseCur = new Float32Array(14);
  anim: number = ANIM.idle;
  private ring: THREE.Mesh;

  constructor(public color: number, hat: CosmeticId, isLocal: boolean, slot = 0) {
    const o = OUTFITS[slot % OUTFITS.length];
    const skin = 0xf3c89b;
    const accent = new THREE.Color(color).offsetHSL(0, 0, -0.18).getHex();

    // Legs (hip pivot → thigh, knee pivot → shin + shoe)
    for (const [leg, shin, x] of [[this.legL, this.shinL, -0.2], [this.legR, this.shinR, 0.2]] as const) {
      leg.position.set(x, 0.95, 0);
      leg.add(mesh(new THREE.CylinderGeometry(0.15, 0.13, 0.5, 7).translate(0, -0.25, 0), o.pants));
      shin.position.y = -0.48;
      shin.add(mesh(new THREE.CylinderGeometry(0.13, 0.11, 0.44, 7).translate(0, -0.22, 0), o.pants));
      shin.add(mesh(new THREE.BoxGeometry(0.24, 0.14, 0.38).translate(0, -0.45, 0.06), o.shoes));
      leg.add(shin);
      this.hips.add(leg);
    }
    this.hips.add(mesh(new THREE.CylinderGeometry(0.32, 0.3, 0.26, 8), o.pants, 0, 1.0, 0));
    this.hips.add(mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.08, 8), 0x1f2937, 0, 1.12, 0)); // belt
    this.body.add(this.hips);

    // Chest (shirt in the player's color, darker trim, back badge)
    this.chest.position.y = 1.12;
    this.chest.add(mesh(new THREE.CylinderGeometry(0.38, 0.31, 0.68, 8).translate(0, 0.34, 0), color));
    this.chest.add(mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.1, 8), accent, 0, 0.66, 0)); // collar
    const badge = mesh(new THREE.CircleGeometry(0.17, 12), 0xffffff, 0, 0.42, -0.36);
    badge.rotation.y = Math.PI;
    this.chest.add(badge);
    const num = mesh(new THREE.CircleGeometry(0.11, 12), accent, 0, 0.42, -0.365);
    num.rotation.y = Math.PI;
    this.chest.add(num);
    // Arms: shoulder pivot → upper arm, elbow pivot → forearm + hand
    for (const [arm, fore, x] of [[this.armL, this.foreL, -0.47], [this.armR, this.foreR, 0.47]] as const) {
      arm.position.set(x, 0.6, 0);
      arm.add(mesh(new THREE.SphereGeometry(0.15, 8, 6), color));
      arm.add(mesh(new THREE.CylinderGeometry(0.12, 0.1, 0.4, 7).translate(0, -0.2, 0), color));
      fore.position.y = -0.38;
      fore.add(mesh(new THREE.CylinderGeometry(0.09, 0.08, 0.34, 7).translate(0, -0.17, 0), skin));
      fore.add(mesh(new THREE.SphereGeometry(0.11, 8, 6), skin, 0, -0.38, 0));
      arm.add(fore);
      this.chest.add(arm);
    }
    // Head: big chibi head with face and hair
    this.head.position.y = 0.72;
    this.head.add(mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.18, 7), skin, 0, 0.06, 0));
    const skull = mesh(new THREE.IcosahedronGeometry(0.44, 2), skin, 0, 0.5, 0);
    skull.scale.set(1, 0.95, 0.95);
    this.head.add(skull);
    for (const x of [-0.16, 0.16]) {
      this.head.add(mesh(new THREE.SphereGeometry(0.085, 8, 6), 0xffffff, x, 0.55, 0.37));
      this.head.add(mesh(new THREE.SphereGeometry(0.05, 8, 6), 0x111827, x, 0.55, 0.43));
      this.head.add(mesh(new THREE.BoxGeometry(0.15, 0.035, 0.03), o.hair, x, 0.68, 0.4));
      this.head.add(mesh(new THREE.SphereGeometry(0.06, 6, 4), 0xf9a8a8, x * 1.5, 0.42, 0.33)); // cheeks
    }
    this.head.add(mesh(new THREE.SphereGeometry(0.06, 6, 4), 0xeab38a, 0, 0.47, 0.43)); // nose
    const mouth = mesh(new THREE.TorusGeometry(0.09, 0.022, 4, 10, Math.PI), 0x7c2d12, 0, 0.36, 0.4);
    mouth.rotation.z = Math.PI;
    this.head.add(mouth);
    if (o.hairStyle === 0) {
      this.head.add(mesh(new THREE.SphereGeometry(0.47, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), o.hair, 0, 0.55, -0.03));
      const fringe = mesh(new THREE.BoxGeometry(0.7, 0.14, 0.2), o.hair, 0, 0.82, 0.25);
      fringe.rotation.x = 0.4;
      this.head.add(fringe);
    } else {
      this.head.add(mesh(new THREE.SphereGeometry(0.49, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), o.hair, 0, 0.53, -0.05));
      for (let i = 0; i < 5; i++) {
        const spike = mesh(new THREE.ConeGeometry(0.12, 0.3, 5), o.hair, -0.28 + i * 0.14, 0.93, 0.05);
        spike.rotation.x = -0.3;
        this.head.add(spike);
      }
      this.head.add(mesh(new THREE.SphereGeometry(0.2, 8, 6), o.hair, 0, 0.45, -0.38)); // ponytail
    }
    this.hatSlot.position.y = 0.86;
    this.head.add(this.hatSlot);
    this.chest.add(this.head);
    this.body.add(this.chest);
    this.setHat(hat);
    this.root.add(this.body);

    // Carry crate (shown during the carry animation)
    this.crate = mesh(new THREE.BoxGeometry(0.7, 0.55, 0.55), 0xd6a35c, 0, 1.55, 0.55);
    this.crate.visible = false;
    this.root.add(this.crate);

    // Colored ground ring identifies players at a glance.
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 1.0, 28), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: isLocal ? 0.95 : 0.65, depthWrite: false }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.06;
    this.root.add(this.ring);

    this.tag.sprite.position.y = 3.55;
    this.root.add(this.tag.sprite);
    this.emoteLabel.sprite.position.y = 4.8;
    this.emoteLabel.sprite.visible = false;
    this.root.add(this.emoteLabel.sprite);
  }

  setHat(id: CosmeticId) {
    this.hatSlot.clear();
    const h = hatMesh(id, this.color);
    if (h) this.hatSlot.add(h);
  }

  setTag(name: string, money: string, color: string) {
    this.tag.draw([{ text: name, color, size: 34 }, { text: money, color: '#fde047', size: 40 }]);
  }

  showEmote(e: string) {
    const gg = e === 'GG';
    this.emoteLabel.draw([{ text: gg ? 'GG!' : e, color: gg ? '#7c3aed' : '#111', size: gg ? 64 : 84 }], 'rgba(255,255,255,0.95)');
    this.emoteLabel.sprite.visible = true;
    this.emoteUntil = performance.now() + 2000;
  }

  /** speed = horizontal m/s; drives the walk ↔ run blend. */
  update(dt: number, speed: number) {
    const a = this.anim;
    if (a !== this.lastAnim) { this.lastAnim = a; this.animTime = 0; }
    this.animTime += dt;
    const t = this.animTime;
    const moving = a === ANIM.run || a === ANIM.walk || a === ANIM.carry;
    this.blend += ((moving ? Math.min(1, speed / 6.5) : 0) - this.blend) * Math.min(1, dt * 10);
    const s = this.blend;

    let thighL = 0, thighR = 0, kneeL = 0, kneeR = 0, shL = 0, shR = 0, elL = 0, elR = 0;
    let bob = 0, lean = 0, headX = 0, headY = 0, spin = 0, armOutL = 0.08, armOutR = -0.08;

    if (moving) {
      this.phase += dt * (4 + speed * 1.35);
      const p = this.phase;
      const stride = 0.35 + 0.55 * s;
      thighL = Math.sin(p) * stride;
      thighR = -Math.sin(p) * stride;
      kneeL = Math.max(0, -Math.cos(p)) * (0.4 + 0.7 * s);
      kneeR = Math.max(0, Math.cos(p)) * (0.4 + 0.7 * s);
      shL = -Math.sin(p) * (0.3 + 0.6 * s);
      shR = Math.sin(p) * (0.3 + 0.6 * s);
      elL = elR = -0.3 - 0.6 * s;
      bob = Math.abs(Math.sin(p)) * (0.04 + 0.1 * s);
      lean = 0.04 + 0.14 * s;
    }
    if (a === ANIM.carry) { shL = shR = -1.25; elL = elR = -0.35; armOutL = 0.25; armOutR = -0.25; lean = 0.02; }
    if (a === ANIM.idle) {
      const br = Math.sin(performance.now() / 600);
      bob = br * 0.015;
      shL = shR = 0.05 + br * 0.03;
      headY = Math.sin(performance.now() / 2300) * 0.15;
    } else if (a === ANIM.jump) {
      thighL = -0.9; kneeL = 1.3; thighR = 0.3; kneeR = 0.4; shL = shR = -2.5; elL = elR = -0.3;
    } else if (a === ANIM.interact) {
      shR = -1.4 + Math.sin(t * 16) * 0.3; elR = -0.4; shL = -0.5; elL = -0.7; lean = 0.1;
    } else if (a === ANIM.celebrate) {
      bob = Math.abs(Math.sin(t * 7)) * 0.25;
      shL = shR = -2.6; armOutL = 0.5 + Math.sin(t * 14) * 0.25; armOutR = -0.5 - Math.sin(t * 14) * 0.25;
    } else if (a === ANIM.victory) {
      bob = Math.abs(Math.sin(t * 5)) * 0.55;
      shL = -2.8; elL = -0.2; shR = -2.8 + Math.sin(t * 10) * 0.25; armOutL = 0.35; armOutR = -0.35;
      spin = t * 1.2;
      thighL = thighR = -Math.abs(Math.sin(t * 5)) * 0.3; kneeL = kneeR = Math.abs(Math.sin(t * 5)) * 0.6;
    } else if (a === ANIM.lose) {
      headX = 0.55; lean = 0.32; shL = shR = 0.25; elL = elR = -0.2; bob = -0.12; kneeL = kneeR = 0.35; thighL = thighR = -0.2;
    }

    // Smooth every joint toward its target: soft blend right after an animation
    // switch (no pose snapping), near-instant follow afterwards (crisp stride).
    const tgt = this.poseTgt;
    tgt[0] = thighL; tgt[1] = thighR; tgt[2] = kneeL; tgt[3] = kneeR; tgt[4] = shL; tgt[5] = shR; tgt[6] = armOutL; tgt[7] = armOutR;
    tgt[8] = elL; tgt[9] = elR; tgt[10] = bob; tgt[11] = lean; tgt[12] = headX; tgt[13] = headY;
    const k = Math.min(1, dt * (t < 0.3 ? 12 : 40));
    const c = this.poseCur;
    for (let i = 0; i < c.length; i++) c[i] += (tgt[i] - c[i]) * k;
    this.legL.rotation.x = c[0]; this.legR.rotation.x = c[1];
    this.shinL.rotation.x = c[2]; this.shinR.rotation.x = c[3];
    this.armL.rotation.set(c[4], 0, c[6]); this.armR.rotation.set(c[5], 0, c[7]);
    this.foreL.rotation.x = c[8]; this.foreR.rotation.x = c[9];
    this.body.position.y = c[10];
    this.chest.rotation.x = c[11];
    this.head.rotation.set(c[12], c[13], 0);
    this.body.rotation.y = a === ANIM.victory ? Math.sin(spin) * 0.6 : 0;
    this.crate.visible = a === ANIM.carry;

    if (this.emoteLabel.sprite.visible) {
      const left = this.emoteUntil - performance.now();
      if (left <= 0) this.emoteLabel.sprite.visible = false;
      else {
        const k = (2000 - left) / 2000;
        this.emoteLabel.sprite.position.y = 4.8 + k * 0.6;
        const pop = k < 0.12 ? 0.4 + (k / 0.12) * 0.6 : 1;
        this.emoteLabel.sprite.scale.set(1.8 * pop, 1.44 * pop, 1);
      }
    }
  }
}
