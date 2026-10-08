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
        if (t.clientX < window.innerWidth * 0.42 && this.joyId === null) {
          this.joyId = t.identifier;
          this.joyCenter = { x: t.clientX, y: t.clientY };
          this.joyBase.style.left = `${t.clientX}px`;
          this.joyBase.style.top = `${t.clientY}px`;
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
          this.camDX += (t.clientX - this.camLast.x) * 1.3;
          this.camDY += (t.clientY - this.camLast.y) * 1.3;
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
          this.joyBase.style.left = '';
          this.joyBase.style.top = '';
        }
        if (t.identifier === this.camTouchId) this.camTouchId = null;
      }
      if (e.touches.length < 2) this.pinchDist = 0;
    };
    this.canvas.addEventListener('touchend', end);
    this.canvas.addEventListener('touchcancel', end);
  }

  private updateJoy(x: number, y: number) {
    const max = 55;
    let dx = x - this.joyCenter.x, dy = y - this.joyCenter.y;
    const d = Math.hypot(dx, dy);
    if (d > max) { dx = (dx / d) * max; dy = (dy / d) * max; }
    this.joyKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    this.moveX = dx / max;
    this.moveY = -dy / max;
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
