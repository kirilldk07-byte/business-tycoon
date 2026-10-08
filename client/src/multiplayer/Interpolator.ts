// Snapshot buffer for remote entities. Renders the past (serverNow - delay)
// by lerping between the two snapshots around that time, so other players
// move smoothly even though updates arrive at ~15 Hz with jitter.

export interface Sample { t: number; x: number; y: number; z: number; rot: number; anim: number }

const lerpAngle = (a: number, b: number, k: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
};

export class Interpolator {
  private buf: Sample[] = [];

  push(s: Sample) {
    const last = this.buf[this.buf.length - 1];
    if (last && s.t <= last.t) return; // out of order
    this.buf.push(s);
    if (this.buf.length > 40) this.buf.shift();
  }

  /** Hard reset (e.g. respawn/rematch) to avoid sliding across the map. */
  reset(s: Sample) { this.buf = [s]; }

  sample(renderTime: number): Sample | null {
    const b = this.buf;
    if (b.length === 0) return null;
    if (renderTime <= b[0].t) return b[0];
    for (let i = b.length - 1; i >= 1; i--) {
      if (b[i - 1].t <= renderTime) {
        const a = b[i - 1], c = b[i];
        if (renderTime > c.t) {
          // Ran out of data: extrapolate briefly, then hold.
          const over = Math.min(renderTime - c.t, 200);
          const dt = c.t - a.t || 1;
          const k = over / dt;
          return { ...c, x: c.x + (c.x - a.x) * k, z: c.z + (c.z - a.z) * k, t: renderTime };
        }
        const k = (renderTime - a.t) / (c.t - a.t || 1);
        // Teleport-sized gaps snap instead of sliding.
        if (Math.hypot(c.x - a.x, c.z - a.z) > 8) return c;
        return {
          t: renderTime,
          x: a.x + (c.x - a.x) * k,
          y: a.y + (c.y - a.y) * k,
          z: a.z + (c.z - a.z) * k,
          rot: lerpAngle(a.rot, c.rot, k),
          anim: k < 0.5 ? a.anim : c.anim,
        };
      }
    }
    return b[b.length - 1];
  }
}
