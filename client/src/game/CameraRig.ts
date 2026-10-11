import * as THREE from 'three';
import type { AABB } from '../world/World';

/**
 * Third-person camera: smooth follow, yaw/pitch with clamped vertical angle,
 * zoom, collision against building AABBs (never clips into houses), speed-based
 * dynamic FOV and a tiny shake for construction feedback.
 */
export class CameraRig {
  yaw = Math.PI / 2;
  pitch = 0.4;
  wantDist = 16;
  private dist = 16;
  private pivot = new THREE.Vector3();
  private shakeAmt = 0;
  private baseFov = 55;
  private fovBoost = 0;
  private override: { pos: THREE.Vector3; look: THREE.Vector3; t: number } | null = null;
  private tmpDir = new THREE.Vector3();
  private want = new THREE.Vector3();
  private look = new THREE.Vector3();
  /** Aim above the head so the hero sits in the lower third and the business fills the frame. */
  lookLift = 2.4;

  constructor(private camera: THREE.PerspectiveCamera) {}

  static readonly MIN_PITCH = 0.12;
  static readonly MAX_PITCH = 1.2;

  /** Distance multiplier from the aspect preset (user zoom stays in wantDist). */
  private distMul = 1;

  /**
   * Camera preset from the viewport aspect — distance, FOV and aim height together, not just a wider FOV:
   *  - portrait (≈0.46): further back, aim higher → hero in the lower part of the frame, more world ahead/above;
   *  - desktop 16:9: the classic framing;
   *  - wide landscape phone (≈2.2): a little closer and tighter → cinematic, hero + business + street.
   */
  setViewport(w: number, h: number) {
    const a = w / Math.max(1, h);
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    this.baseFov = clamp(64 - 6 * a, 50, 60);
    this.distMul = clamp(1.45 - 0.25 * a, 0.9, 1.3);
    this.lookLift = clamp(4.3 - a, 2.2, 3.9);
  }

  rotate(dx: number, dy: number, zoom: number) {
    this.yaw -= dx * 0.005;
    this.pitch = Math.max(CameraRig.MIN_PITCH, Math.min(CameraRig.MAX_PITCH, this.pitch + dy * 0.004));
    this.wantDist = Math.max(7, Math.min(34, this.wantDist + zoom * 1.3));
  }

  shake(amount: number) { this.shakeAmt = Math.min(0.6, this.shakeAmt + amount); }

  /** Cinematic override (e.g. end-of-match fly-over). null = back to follow. */
  setOverride(pos: THREE.Vector3 | null, look?: THREE.Vector3) {
    this.override = pos ? { pos: pos.clone(), look: (look ?? new THREE.Vector3()).clone(), t: 0 } : null;
  }

  snap(target: THREE.Vector3) {
    this.pivot.copy(target).add(new THREE.Vector3(0, 1.8, 0));
    this.dist = this.wantDist * this.distMul;
    this.update(1, target, 0, []);
  }

  update(dt: number, target: THREE.Vector3, speed: number, colliders: AABB[]) {
    const cam = this.camera;
    if (this.override) {
      const o = this.override;
      o.t += dt;
      cam.position.lerp(o.pos, 1 - Math.exp(-dt * 2.2));
      cam.lookAt(o.look);
      this.applyFov(dt, 0);
      return;
    }
    // Smooth follow of the pivot (head height)
    const goal = this.want.copy(target).add(new THREE.Vector3(0, 1.8, 0));
    this.pivot.lerp(goal, 1 - Math.exp(-dt * 14));
    const dir = this.tmpDir.set(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    // Collision: shorten the arm to the first hit (+ margin)
    const want = this.wantDist * this.distMul;
    let allowed = want;
    for (const b of colliders) {
      const t = rayAabb(this.pivot, dir, b, want);
      if (t !== null && t < allowed) allowed = Math.max(2.2, t - 0.7);
    }
    // Pull in fast (avoid clipping), ease out slowly.
    const k = allowed < this.dist ? 1 - Math.exp(-dt * 22) : 1 - Math.exp(-dt * 3.5);
    this.dist += (allowed - this.dist) * k;
    cam.position.copy(this.pivot).addScaledVector(dir, this.dist);
    if (cam.position.y < 0.6) cam.position.y = 0.6;
    if (this.shakeAmt > 0.001) {
      const s = this.shakeAmt;
      cam.position.x += (Math.random() - 0.5) * s;
      cam.position.y += (Math.random() - 0.5) * s;
      this.shakeAmt *= Math.exp(-dt * 9);
    }
    // Lift the aim less when looking steeply down (otherwise the hero leaves the frame).
    const lift = this.lookLift * (1 - Math.min(1, this.pitch / CameraRig.MAX_PITCH) * 0.8);
    cam.lookAt(this.look.copy(this.pivot).setY(this.pivot.y + lift));
    this.applyFov(dt, speed);
  }

  private applyFov(dt: number, speed: number) {
    this.fovBoost += (Math.min(1, speed / 7) * 5 - this.fovBoost) * Math.min(1, dt * 4);
    const fov = this.baseFov + this.fovBoost;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}

/** Slab test; returns distance along normalized dir or null. */
export function rayAabb(o: THREE.Vector3, d: THREE.Vector3, b: AABB, maxT: number): number | null {
  let tmin = 0, tmax = maxT;
  const axes: [number, number, number, number][] = [[o.x, d.x, b.minX, b.maxX], [o.y, d.y, b.minY, b.maxY], [o.z, d.z, b.minZ, b.maxZ]];
  for (const [p, v, lo, hi] of axes) {
    if (Math.abs(v) < 1e-6) { if (p < lo || p > hi) return null; continue; }
    let t1 = (lo - p) / v, t2 = (hi - p) / v;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin > 0 ? tmin : null;
}
