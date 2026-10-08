// Pure economy formulas. The server uses these authoritatively; the client
// only uses them to display prices/rates. Never mutate state here.

import {
  COOP_GOAL, ECONOMY, STRUCTURES, TIERS, UPGRADES, VALUE_WEIGHTS, VENUES, VENUE_IDS, WORKERS,
  type StructureId, type UpgradeId, type VenueId, type WorkerId, UPGRADE_IDS, WORKER_IDS,
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

/** Cost to build (level 0 → 1) or expand (1 → 2 → 3) a venue. */
export function venueCost(id: VenueId, level: number): number {
  const f = level === 0 ? 1 : ECONOMY.venueExpandCost[level];
  return f ? Math.round((VENUES[id].cost * f) / 50) * 50 : Infinity;
}

const has = (b: BusinessState, s: StructureId) => b.structures.includes(s);

export interface Rates {
  price: number;
  spawnRate: number; // flagship customers/s
  serviceRate: number; // auto customers/s
  production: number; // stock/s
  capacity: number; // max queue+walking
  stockCap: number;
  manualProduce: number;
  /** Customer multiplier shared by all businesses (marketing, structures, events). */
  globalCustomers: number;
  venueIncomeMult: number;
}

export interface Modifiers { customerMult: number; productionMult: number; halted: boolean }
export const NO_MODS: Modifiers = { customerMult: 1, productionMult: 1, halted: false };

export function computeRates(b: BusinessState, mods: Modifiers = NO_MODS): Rates {
  const u = b.upgrades, w = b.workers;
  const tier = Math.max(1, b.tier);
  const tierF = 1 + 0.25 * (tier - 1);
  let price = ECONOMY.basePrice * (1 + 0.5 * u.price) * ECONOMY.tierPriceMult[tier - 1];
  if (has(b, 'terrace')) price *= 1.15;

  // Marketing affects every business; the CUSTOMERS upgrade mostly the flagship.
  let marketing = 1 + 0.2 * w.marketer;
  if (has(b, 'billboard')) marketing *= 1.15;
  if (has(b, 'parking')) marketing *= 1.2;
  if (has(b, 'fountain')) marketing *= 1.25;
  marketing *= mods.customerMult;
  const global = marketing * (1 + 0.1 * u.customers);

  let spawn = b.tier >= 1 ? ECONOMY.baseSpawnRate * (1 + 0.4 * u.customers) * tierF * marketing : 0;
  let service = (ECONOMY.baseServiceRate + 0.45 * w.cashier) * (1 + 0.3 * u.speed) * (1 + 0.2 * w.manager) * tierF;
  let production = (ECONOMY.baseProduction * (1 + 0.4 * u.production) * tierF * (1 + 0.25 * w.worker) + w.manager);
  production *= mods.productionMult;

  let capacity = 4 + 2 * u.capacity + tier;
  if (has(b, 'parking')) capacity += 2;
  if (has(b, 'warehouse')) capacity += 4;
  const stockCap = capacity * 6 + (has(b, 'warehouse') ? 60 : 0);
  const venueIncomeMult = (1 + 0.1 * (tier - 1)) * (1 + 0.15 * w.manager);

  if (mods.halted) { service = 0; production = 0; spawn *= 0.3; }
  return {
    price: Math.round(price), spawnRate: spawn, serviceRate: service, production, capacity, stockCap,
    manualProduce: ECONOMY.manualProduce + u.production, globalCustomers: global, venueIncomeMult,
  };
}

/** Per-customer price and customers/s for a built venue. */
export function venueRates(b: BusinessState, id: VenueId, r: Rates = computeRates(b)): { price: number; rate: number; cap: number } {
  const lvl = b.venues[id];
  if (!lvl) return { price: 0, rate: 0, cap: 0 };
  const d = VENUES[id];
  const levelMult = ECONOMY.venueLevelMult[lvl - 1];
  return {
    price: Math.round(d.price * levelMult * r.venueIncomeMult),
    rate: d.rate * (1 + 0.25 * (lvl - 1)) * r.globalCustomers,
    cap: 4 + lvl * 3,
  };
}

/** Rough $/minute for HUD and the balance bot. */
export function incomePerMinute(b: BusinessState): number {
  const r = computeRates(b);
  // Flagship sales are capped by arrivals, service speed and stock production.
  let perSec = Math.min(r.spawnRate, r.serviceRate + 0.3, r.production + 0.2) * r.price;
  for (const id of VENUE_IDS) { const v = venueRates(b, id, r); perSec += v.rate * v.price; }
  return Math.round(perSec * 60);
}

export type Purchase =
  | { kind: 'tier' } | { kind: 'upgrade'; id: UpgradeId } | { kind: 'worker'; id: WorkerId }
  | { kind: 'venue'; id: VenueId } | { kind: 'structure'; id: StructureId };

/** Extra $/minute a purchase would bring (display only — "ROI" hint in the shop). */
export function incomeGain(b: BusinessState, p: Purchase): number {
  const n: BusinessState = {
    ...b, upgrades: { ...b.upgrades }, workers: { ...b.workers }, venues: { ...b.venues }, structures: [...b.structures],
  };
  if (p.kind === 'tier') n.tier++;
  else if (p.kind === 'upgrade') n.upgrades[p.id]++;
  else if (p.kind === 'worker') n.workers[p.id]++;
  else if (p.kind === 'venue') n.venues[p.id]++;
  else n.structures.push(p.id);
  return Math.max(0, incomePerMinute(n) - incomePerMinute(b));
}

export function businessValue(b: BusinessState): number {
  const s = b.stats, W = VALUE_WEIGHTS;
  return Math.floor(
    b.cash * W.cash + s.spentBuilding * W.building + s.spentStructure * W.structure + s.spentVenue * W.venue +
    s.spentUpgrade * W.upgrade + s.spentWorker * W.worker,
  );
}

export function emptyBusiness(id: number, plot: number, ownerIds: string[], cash: number): BusinessState {
  const upgrades = Object.fromEntries(UPGRADE_IDS.map((k) => [k, 0])) as Record<UpgradeId, number>;
  const workers = Object.fromEntries(WORKER_IDS.map((k) => [k, 0])) as Record<WorkerId, number>;
  const venues = Object.fromEntries(VENUE_IDS.map((k) => [k, 0])) as Record<VenueId, number>;
  const b: BusinessState = {
    id, plot, ownerIds, cash, stock: ECONOMY.startStock, queue: 0, tier: 0, upgrades, workers, venues, structures: [],
    boostUntil: 0,
    stats: {
      customers: 0, income: 0, upgrades: 0, buildings: 0, peakIncome: 0,
      spentBuilding: 0, spentStructure: 0, spentUpgrade: 0, spentWorker: 0, spentVenue: 0,
    },
    value: 0,
  };
  b.value = businessValue(b);
  return b;
}

export type PurchaseCheck = { ok: true; cost: number } | { ok: false; code: 'NOT_ENOUGH_MONEY' | 'MAXED' | 'LOCKED' };
const needShop = (b: BusinessState): PurchaseCheck | null => (b.tier < 1 ? { ok: false, code: 'LOCKED' } : null);

export function checkUpgrade(b: BusinessState, id: UpgradeId): PurchaseCheck {
  const lock = needShop(b);
  if (lock) return lock;
  const lvl = b.upgrades[id];
  if (lvl >= UPGRADES[id].max) return { ok: false, code: 'MAXED' };
  const cost = upgradeCost(id, lvl);
  return b.cash >= cost ? { ok: true, cost } : { ok: false, code: 'NOT_ENOUGH_MONEY' };
}

export function checkWorker(b: BusinessState, id: WorkerId): PurchaseCheck {
  const lock = needShop(b);
  if (lock) return lock;
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

/** Venues unlock in order: previous venue built + HQ tier requirement. */
export function venueUnlocked(b: BusinessState, id: VenueId): boolean {
  const i = VENUE_IDS.indexOf(id);
  if (b.tier < VENUES[id].minTier) return false;
  return i === 0 || b.venues[VENUE_IDS[i - 1]] > 0;
}

export function checkVenue(b: BusinessState, id: VenueId): PurchaseCheck {
  const lvl = b.venues[id];
  if (lvl >= ECONOMY.venueLevelMult.length) return { ok: false, code: 'MAXED' };
  if (lvl === 0 && !venueUnlocked(b, id)) return { ok: false, code: 'LOCKED' };
  const cost = venueCost(id, lvl);
  return b.cash >= cost ? { ok: true, cost } : { ok: false, code: 'NOT_ENOUGH_MONEY' };
}

/** Next venue that can be built (for the purchase pad), or null. */
export function nextVenue(b: BusinessState): VenueId | null {
  for (const id of VENUE_IDS) if (b.venues[id] === 0) return id;
  return null;
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
