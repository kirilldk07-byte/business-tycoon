import * as THREE from 'three';

// Particles (instanced, pooled) + DOM floating texts projected from 3D.

interface Particle { pos: THREE.Vector3; vel: THREE.Vector3; life: number; max: number; color: THREE.Color; size: number; spin: number; rot: number; gravity: number }

const MAX = 600;

export class Effects {
  private mesh: THREE.InstancedMesh;
  private parts: Particle[] = [];
  private dummy = new THREE.Object3D();
  private floatLayer: HTMLElement;
  private floats: { el: HTMLElement; pos: THREE.Vector3; born: number; dur: number }[] = [];
  private tmp = new THREE.Vector3();

  constructor(scene: THREE.Scene, private camera: THREE.Camera, layer: HTMLElement) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.floatLayer = layer;
  }

  burst(at: THREE.Vector3, kind: 'coins' | 'dust' | 'confetti' | 'sparkle' | 'smoke', n = 12) {
    for (let i = 0; i < n && this.parts.length < MAX; i++) {
      const p: Particle = {
        pos: at.clone(), vel: new THREE.Vector3(), life: 0, max: 1, color: new THREE.Color(0xffffff), size: 0.2, spin: (Math.random() - 0.5) * 10, rot: 0, gravity: 9,
      };
      switch (kind) {
        case 'coins':
          p.vel.set((Math.random() - 0.5) * 3, 4 + Math.random() * 3, (Math.random() - 0.5) * 3);
          p.color.setHex(Math.random() < 0.7 ? 0xfacc15 : 0x22c55e); p.size = 0.22; p.max = 0.9;
          break;
        case 'dust':
          p.pos.add(new THREE.Vector3((Math.random() - 0.5) * 6, Math.random() * 0.5, (Math.random() - 0.5) * 6));
          p.vel.set((Math.random() - 0.5) * 2, 1 + Math.random() * 2, (Math.random() - 0.5) * 2);
          p.color.setHex(0xd6c4a8); p.size = 0.5 + Math.random() * 0.5; p.max = 1.4; p.gravity = -0.5;
          break;
        case 'confetti':
          p.pos.add(new THREE.Vector3((Math.random() - 0.5) * 4, 0, (Math.random() - 0.5) * 4));
          p.vel.set((Math.random() - 0.5) * 8, 8 + Math.random() * 6, (Math.random() - 0.5) * 8);
          p.color.setHSL(Math.random(), 0.9, 0.6); p.size = 0.25; p.max = 3; p.gravity = 6;
          break;
        case 'sparkle':
          p.vel.set((Math.random() - 0.5) * 5, 2 + Math.random() * 5, (Math.random() - 0.5) * 5);
          p.color.setHSL(0.13 + Math.random() * 0.05, 1, 0.65); p.size = 0.18; p.max = 1.2; p.gravity = 2;
          break;
        case 'smoke':
          p.vel.set((Math.random() - 0.5) * 0.6, 1.2, (Math.random() - 0.5) * 0.6);
          p.color.setHex(0x9ca3af); p.size = 0.6; p.max = 1.8; p.gravity = -0.3;
          break;
      }
      this.parts.push(p);
    }
  }

  floatText(at: THREE.Vector3, text: string, cls = 'money') {
    if (this.floats.length > 40) { this.floats.shift()!.el.remove(); }
    const el = document.createElement('div');
    el.className = `float-text ${cls}`;
    el.textContent = text;
    this.floatLayer.appendChild(el);
    this.floats.push({ el, pos: at.clone(), born: performance.now(), dur: cls === 'big' ? 2200 : 1300 });
  }

  update(dt: number) {
    let n = 0;
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life += dt;
      if (p.life >= p.max) { this.parts.splice(i, 1); continue; }
      p.vel.y -= p.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
      if (p.pos.y < 0.05) { p.pos.y = 0.05; p.vel.multiplyScalar(0.5); p.vel.y *= -0.3; }
      p.rot += p.spin * dt;
      const k = 1 - p.life / p.max;
      this.dummy.position.copy(p.pos);
      this.dummy.rotation.set(p.rot, p.rot * 0.7, 0);
      this.dummy.scale.setScalar(p.size * (0.4 + 0.6 * k));
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(n, this.dummy.matrix);
      this.mesh.setColorAt(n, p.color);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    const now = performance.now();
    const w = window.innerWidth, h = window.innerHeight;
    for (let i = this.floats.length - 1; i >= 0; i--) {
      const f = this.floats[i];
      const t = (now - f.born) / f.dur;
      if (t >= 1) { f.el.remove(); this.floats.splice(i, 1); continue; }
      this.tmp.copy(f.pos);
      this.tmp.y += t * 2.2;
      this.tmp.project(this.camera);
      if (this.tmp.z > 1) { f.el.style.opacity = '0'; continue; }
      f.el.style.transform = `translate(${(this.tmp.x * 0.5 + 0.5) * w}px, ${(-this.tmp.y * 0.5 + 0.5) * h}px) translate(-50%, -50%) scale(${t < 0.15 ? 0.6 + t * 2.6 : 1})`;
      f.el.style.opacity = String(t > 0.7 ? (1 - t) / 0.3 : 1);
    }
  }

  clear() {
    this.parts = [];
    for (const f of this.floats) f.el.remove();
    this.floats = [];
  }
}
