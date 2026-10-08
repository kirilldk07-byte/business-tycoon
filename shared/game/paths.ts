import { ECONOMY } from '../constants/config';
import { PLOT_LOCAL } from '../constants/world';

// Customer routes in plot-local coordinates. Shared so the server can time
// arrivals and clients animate NPCs that reach the door at the same moment.

export type P2 = { lx: number; lz: number };
/** dest = -1 → flagship counter queue; 0..5 → venue slot. */
export function customerPath(dest: number, side: number): P2[] {
  const s = PLOT_LOCAL.customerSpawn[side % PLOT_LOCAL.customerSpawn.length];
  const sg = Math.sign(s.lz) || 1;
  const lane = sg * 2.6;
  const pts: P2[] = [s, { lx: s.lx, lz: lane }, { lx: 23, lz: lane }];
  if (dest < 0) {
    pts.push({ lx: 12, lz: lane * 0.5 }, { lx: 11, lz: 0 });
  } else {
    const v = PLOT_LOCAL.venues[dest];
    const vs = Math.sign(v.lz);
    // cross to the venue's side of the aisle, then walk to the door
    pts.push({ lx: v.lx, lz: vs * 2.6 }, { lx: v.lx, lz: vs * (Math.abs(v.lz) - 5.2) });
  }
  return pts;
}

export function pathLength(pts: P2[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].lx - pts[i - 1].lx, pts[i].lz - pts[i - 1].lz);
  return d;
}

/** Walk duration used by the server to schedule arrival (ms). */
export function walkMs(dest: number, side: number): number {
  return Math.round((pathLength(customerPath(dest, side)) / ECONOMY.customerSpeed) * 1000);
}

/** Venue customers enter on the venue's own side of the street. */
export function sideForVenue(dest: number): number {
  return PLOT_LOCAL.venues[dest].lz > 0 ? 0 : 1;
}
