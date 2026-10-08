import type { CosmeticId, StructureId, UpgradeId, WorkerId } from '../constants/config';

export type GameMode = 'vs' | 'coop' | 'solo';
export type MatchStatus = 'lobby' | 'countdown' | 'playing' | 'ended';
export type AnimState = 0 | 1 | 2 | 3 | 4 | 5; // idle, run, jump, interact, victory, lose
export const ANIM = { idle: 0, run: 1, jump: 2, interact: 3, victory: 4, lose: 5 } as const;

export interface BusinessStats {
  customers: number;
  income: number;
  upgrades: number;
  buildings: number;
  spentBuilding: number;
  spentStructure: number;
  spentUpgrade: number;
  spentWorker: number;
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
  structures: StructureId[];
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

export type ActiveEventKind = 'rush' | 'boost' | 'golden' | 'delivery' | 'power';

export interface ActiveEvent {
  kind: ActiveEventKind;
  startedAt: number;
  endsAt: number;
  crates?: number[]; // delivery: remaining crate indices
  switches?: number[]; // power: server time each switch was last pressed (0 = off)
}

export interface MatchResult {
  winnerIds: string[]; // empty = draw / team loss
  reason: 'time' | 'goal' | 'forfeit' | 'disconnect' | 'dev';
  mode: GameMode;
  players: { id: string; name: string; value: number; businessId: number }[];
  businesses: { id: number; value: number; customers: number; upgrades: number; buildings: number; income: number; tier: number }[];
  rewards: Record<string, { coins: number; ratingDelta: number }>;
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
