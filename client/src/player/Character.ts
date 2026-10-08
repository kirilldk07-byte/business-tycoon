import * as THREE from 'three';
import type { CosmeticId } from '../../../shared/constants/config';
import { ANIM } from '../../../shared/types/state';
import { box, mat } from '../world/World';

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
      ctx.fillStyle = bg;
      roundRect(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 22);
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

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const at = <T extends THREE.Object3D>(o: T, x: number, y: number, z: number) => { o.position.set(x, y, z); return o; };

export function hatMesh(id: CosmeticId, color: number): THREE.Object3D | null {
  const g = new THREE.Group();
  switch (id) {
    case 'cap': {
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.46, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(color));
      g.add(dome);
      const brim = box(0.5, 0.06, 0.45, color, 0, 0, 0.42);
      g.add(brim);
      break;
    }
    case 'tophat':
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.06, 16), mat(0x111827)));
      g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.7, 16), mat(0x111827)), 0, 0.36, 0));
      g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.39, 0.39, 0.12, 16), mat(0xdc2626)), 0, 0.1, 0));
      break;
    case 'crown': {
      const gold = mat(0xfacc15, { metalness: 0.7, roughness: 0.3, emissive: 0x6b4f00 });
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.25, 12, 1, true), gold));
      for (let i = 0; i < 6; i++) {
        const sp = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.25, 4), gold);
        const a = (i / 6) * Math.PI * 2;
        sp.position.set(Math.cos(a) * 0.38, 0.24, Math.sin(a) * 0.38);
        g.add(sp);
      }
      break;
    }
    case 'chef':
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.38, 0.4, 14), mat(0xffffff)));
      g.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 10), mat(0xffffff)), 0, 0.45, 0));
      break;
    case 'cowboy':
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.06, 18), mat(0x92400e)));
      g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 0.45, 12), mat(0x92400e)), 0, 0.22, 0));
      break;
    default:
      return null;
  }
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return g;
}

/**
 * Low-poly player character with procedural animation.
 * Appearance (color/hat) is cosmetic only — no gameplay effect.
 */
export class Character {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private head!: THREE.Group;
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private hatSlot = new THREE.Group();
  readonly tag = new LabelSprite(320, 112, 3.4);
  private emoteLabel = new LabelSprite(128, 128, 1.6);
  private emoteUntil = 0;
  private phase = 0;
  private animTime = 0;
  private lastAnim = -1;
  anim: number = ANIM.idle;
  private ring: THREE.Mesh;

  constructor(public color: number, hat: CosmeticId, isLocal: boolean) {
    const skin = 0xf3c89b;
    const pants = 0x1f2937;
    const shirt = mat(color);
    // Legs
    for (const [leg, x] of [[this.legL, -0.22], [this.legR, 0.22]] as const) {
      leg.position.set(x, 0.9, 0);
      leg.add(box(0.3, 0.85, 0.34, pants, 0, -0.85));
      leg.add(box(0.34, 0.14, 0.48, 0x111827, 0, -0.9, 0.06));
      this.body.add(leg);
    }
    // Torso
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.6, 4, 10), shirt);
    torso.position.y = 1.4;
    torso.castShadow = true;
    this.body.add(torso);
    // Belt stripe for extra player distinction
    this.body.add(box(0.86, 0.12, 0.86, 0xffffff, 0, 1.0));
    // Arms
    for (const [arm, x] of [[this.armL, -0.58], [this.armR, 0.58]] as const) {
      arm.position.set(x, 1.75, 0);
      const a = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.55, 3, 8), shirt);
      a.position.y = -0.38;
      a.castShadow = true;
      arm.add(a);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), mat(skin));
      hand.position.y = -0.78;
      arm.add(hand);
      this.body.add(arm);
    }
    // Head
    this.head = new THREE.Group();
    this.head.position.y = 2.35;
    const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 12), mat(skin));
    headMesh.castShadow = true;
    this.head.add(headMesh);
    for (const x of [-0.16, 0.16]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), mat(0x111827));
      eye.position.set(x, 0.05, 0.4);
      this.head.add(eye);
    }
    const mouth = box(0.18, 0.04, 0.04, 0x7c2d12, 0, -0.17, 0.41);
    this.head.add(mouth);
    this.hatSlot.position.y = 0.32;
    this.head.add(this.hatSlot);
    this.body.add(this.head);
    this.setHat(hat);
    this.root.add(this.body);

    // Colored ground ring identifies players at a glance.
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.95, 24), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: isLocal ? 0.9 : 0.6 }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.05;
    this.root.add(this.ring);

    this.tag.sprite.position.y = 3.6;
    this.root.add(this.tag.sprite);
    this.emoteLabel.sprite.position.y = 4.9;
    this.emoteLabel.sprite.visible = false;
    this.root.add(this.emoteLabel.sprite);
  }

  setHat(id: CosmeticId) {
    this.hatSlot.clear();
    const h = hatMesh(id, this.color);
    if (h) this.hatSlot.add(h);
  }

  setTag(name: string, money: string, color: string) {
    this.tag.draw([{ text: name, color, size: 36 }, { text: money, color: '#fde047', size: 40 }]);
  }

  showEmote(e: string) {
    this.emoteLabel.draw([{ text: e, color: '#fff', size: 92 }], 'rgba(255,255,255,0.9)');
    this.emoteLabel.sprite.visible = true;
    this.emoteUntil = performance.now() + 2500;
  }

  /** speed in m/s (horizontal), grounded flag only affects jump pose. */
  update(dt: number, speed: number) {
    const a = this.anim;
    if (a !== this.lastAnim) { this.lastAnim = a; this.animTime = 0; }
    this.animTime += dt;
    const t = this.animTime;
    let legSwing = 0, armSwing = 0, armRaiseL = 0, armRaiseR = 0, bob = 0, headTilt = 0, lean = 0;

    if (a === ANIM.run) {
      this.phase += dt * Math.max(6, speed * 1.6);
      legSwing = Math.sin(this.phase) * 0.9;
      armSwing = Math.sin(this.phase) * 0.8;
      bob = Math.abs(Math.sin(this.phase)) * 0.12;
      lean = 0.12;
    } else if (a === ANIM.jump) {
      legSwing = 0.5; armRaiseL = armRaiseR = -2.4;
    } else if (a === ANIM.interact) {
      armRaiseR = -1.3 + Math.sin(t * 18) * 0.35;
      armRaiseL = -0.4;
      lean = 0.08;
    } else if (a === ANIM.victory) {
      bob = Math.abs(Math.sin(t * 6)) * 0.6;
      armRaiseL = armRaiseR = -2.7 + Math.sin(t * 12) * 0.2;
    } else if (a === ANIM.lose) {
      headTilt = 0.5; lean = 0.25; armRaiseL = armRaiseR = 0.15;
      bob = -0.1;
    } else {
      bob = Math.sin(performance.now() / 500) * 0.03;
    }
    this.legL.rotation.x = legSwing;
    this.legR.rotation.x = a === ANIM.jump ? -0.6 : -legSwing;
    this.armL.rotation.x = armRaiseL || -armSwing;
    this.armR.rotation.x = armRaiseR || armSwing;
    this.armL.rotation.z = a === ANIM.victory ? 0.3 : 0.05;
    this.armR.rotation.z = a === ANIM.victory ? -0.3 : -0.05;
    this.body.position.y = bob;
    this.body.rotation.x = lean;
    this.head.rotation.x = headTilt;

    if (this.emoteLabel.sprite.visible) {
      const left = this.emoteUntil - performance.now();
      if (left <= 0) this.emoteLabel.sprite.visible = false;
      else this.emoteLabel.sprite.position.y = 4.9 + (2500 - left) / 2500 * 0.8;
    }
  }
}
