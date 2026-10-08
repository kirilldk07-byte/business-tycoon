import type { StructureId } from './config';


// World layout shared by server (distance validation) and client (rendering).
// Plots are an array so a 4-player map only needs more entries here.
//
//   z
//   ^      city blocks / billboards                 city blocks
//   |  ════ cross road z=+31 ═══════════════════════════════════
//   |  ┌──────── PLOT 1 ────────┐║ park ║┌──────── PLOT 2 ────────┐
//   |  │ HQ   venues   entrance ═╬ plaza╬═ entrance  venues   HQ │
//   |  └────────────────────────┘║      ║└────────────────────────┘
//   |  ════ cross road z=-31 ═══════════════════════════════════
//   +--------------------------------------------------------------> x
//        avenues (with sidewalks) at x = ±16 run between plots and park

export interface PlotDef { x: number; z: number; dir: 1 | -1 }

/** Plot half-extents in local coords (lx toward the park, lz sideways). */
export const PLOT_HALF = { x: 26, z: 24 };

export const PLOTS: PlotDef[] = [
  { x: -48, z: 0, dir: 1 }, // left plot, front faces +X (park)
  { x: 48, z: 0, dir: -1 }, // right plot, front faces -X
];

export const ROADS = {
  avenueX: 16, // centerline of the two N-S avenues (x = ±16)
  crossZ: 31, // centerline of the two E-W roads (z = ±31)
  width: 7,
  sidewalk: 2.2,
};

export const WORLD_BOUNDS = { minX: -74, maxX: 74, minZ: -38, maxZ: 38 };

/** Local plot coords: lx points toward the park, lz sideways. (dir=-1 is a 180° rotation.) */
export function plotToWorld(plot: number, lx: number, lz: number): { x: number; z: number } {
  const p = PLOTS[plot];
  return { x: p.x + p.dir * lx, z: p.z + lz * p.dir };
}

export const PLOT_LOCAL = {
  /** Flagship / HQ (tier chain kiosk → empire). */
  building: { lx: -16, lz: 0 },
  counter: { lx: -5, lz: 0 },
  machine: { lx: -5, lz: -8.5 },
  entrance: { lx: 26, lz: 0 },
  spawn: [{ lx: 9, lz: 2.5 }, { lx: 9, lz: -2.5 }, { lx: 9.5, lz: 7.5 }, { lx: 9.5, lz: -7.5 }],
  /** Customers appear on the avenue sidewalk at the plot front and walk in. */
  customerSpawn: [{ lx: 27.4, lz: 22 }, { lx: 27.4, lz: -22 }],
  /** Secondary businesses (data-driven list in config VENUES), door faces the central aisle. */
  venues: [
    { lx: 21, lz: -16 },
    { lx: 21, lz: 16 },
    { lx: 7, lz: -16 },
    { lx: 7, lz: 16 },
    { lx: -8, lz: -17 },
    { lx: -8, lz: 17 },
  ],
  structures: {
    billboard: { lx: 24.5, lz: -22.6 },
    parking: { lx: -22, lz: 17.5 },
    warehouse: { lx: -22, lz: -17 },
    terrace: { lx: 6.5, lz: -6.8 },
    fountain: { lx: 0.5, lz: -14.8 },
  } as Record<StructureId, { lx: number; lz: number }>,
  /** Physical purchase pads. */
  pads: {
    hq: { lx: -3.5, lz: 6.5 },
    upgrades: { lx: 12, lz: 5 },
    workers: {
      cashier: { lx: -1, lz: 3.4 },
      worker: { lx: -1.2, lz: -10.6 },
      manager: { lx: -11, lz: 9.8 },
      delivery: { lx: 21.5, lz: -3.6 },
      marketer: { lx: 21.5, lz: 3.6 },
    },
  },
  staff: {
    cashier: { lx: -6.6, lz: 0 },
    worker: { lx: -7.4, lz: -9.6 },
    manager: { lx: -11.5, lz: 8 },
    delivery: { lx: 24, lz: -6.5 },
    marketer: { lx: 24.2, lz: 6.5 },
  },
  crates: [
    { lx: 14, lz: -4.5 }, { lx: 16.5, lz: -6.5 }, { lx: 13.5, lz: -8.2 },
    { lx: 18, lz: -4.2 }, { lx: 18.6, lz: -8.4 }, { lx: 15.6, lz: -9.6 },
  ],
};

// Power-failure generators live far apart so they need two players.
export const POWER_SWITCHES = [
  { id: 0, x: -48, z: -36.6 },
  { id: 1, x: 0, z: 20 },
];

export const MEGA_MALL_PLOT = 1;
