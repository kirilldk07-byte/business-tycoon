import { isTouch } from '../config/client';

/**
 * Unified input: keyboard + mouse on desktop, virtual joystick + buttons +
 * touch-drag camera on mobile. Both produce the same abstract intents, so
 * PC and phone play the exact same game.
 */
export class Input {
  moveX = 0; // -1..1 (strafe)
  moveY = 0; // -1..1 (forward)
  camDX = 0; // accumulated camera drag (pixels)
  camDY = 0;
  zoom = 0;
  private keys = new Set<string>();
  private jumpQueued = false;
  private interactQueued = false;
  enabled = false;
  onKey: (code: string) => void = () => {};

  private joyId: number | null = null;
  private joyCenter = { x: 0, y: 0 };
  private joyMax = 42;
  private camTouchId: number | null = null;
  private camLast = { x: 0, y: 0 };
  private pinchDist = 0;
  private mouseDown = false;

  constructor(private canvas: HTMLCanvasElement, private joyBase: HTMLElement, private joyKnob: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keys.add(e.code);
      if (!this.enabled) return;
      if (e.code === 'Space') { this.jumpQueued = true; e.preventDefault(); }
      if (e.code === 'KeyE') this.interactQueued = true;
      this.onKey(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    canvas.addEventListener('mousedown', () => { this.mouseDown = true; });
    window.addEventListener('mouseup', () => { this.mouseDown = false; });
    window.addEventListener('mousemove', (e) => {
      if (this.mouseDown && this.enabled) { this.camDX += e.movementX; this.camDY += e.movementY; }
    });
    canvas.addEventListener('wheel', (e) => { this.zoom += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    if (isTouch) this.bindTouch();
  }

  private bindTouch() {
    const opts = { passive: false } as AddEventListenerOptions;
    this.canvas.addEventListener('touchstart', (e) => {
      for (const t of Array.from(e.changedTouches)) {
        // Floating joystick: only the lower-left zone (never the centre, never the HUD at the top).
        const W = window.innerWidth, H = window.innerHeight;
        const inZone = t.clientX < W * (W < H ? 0.5 : 0.42) && t.clientY > H * (W < H ? 0.45 : 0.32);
        if (inZone && this.joyId === null) {
          const home = this.joyBase.getBoundingClientRect();
          const size = home.width || 100;
          this.joyMax = size * 0.42;
          const m = size / 2 + 4;
          const cx = Math.min(Math.max(t.clientX, m), W * 0.5), cy = Math.min(Math.max(t.clientY, m), H - m);
          this.joyId = t.identifier;
          this.joyCenter = { x: cx, y: cy };
          this.joyBase.style.transform = `translate(${cx - (home.left + size / 2)}px, ${cy - (home.top + size / 2)}px)`;
          this.joyBase.classList.add('active');
          this.updateJoy(t.clientX, t.clientY);
        } else if (this.camTouchId === null) {
          this.camTouchId = t.identifier;
          this.camLast = { x: t.clientX, y: t.clientY };
        }
      }
      if (e.touches.length === 2 && this.joyId === null) {
        this.pinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      }
      e.preventDefault();
    }, opts);
    this.canvas.addEventListener('touchmove', (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.joyId) this.updateJoy(t.clientX, t.clientY);
        else if (t.identifier === this.camTouchId) {
          // clamp per-event spikes (dropped frames) — no camera jerks
          this.camDX += Math.max(-80, Math.min(80, t.clientX - this.camLast.x)) * 1.3;
          this.camDY += Math.max(-80, Math.min(80, t.clientY - this.camLast.y)) * 1.3;
          this.camLast = { x: t.clientX, y: t.clientY };
        }
      }
      if (e.touches.length === 2 && this.joyId === null) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        if (this.pinchDist) this.zoom += (this.pinchDist - d) / 40;
        this.pinchDist = d;
      }
      e.preventDefault();
    }, opts);
    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.joyId) {
          this.joyId = null;
          this.moveX = this.moveY = 0;
          this.joyKnob.style.transform = 'translate(-50%, -50%)';
          this.joyBase.classList.remove('active');
          this.joyBase.style.transform = '';
        }
        if (t.identifier === this.camTouchId) this.camTouchId = null;
      }
      if (e.touches.length < 2) this.pinchDist = 0;
    };
    this.canvas.addEventListener('touchend', end);
    this.canvas.addEventListener('touchcancel', end);
  }

  private updateJoy(x: number, y: number) {
    const max = this.joyMax;
    let dx = x - this.joyCenter.x, dy = y - this.joyCenter.y;
    const d = Math.hypot(dx, dy);
    if (d > max) { dx = (dx / d) * max; dy = (dy / d) * max; }
    this.joyKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    // small dead zone so a resting thumb doesn't drift the hero
    const m = Math.hypot(dx, dy) / max, k = m < 0.12 ? 0 : (m - 0.12) / 0.88 / (m || 1);
    this.moveX = (dx / max) * k;
    this.moveY = (-dy / max) * k;
  }

  /** Combined movement vector (keyboard overrides when used). */
  axes(): { x: number; y: number } {
    let x = 0, y = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (x || y) { const l = Math.hypot(x, y); return { x: x / l, y: y / l }; }
    return { x: this.moveX, y: this.moveY };
  }

  pressJump() { if (this.enabled) this.jumpQueued = true; }
  pressInteract() { if (this.enabled) this.interactQueued = true; }
  consumeJump() { const j = this.jumpQueued; this.jumpQueued = false; return j; }
  consumeInteract() { const j = this.interactQueued; this.interactQueued = false; return j; }
  consumeCamera() { const r = { dx: this.camDX, dy: this.camDY, zoom: this.zoom }; this.camDX = this.camDY = this.zoom = 0; return r; }

  reset() {
    this.keys.clear();
    this.moveX = this.moveY = 0;
    this.jumpQueued = this.interactQueued = false;
  }
}
