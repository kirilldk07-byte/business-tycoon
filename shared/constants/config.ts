// Single source of truth for gameplay balance. Both server (authoritative) and
// client (display only) read from here. Tune numbers here, not in logic code.

export const UPGRADE_IDS = ['price', 'customers', 'speed', 'production', 'capacity'] as const;
export const WORKER_IDS = ['cashier', 'worker', 'manager', 'delivery', 'marketer'] as const;
export const STRUCTURE_IDS = ['billboard', 'parking', 'warehouse', 'terrace', 'fountain', 'branch'] as const;

export type UpgradeId = (typeof UPGRADE_IDS)[number];
export type WorkerId = (typeof WORKER_IDS)[number];
export type StructureId = (typeof STRUCTURE_IDS)[number];

export const MATCH = {
  maxPlayers: { vs: 2, coop: 2, solo: 1 },
  durationMs: { vs: 10 * 60_000, coop: 15 * 60_000, solo: 15 * 60_000 },
  countdownMs: 3_500,
  startCash: 100,
  reconnectGraceMs: 45_000,
  serverTickHz: 10,
  snapshotHz: 15,
  economyHz: 4,
};

export const ECONOMY = {
  basePrice: 10,
  tierPriceMult: [1, 1.8, 3, 5, 8, 13, 20, 32, 50, 80],
  walkTimeMs: 3_200,
  patienceMs: 25_000,
  baseSpawnRate: 0.5, // customers / second
  baseServiceRate: 0.4, // automatic serving without staff
  baseProduction: 0.6, // stock / second
  manualProduce: 4, // stock per press
  manualProduceCooldownMs: 300,
  manualServeCooldownMs: 250,
  startStock: 12,
  goldenPriceMult: 15,
  deliveryIntervalMs: 8_000,
};

export interface UpgradeDef { name: string; icon: string; desc: string; baseCost: number; growth: number; max: number }
export const UPGRADES: Record<UpgradeId, UpgradeDef> = {
  price: { name: 'PRICE', icon: '💲', desc: '+50% к цене товара', baseCost: 100, growth: 2.5, max: 6 },
  customers: { name: 'CUSTOMERS', icon: '👥', desc: '+40% поток клиентов', baseCost: 120, growth: 2.5, max: 6 },
  speed: { name: 'WORKER SPEED', icon: '⚡', desc: '+30% скорость обслуживания', baseCost: 150, growth: 2.5, max: 6 },
  production: { name: 'PRODUCTION', icon: '🏭', desc: '+40% производство', baseCost: 100, growth: 2.5, max: 6 },
  capacity: { name: 'CAPACITY', icon: '📦', desc: '+2 места в очереди, +склад', baseCost: 80, growth: 2.5, max: 6 },
};

export interface WorkerDef { name: string; icon: string; desc: string; baseCost: number; growth: number; max: number }
export const WORKERS: Record<WorkerId, WorkerDef> = {
  cashier: { name: 'CASHIER', icon: '🧑‍💼', desc: 'Автоматически обслуживает клиентов', baseCost: 150, growth: 3, max: 3 },
  worker: { name: 'WORKER', icon: '👷', desc: '+25% скорость производства', baseCost: 200, growth: 3, max: 3 },
  manager: { name: 'MANAGER', icon: '🕴️', desc: 'Автопроизводство +1/сек и +20% к обслуживанию', baseCost: 1500, growth: 3, max: 3 },
  delivery: { name: 'DELIVERY', icon: '🛵', desc: 'Продаёт товар на доставку каждые 8 сек', baseCost: 800, growth: 3, max: 3 },
  marketer: { name: 'MARKETER', icon: '📣', desc: '+20% клиентов', baseCost: 600, growth: 3, max: 3 },
};

export interface StructureDef { name: string; icon: string; desc: string; cost: number; minTier: number }
export const STRUCTURES: Record<StructureId, StructureDef> = {
  billboard: { name: 'Билборд', icon: '🪧', desc: '+15% клиентов', cost: 500, minTier: 1 },
  parking: { name: 'Парковка', icon: '🅿️', desc: '+20% клиентов, +2 очередь', cost: 1500, minTier: 2 },
  warehouse: { name: 'Склад', icon: '🏚️', desc: '+4 очередь, большой склад', cost: 2500, minTier: 3 },
  terrace: { name: 'Терраса', icon: '⛱️', desc: '+15% к цене', cost: 6000, minTier: 4 },
  fountain: { name: 'Фонтан', icon: '⛲', desc: '+25% клиентов', cost: 15000, minTier: 5 },
  branch: { name: 'Филиал', icon: '🏬', desc: '+50% производство и обслуживание', cost: 45000, minTier: 6 },
};

// Building tiers: index = tier-1. cost = price to reach this tier.
export const TIERS = [
  { name: 'Киоск', cost: 0 },
  { name: 'Кофейня', cost: 400 },
  { name: 'Кафе', cost: 1200 },
  { name: 'Ресторан', cost: 3500 },
  { name: 'Магазин', cost: 9000 },
  { name: 'Супермаркет', cost: 22000 },
  { name: 'Торговый центр', cost: 50000 },
  { name: 'Корпорация', cost: 110000 },
  { name: 'Небоскрёб', cost: 240000 },
  { name: 'BUSINESS EMPIRE', cost: 500000 },
];

// BUSINESS VALUE = cash*cash + spent on each category * weight.
export const VALUE_WEIGHTS = { cash: 1, building: 1, structure: 1, upgrade: 0.8, worker: 0.6 };

export const COOP_GOAL = {
  name: 'MEGA MALL',
  cost: 1_000_000,
  minTier: 8,
  minUpgrades: { price: 4, customers: 4, capacity: 4 } as Partial<Record<UpgradeId, number>>,
};

export const EVENTS = {
  firstDelayMs: 50_000,
  minGapMs: 60_000,
  maxGapMs: 90_000,
  rushDurationMs: 30_000,
  rushMultVs: 2,
  rushMultCoop: 3,
  boostDurationMs: 30_000,
  boostMult: 2,
  deliveryCrates: 6,
  deliveryDurationMs: 40_000,
  deliveryStock: 40,
  deliveryCashPerPrice: 20,
  powerWindowMs: 5_000,
  powerMaxMs: 45_000,
};

export const PLAYER = {
  walkSpeed: 7,
  runSpeed: 7,
  jumpVelocity: 7.5,
  gravity: 22,
  interactRadius: 3.2,
};

export const RATE_LIMITS = {
  move: { perSec: 30, burst: 40 },
  action: { perSec: 12, burst: 20 },
  emote: { perSec: 0.8, burst: 3 },
  room: { perSec: 0.5, burst: 5 },
  dev: { perSec: 20, burst: 40 },
};

export const MATCHMAKING = { offerAlternativesAfterMs: 30_000 };

export const COSMETICS = [
  { id: 'none', name: 'Без шляпы', price: 0 },
  { id: 'cap', name: 'Кепка', price: 0 },
  { id: 'tophat', name: 'Цилиндр', price: 150 },
  { id: 'crown', name: 'Корона', price: 400 },
  { id: 'chef', name: 'Колпак шефа', price: 200 },
  { id: 'cowboy', name: 'Ковбойская шляпа', price: 300 },
] as const;
export type CosmeticId = (typeof COSMETICS)[number]['id'];

export const REWARDS = { win: 50, loss: 15, coopWin: 60, coopLoss: 15, ad: 30 };
export const RATING = { start: 1000, k: 32 };
