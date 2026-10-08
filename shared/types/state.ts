import type { AchievementId, CosmeticId, StructureId, UpgradeId, VenueId, WorkerId } from '../constants/config';

export type GameMode = 'vs' | 'coop' | 'solo';
export type MatchStatus = 'lobby' | 'countdown' | 'playing' | 'ended';
export const ANIM = { idle: 0, run: 1, jump: 2, interact: 3, victory: 4, lose: 5, walk: 6, carry: 7, celebrate: 8 } as const;
export type AnimState = (typeof ANIM)[keyof typeof ANIM];
export const ANIM_MAX = 8;

export interface BusinessStats {
  customers: number;
  income: number;
  upgrades: number;
  buildings: number;
  /** Best income over a rolling 60 s window ($/min). */
  peakIncome: number;
  spentBuilding: number;
  spentStructure: number;
  spentUpgrade: number;
  spentWorker: number;
  spentVenue: number;
}

export interface BusinessState {
  id: number;
  plot: number;
  ownerIds: string[];
  cash: number;
  stock: number;
  queue: number; // customers waiting at counter
  tier: number; // 1..10
  upgrades: Record<UpgradeId, number>;
  workers: Record<WorkerId, number>;
  /** Secondary businesses: 0 = not built, 1..3 = level. */
  venues: Record<VenueId, number>;
  structures: StructureId[];
  /** Server time until which production is boosted (Big Delivery reward). */
  boostUntil: number;
  stats: BusinessStats;
  value: number;
}

/** High-frequency economy fields only (sent several times per second). */
export interface BusinessTick {
  id: number;
  cash: number;
  stock: number;
  queue: number;
  value: number;
  customers: number;
  /** Income over the last 60 s ($/min). */
  ipm: number;
}

export interface PlayerPublic {
  id: string;
  name: string;
  slot: number;
  color: number;
  hat: CosmeticId;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  ping: number;
  rematch: boolean;
  graceUntil?: number; // server time when reconnect window ends
}

export type ActiveEventKind = 'rush' | 'boost' | 'festival' | 'vip' | 'delivery' | 'power';

export interface ActiveEvent {
  kind: ActiveEventKind;
  startedAt: number;
  endsAt: number;
  /** delivery: remaining crate indices per business id. */
  crates?: Record<number, number[]>;
  /** vip: flat reward each VIP pays (same for everybody). */
  reward?: number;
  switches?: number[]; // power: server time each switch was last pressed (0 = off)
}

export interface MatchResult {
  winnerIds: string[]; // empty = draw / team loss
  reason: 'time' | 'goal' | 'forfeit' | 'disconnect' | 'dev';
  mode: GameMode;
  players: { id: string; name: string; value: number; businessId: number }[];
  businesses: { id: number; value: number; customers: number; upgrades: number; buildings: number; income: number; tier: number; peakIncome: number; venues: number }[];
  rewards: Record<string, { coins: number; ratingDelta: number; achievements: AchievementId[] }>;
}

export interface RoomSnapshot {
  roomId: string;
  code: string;
  mode: GameMode;
  status: MatchStatus;
  isPrivate: boolean;
  serverTime: number;
  countdownEndsAt: number;
  startTime: number;
  endTime: number;
  players: PlayerPublic[];
  businesses: BusinessState[];
  event: ActiveEvent | null;
  result: MatchResult | null;
  megaMallBuilt: boolean;
  devTools: boolean;
}
