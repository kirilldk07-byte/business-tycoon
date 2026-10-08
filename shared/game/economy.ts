// Pure economy formulas. The server uses these authoritatively; the client
// only uses them to display prices/rates. Never mutate state here.

import {
  COOP_GOAL, ECONOMY, STRUCTURES, TIERS, UPGRADES, VALUE_WEIGHTS, WORKERS,
  type StructureId, type UpgradeId, type WorkerId, UPGRADE_IDS, WORKER_IDS,
} from '../constants/config';
import type { BusinessState } from '../types/state';

export function upgradeCost(id: UpgradeId, level: number): number {
  const d = UPGRADES[id];
  return Math.round(d.baseCost * Math.pow(d.growth, level) / 5) * 5;
}

export function workerCost(id: WorkerId, count: number): number {
  const d = WORKERS[id];
  return Math.round(d.baseCost * Math.pow(d.growth, count) / 5) * 5;
}

export function tierCost(nextTier: number): number {
  return TIERS[nextTier - 1]?.cost ?? Infinity;
}

const has = (b: BusinessState, s: StructureId) => b.structures.includes(s);

export interface Rates {
  price: number;
  spawnRate: number; // customers/s
  serviceRate: number; // auto customers/s
  production: number; // stock/s
  capacity: number; // max queue+walking
  stockCap: number;
  manualProduce: number;
}

export interface Modifiers { customerMult: number; productionMult: number; halted: boolean }
export const NO_MODS: Modifiers = { customerMult: 1, productionMult: 1, halted: false };

export function computeRates(b: BusinessState, mods: Modifiers = NO_MODS): Rates {
  const u = b.upgrades, w = b.workers;
  const tierF = 1 + 0.25 * (b.tier - 1);
  let price = ECONOMY.basePrice * (1 + 0.5 * u.price) * ECONOMY.tierPriceMult[b.tier - 1];
  if (has(b, 'terrace')) price *= 1.15;

  let spawn = ECONOMY.baseSpawnRate * (1 + 0.4 * u.customers) * (1 + 0.2 * w.marketer) * tierF;
  if (has(b, 'billboard')) spawn *= 1.15;
  if (has(b, 'parking')) spawn *= 1.2;
  if (has(b, 'fountain')) spawn *= 1.25;
  spawn *= mods.customerMult;

  const branchF = has(b, 'branch') ? 1.5 : 1;
  let service = (ECONOMY.baseServiceRate + 0.45 * w.cashier) * (1 + 0.3 * u.speed) * (1 + 0.2 * w.manager) * tierF * branchF;
  let production = (ECONOMY.baseProduction * (1 + 0.4 * u.production) * tierF * (1 + 0.25 * w.worker) + w.manager) * branchF;
  production *= mods.productionMult;

  let capacity = 4 + 2 * u.capacity + b.tier;
  if (has(b, 'parking')) capacity += 2;
  if (has(b, 'warehouse')) capacity += 4;
  const stockCap = capacity * 6 + (has(b, 'warehouse') ? 60 : 0);

  if (mods.halted) { service = 0; production = 0; }
  return {
    price: Math.round(price),
    spawnRate: spawn,
    serviceRate: service,
    production,
    capacity,
    stockCap,
    manualProduce: ECONOMY.manualProduce + u.production,
  };
}

export function businessValue(b: BusinessState): number {
  const s = b.stats, W = VALUE_WEIGHTS;
  return Math.floor(
    b.cash * W.cash + s.spentBuilding * W.building + s.spentStructure * W.structure +
    s.spentUpgrade * W.upgrade + s.spentWorker * W.worker,
  );
}

export function emptyBusiness(id: number, plot: number, ownerIds: string[], cash: number): BusinessState {
  const upgrades = Object.fromEntries(UPGRADE_IDS.map((k) => [k, 0])) as Record<UpgradeId, number>;
  const workers = Object.fromEntries(WORKER_IDS.map((k) => [k, 0])) as Record<WorkerId, number>;
  const b: BusinessState = {
    id, plot, ownerIds, cash, stock: ECONOMY.startStock, queue: 0, tier: 1, upgrades, workers, structures: [],
    stats: { customers: 0, income: 0, upgrades: 0, buildings: 1, spentBuilding: 0, spentStructure: 0, spentUpgrade: 0, spentWorker: 0 },
    value: 0,
  };
  b.value = businessValue(b);
  return b;
}

export type PurchaseCheck = { ok: true; cost: number } | { ok: false; code: 'NOT_ENOUGH_MONEY' | 'MAXED' | 'LOCKED' };

export function checkUpgrade(b: BusinessState, id: UpgradeId): PurchaseCheck {
  const lvl = b.upgrades[id];
  if (lvl >= UPGRADES[id].max) return { ok: false, code: 'MAXED' };
  const cost = upgradeCost(id, lvl);
  return b.cash >= cost ? { ok: true, cost } : { ok: false, code: 'NOT_ENOUGH_MONEY' };
}

export function checkWorker(b: BusinessState, id: WorkerId): PurchaseCheck {
  const n = b.workers[id];
  if (n >= WORKERS[id].max) return { ok: false, code: 'MAXED' };
  const cost = workerCost(id, n);
  return b.cash >= cost ? { ok: true, cost } : { ok: false, code: 'NOT_ENOUGH_MONEY' };
}

export function checkTier(b: BusinessState): PurchaseCheck {
  if (b.tier >= TIERS.length) return { ok: false, code: 'MAXED' };
  const cost = tierCost(b.tier + 1);
  return b.cash >= cost ? { ok: true, cost } : { ok: false, code: 'NOT_ENOUGH_MONEY' };
}

export function checkStructure(b: BusinessState, id: StructureId): PurchaseCheck {
  const d = STRUCTURES[id];
  if (!d) return { ok: false, code: 'LOCKED' };
  if (has(b, id)) return { ok: false, code: 'MAXED' };
  if (b.tier < d.minTier) return { ok: false, code: 'LOCKED' };
  return b.cash >= d.cost ? { ok: true, cost: d.cost } : { ok: false, code: 'NOT_ENOUGH_MONEY' };
}

export function megaMallMissing(b: BusinessState): string[] {
  const miss: string[] = [];
  if (b.tier < COOP_GOAL.minTier) miss.push(`Здание уровня ${COOP_GOAL.minTier}+ (${TIERS[COOP_GOAL.minTier - 1].name})`);
  for (const [k, v] of Object.entries(COOP_GOAL.minUpgrades)) {
    if (b.upgrades[k as UpgradeId] < (v ?? 0)) miss.push(`${UPGRADES[k as UpgradeId].name} ур. ${v}`);
  }
  if (b.cash < COOP_GOAL.cost) miss.push(`$${formatMoney(COOP_GOAL.cost)}`);
  return miss;
}

export function formatMoney(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return Math.floor(n).toLocaleString('en-US');
}
