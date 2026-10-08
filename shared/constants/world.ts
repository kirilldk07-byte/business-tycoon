import type { StructureId } from './config';

// World layout shared by server (distance validation) and client (rendering).
// Plots are an array so a 4-player map only needs more entries here.

export interface PlotDef { x: number; z: number; dir: 1 | -1 }

export const PLOTS: PlotDef[] = [
  { x: -30, z: 0, dir: 1 }, // left plot, front faces +X (plaza)
  { x: 30, z: 0, dir: -1 }, // right plot, front faces -X
];

export const WORLD_BOUNDS = { minX: -62, maxX: 62, minZ: -40, maxZ: 40 };

/** Local plot coords: lx points toward plaza, lz sideways. */
export function plotToWorld(plot: number, lx: number, lz: number): { x: number; z: number } {
  const p = PLOTS[plot];
  return { x: p.x + p.dir * lx, z: p.z + lz * p.dir };
}

export const PLOT_LOCAL = {
  building: { lx: -6, lz: 0 },
  counter: { lx: 4, lz: 0 },
  machine: { lx: -1, lz: -11 },
  spawn: [{ lx: 9, lz: 4 }, { lx: 9, lz: -4 }, { lx: 11, lz: 6 }, { lx: 11, lz: -6 }],
  customerSpawn: [{ lx: 17, lz: 15 }, { lx: 17, lz: -15 }],
  structures: {
    billboard: { lx: 12, lz: -13 },
    parking: { lx: -10, lz: 12 },
    warehouse: { lx: -11, lz: -12 },
    terrace: { lx: 9, lz: 9 },
    fountain: { lx: 14, lz: 13 },
    branch: { lx: 1, lz: 12 },
  } as Record<StructureId, { lx: number; lz: number }>,
  crates: [
    { lx: 7, lz: -5 }, { lx: 9, lz: -7 }, { lx: 6, lz: -8 },
    { lx: 11, lz: -4 }, { lx: 13, lz: -8 }, { lx: 8, lz: -10 },
  ],
};

// Power-failure switches live far apart so they need two players.
export const POWER_SWITCHES = [
  { id: 0, x: -45, z: -15 },
  { id: 1, x: 0, z: 18 },
];

export const MEGA_MALL_PLOT = 1;
