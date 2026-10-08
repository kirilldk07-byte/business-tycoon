// Single source of truth for gameplay balance. Both server (authoritative) and
// client (display only) read from here. Tune numbers here, not in logic code.

export const UPGRADE_IDS = ['price', 'customers', 'speed', 'production', 'capacity'] as const;
export const WORKER_IDS = ['cashier', 'worker', 'manager', 'delivery', 'marketer'] as const;
export const STRUCTURE_IDS = ['billboard', 'parking', 'warehouse', 'terrace', 'fountain'] as const;
export const VENUE_IDS = ['burger', 'restaurant', 'supermarket', 'cars', 'hotel', 'mall'] as const;

export type UpgradeId = (typeof UPGRADE_IDS)[number];
export type WorkerId = (typeof WORKER_IDS)[number];
export type StructureId = (typeof STRUCTURE_IDS)[number];
export type VenueId = (typeof VENUE_IDS)[number];

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
  /** Flagship price multiplier per HQ tier (index = tier-1). */
  tierPriceMult: [1, 1.8, 3, 5, 8, 13, 20, 32, 50, 80],
  customerSpeed: 2.8, // m/s; walk time = path length / speed (shared with clients)
  patienceMs: 25_000,
  baseSpawnRate: 0.55, // flagship customers / second
  baseServiceRate: 0.45, // automatic serving without staff
  baseProduction: 0.6, // stock / second
  manualProduce: 4, // stock per press
  manualProduceCooldownMs: 300,
  manualServeCooldownMs: 250,
  startStock: 12,
  goldenPriceMult: 10,
  deliveryIntervalMs: 8_000,
  /** Venue level multipliers (index = level-1) and expansion cost factors. */
  venueLevelMult: [1, 2, 3.6],
  venueExpandCost: [0, 1.6, 3.2],
};

export interface UpgradeDef { name: string; icon: string; desc: string; baseCost: number; growth: number; max: number }
export const UPGRADES: Record<UpgradeId, UpgradeDef> = {
  price: { name: 'PRICE', icon: '💲', desc: '+50% к цене в кофейне', baseCost: 100, growth: 2.5, max: 6 },
  customers: { name: 'CUSTOMERS', icon: '👥', desc: '+40% клиентов кофейни, +10% всем бизнесам', baseCost: 120, growth: 2.5, max: 6 },
  speed: { name: 'WORKER SPEED', icon: '⚡', desc: '+30% скорость обслуживания', baseCost: 150, growth: 2.5, max: 6 },
  production: { name: 'PRODUCTION', icon: '🏭', desc: '+40% производство', baseCost: 100, growth: 2.5, max: 6 },
  capacity: { name: 'CAPACITY', icon: '📦', desc: '+2 места в очереди, +склад', baseCost: 80, growth: 2.5, max: 6 },
};

export interface WorkerDef { name: string; icon: string; desc: string; baseCost: number; growth: number; max: number }
export const WORKERS: Record<WorkerId, WorkerDef> = {
  cashier: { name: 'CASHIER', icon: '🧑‍💼', desc: 'Сам обслуживает клиентов на кассе', baseCost: 120, growth: 3, max: 3 },
  worker: { name: 'WORKER', icon: '👷', desc: '+25% скорость производства', baseCost: 160, growth: 3, max: 3 },
  manager: { name: 'MANAGER', icon: '🕴️', desc: 'Автопроизводство +1/сек, +15% доход всех бизнесов', baseCost: 1200, growth: 3, max: 3 },
  delivery: { name: 'DELIVERY', icon: '🛵', desc: 'Продаёт товар на доставку каждые 8 сек', baseCost: 700, growth: 3, max: 3 },
  marketer: { name: 'MARKETER', icon: '📣', desc: '+20% клиентов во всех бизнесах', baseCost: 500, growth: 3, max: 3 },
};

export interface StructureDef { name: string; icon: string; desc: string; cost: number; minTier: number }
export const STRUCTURES: Record<StructureId, StructureDef> = {
  billboard: { name: 'Билборд', icon: '🪧', desc: '+15% клиентов', cost: 500, minTier: 1 },
  parking: { name: 'Парковка', icon: '🅿️', desc: '+20% клиентов, +2 очередь', cost: 1500, minTier: 2 },
  warehouse: { name: 'Склад', icon: '🏚️', desc: '+4 очередь, большой склад', cost: 2500, minTier: 3 },
  terrace: { name: 'Терраса', icon: '⛱️', desc: '+15% к цене в кофейне', cost: 6000, minTier: 4 },
  fountain: { name: 'Фонтан', icon: '⛲', desc: '+25% клиентов', cost: 15000, minTier: 5 },
};

/** HQ / flagship tiers. Index = tier-1; tier 0 = empty lot. cost = price to reach that tier. */
export const TIERS = [
  { name: 'Киоск', icon: '🥤', cost: 50 },
  { name: 'Кофейня', icon: '☕', cost: 400 },
  { name: 'Кафе', icon: '🍔', cost: 1200 },
  { name: 'Ресторан', icon: '🍽️', cost: 3500 },
  { name: 'Магазин', icon: '🏪', cost: 9000 },
  { name: 'Супермаркет', icon: '🛒', cost: 22000 },
  { name: 'Торговый центр', icon: '🏬', cost: 50000 },
  { name: 'Бизнес-центр', icon: '🏢', cost: 110000 },
  { name: 'Небоскрёб', icon: '🌆', cost: 240000 },
  { name: 'BUSINESS EMPIRE', icon: '👑', cost: 500000 },
];

/**
 * Secondary businesses, unlocked in order (data-driven: add an entry + a slot
 * in world.ts PLOT_LOCAL.venues + a builder in BuildingFactory to extend).
 * income ≈ rate × price per second at level 1.
 */
export interface VenueDef { name: string; icon: string; sign: string; cost: number; price: number; rate: number; minTier: number; color: number }
export const VENUES: Record<VenueId, VenueDef> = {
  burger: { name: 'Burger Shop', icon: '🍔', sign: 'BURGERS', cost: 600, price: 18, rate: 0.35, minTier: 1, color: 0xef4444 },
  restaurant: { name: 'Restaurant', icon: '🍝', sign: 'RESTAURANT', cost: 3200, price: 55, rate: 0.35, minTier: 2, color: 0x7c3aed },
  supermarket: { name: 'Supermarket', icon: '🛒', sign: 'SUPERMARKET', cost: 14000, price: 120, rate: 0.5, minTier: 3, color: 0x16a34a },
  cars: { name: 'Car Dealership', icon: '🚗', sign: 'AUTO CENTER', cost: 45000, price: 1400, rate: 0.12, minTier: 4, color: 0x0284c7 },
  hotel: { name: 'Hotel', icon: '🏨', sign: 'HOTEL', cost: 130000, price: 1600, rate: 0.28, minTier: 5, color: 0xdb2777 },
  mall: { name: 'Shopping Mall', icon: '🏬', sign: 'MALL', cost: 360000, price: 2200, rate: 0.55, minTier: 6, color: 0xf59e0b },
};

// BUSINESS VALUE = cash + spend per category × weight.
export const VALUE_WEIGHTS = { cash: 1, building: 1, structure: 1, venue: 1, upgrade: 0.8, worker: 0.6 };

export const COOP_GOAL = {
  name: 'MEGA MALL',
  cost: 1_000_000,
  minTier: 8,
  minUpgrades: { price: 4, customers: 4, capacity: 4 } as Partial<Record<UpgradeId, number>>,
};

export const EVENTS = {
  firstDelayMs: 75_000,
  minGapMs: 65_000,
  maxGapMs: 95_000,
  rushDurationMs: 30_000,
  rushMultVs: 2,
  rushMultCoop: 3,
  boostDurationMs: 30_000,
  boostMult: 2,
  festivalDurationMs: 40_000,
  festivalMult: 1.5,
  vipDurationMs: 25_000,
  deliveryCrates: 6,
  deliveryDurationMs: 40_000,
  deliveryStock: 40,
  deliveryCashPerPrice: 20,
  /** Big Delivery (VS): unloading all your crates gives a production boost. */
  deliveryBoostMs: 45_000,
  deliveryBoostMult: 2,
  powerWindowMs: 5_000,
  powerMaxMs: 45_000,
};

/** Golden customers: rare, fair (spawn at every business at the same moment). */
export const GOLDEN = { firstMs: 40_000, minGapMs: 70_000, maxGapMs: 110_000 };

/** VIP reward is a flat amount by match time — identical for both players (comeback-friendly, no rubber-banding). */
export function vipReward(elapsedMs: number): number {
  const min = elapsedMs / 60_000;
  return Math.round((400 * Math.pow(1.75, min)) / 50) * 50;
}

export const PLAYER = {
  walkSpeed: 3.5,
  runSpeed: 7,
  jumpVelocity: 7.5,
  gravity: 22,
  interactRadius: 3.2,
};

export const RATE_LIMITS = {
  move: { perSec: 30, burst: 40 },
  action: { perSec: 12, burst: 20 },
  emote: { perSec: 0.6, burst: 2 },
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

export const ACHIEVEMENTS = {
  first_business: { name: 'FIRST BUSINESS', icon: '🏪', desc: 'Открой свой первый бизнес' },
  entrepreneur: { name: 'ENTREPRENEUR', icon: '💼', desc: 'Заработай $100K за матч' },
  millionaire: { name: 'MILLIONAIRE', icon: '💰', desc: 'Достигни $1M business value' },
  winner: { name: 'WINNER', icon: '🏆', desc: 'Выиграй первый VS матч' },
  teamwork: { name: 'TEAMWORK', icon: '🤝', desc: 'Выиграй CO-OP' },
  tycoon: { name: 'TYCOON', icon: '👑', desc: 'Выиграй 10 матчей' },
} as const;
export type AchievementId = keyof typeof ACHIEVEMENTS;
