// Centralized, typed network protocol. Every message has a numeric-free string
// tag `t` taken ONLY from these enums — no ad-hoc strings anywhere else.

import type { CosmeticId, StructureId, UpgradeId, WorkerId } from '../constants/config';
import type {
  ActiveEvent, BusinessState, BusinessTick, GameMode, MatchResult, RoomSnapshot,
} from '../types/state';

export const PROTOCOL_VERSION = 1;

export const C2S = {
  HELLO: 'HELLO',
  PING: 'PING',
  CREATE_ROOM: 'CREATE_ROOM',
  JOIN_ROOM: 'JOIN_ROOM',
  RESUME: 'RESUME',
  QUICK_MATCH: 'QUICK_MATCH',
  CANCEL_QUICK_MATCH: 'CANCEL_QUICK_MATCH',
  PLAY_SOLO: 'PLAY_SOLO',
  SET_MODE: 'SET_MODE',
  PLAYER_READY: 'PLAYER_READY',
  START_MATCH: 'START_MATCH',
  PLAYER_MOVE: 'PLAYER_MOVE',
  BUY_UPGRADE: 'BUY_UPGRADE',
  BUILD_BUSINESS: 'BUILD_BUSINESS',
  HIRE_WORKER: 'HIRE_WORKER',
  INTERACT: 'INTERACT',
  BUILD_MEGA_MALL: 'BUILD_MEGA_MALL',
  EMOTE: 'EMOTE',
  REMATCH: 'REMATCH',
  LEAVE: 'LEAVE',
  BUY_COSMETIC: 'BUY_COSMETIC',
  SET_COSMETIC: 'SET_COSMETIC',
  AD_REWARD: 'AD_REWARD',
  GET_LEADERBOARD: 'GET_LEADERBOARD',
  DEV: 'DEV',
} as const;

export const S2C = {
  WELCOME: 'WELCOME',
  PONG: 'PONG',
  ERROR: 'ERROR',
  ROOM_JOINED: 'ROOM_JOINED',
  ROOM_STATE: 'ROOM_STATE',
  ROOM_LEFT: 'ROOM_LEFT',
  QUEUE_STATUS: 'QUEUE_STATUS',
  MATCH_COUNTDOWN: 'MATCH_COUNTDOWN',
  SNAPSHOT: 'SNAPSHOT',
  ECONOMY: 'ECONOMY',
  BUSINESS_UPDATE: 'BUSINESS_UPDATE',
  CUSTOMER_SPAWN: 'CUSTOMER_SPAWN',
  CUSTOMER_SERVED: 'CUSTOMER_SERVED',
  CUSTOMER_LEFT: 'CUSTOMER_LEFT',
  DELIVERY_SALE: 'DELIVERY_SALE',
  EVENT_STATE: 'EVENT_STATE',
  EMOTE: 'EMOTE',
  PLAYER_DISCONNECTED: 'PLAYER_DISCONNECTED',
  PLAYER_RECONNECTED: 'PLAYER_RECONNECTED',
  CORRECTION: 'CORRECTION',
  MATCH_END: 'MATCH_END',
  PROFILE: 'PROFILE',
  LEADERBOARD: 'LEADERBOARD',
  TOAST: 'TOAST',
} as const;

export const ERR = {
  BAD_MESSAGE: 'BAD_MESSAGE',
  RATE_LIMITED: 'RATE_LIMITED',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_IN_PROGRESS: 'ROOM_IN_PROGRESS',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  NOT_ALLOWED: 'NOT_ALLOWED',
  NOT_READY: 'NOT_READY',
  NOT_ENOUGH_MONEY: 'NOT_ENOUGH_MONEY',
  MAXED: 'MAXED',
  LOCKED: 'LOCKED',
  TOO_FAR: 'TOO_FAR',
  BAD_TOKEN: 'BAD_TOKEN',
  NOT_PLAYING: 'NOT_PLAYING',
  DEV_DISABLED: 'DEV_DISABLED',
} as const;
export type ErrCode = (typeof ERR)[keyof typeof ERR];

export const EMOTES = ['👋', '😂', '🔥', '😎', '😡'] as const;

/** Compact movement tuple: x, y, z, rotY, anim */
export type MoveTuple = [number, number, number, number, number];

export type BuildKind = 'tier' | 'structure';
export type InteractTarget =
  | { kind: 'counter'; biz: number }
  | { kind: 'machine'; biz: number }
  | { kind: 'crate'; index: number }
  | { kind: 'switch'; id: number };

export type DevCmd =
  | 'addMoney' | 'speedTimer' | 'buildTier' | 'endMatch' | 'triggerEvent' | 'dropSocket';

export interface PlayerProfile {
  id: string;
  name: string;
  wins: number;
  losses: number;
  coopWins: number;
  rating: number;
  coins: number;
  hats: CosmeticId[];
  hat: CosmeticId;
  gamesPlayed: number;
}

export type ClientMsg =
  | { t: typeof C2S.HELLO; v: number; profileId?: string; secret?: string; name?: string }
  | { t: typeof C2S.PING; c: number; rtt: number }
  | { t: typeof C2S.CREATE_ROOM; mode: GameMode }
  | { t: typeof C2S.JOIN_ROOM; code: string }
  | { t: typeof C2S.RESUME; token: string }
  | { t: typeof C2S.QUICK_MATCH }
  | { t: typeof C2S.CANCEL_QUICK_MATCH }
  | { t: typeof C2S.PLAY_SOLO }
  | { t: typeof C2S.SET_MODE; mode: GameMode }
  | { t: typeof C2S.PLAYER_READY; ready: boolean }
  | { t: typeof C2S.START_MATCH }
  | { t: typeof C2S.PLAYER_MOVE; p: MoveTuple; seq: number }
  | { t: typeof C2S.BUY_UPGRADE; id: UpgradeId }
  | { t: typeof C2S.BUILD_BUSINESS; kind: BuildKind; id?: StructureId }
  | { t: typeof C2S.HIRE_WORKER; id: WorkerId }
  | { t: typeof C2S.INTERACT; target: InteractTarget }
  | { t: typeof C2S.BUILD_MEGA_MALL }
  | { t: typeof C2S.EMOTE; e: number }
  | { t: typeof C2S.REMATCH }
  | { t: typeof C2S.LEAVE }
  | { t: typeof C2S.BUY_COSMETIC; id: CosmeticId }
  | { t: typeof C2S.SET_COSMETIC; id: CosmeticId }
  | { t: typeof C2S.AD_REWARD }
  | { t: typeof C2S.GET_LEADERBOARD }
  | { t: typeof C2S.DEV; cmd: DevCmd; arg?: number };

export type ServerMsg =
  | { t: typeof S2C.WELCOME; serverTime: number; devTools: boolean; profile: PlayerProfile; secret: string }
  | { t: typeof S2C.PONG; c: number; s: number }
  | { t: typeof S2C.ERROR; code: ErrCode; msg: string }
  | { t: typeof S2C.ROOM_JOINED; token: string; playerId: string; room: RoomSnapshot }
  | { t: typeof S2C.ROOM_STATE; room: RoomSnapshot }
  | { t: typeof S2C.ROOM_LEFT; reason: string }
  | { t: typeof S2C.QUEUE_STATUS; searching: boolean; since: number }
  | { t: typeof S2C.MATCH_COUNTDOWN; startAt: number; endAt: number; serverTime: number }
  /** [id, x, y, z, rotY, anim] per player; s = server time */
  | { t: typeof S2C.SNAPSHOT; s: number; tick: number; p: [string, number, number, number, number, number][] }
  | { t: typeof S2C.ECONOMY; s: number; b: BusinessTick[] }
  | { t: typeof S2C.BUSINESS_UPDATE; b: BusinessState; cause: string; by?: string }
  | { t: typeof S2C.CUSTOMER_SPAWN; b: number; id: number; g: boolean; arrive: number; side: number }
  | { t: typeof S2C.CUSTOMER_SERVED; b: number; id: number; amt: number; by?: string }
  | { t: typeof S2C.CUSTOMER_LEFT; b: number; id: number }
  | { t: typeof S2C.DELIVERY_SALE; b: number; amt: number }
  | { t: typeof S2C.EVENT_STATE; event: ActiveEvent | null; outcome?: 'success' | 'fail' | 'expired' }
  | { t: typeof S2C.EMOTE; id: string; e: number }
  | { t: typeof S2C.PLAYER_DISCONNECTED; id: string; graceUntil: number }
  | { t: typeof S2C.PLAYER_RECONNECTED; id: string }
  | { t: typeof S2C.CORRECTION; p: MoveTuple }
  | { t: typeof S2C.MATCH_END; result: MatchResult }
  | { t: typeof S2C.PROFILE; profile: PlayerProfile }
  | { t: typeof S2C.LEADERBOARD; entries: { name: string; wins: number; rating: number }[] }
  | { t: typeof S2C.TOAST; text: string; kind?: 'info' | 'good' | 'bad' };

export type ClientMsgOf<T extends ClientMsg['t']> = Extract<ClientMsg, { t: T }>;
export type ServerMsgOf<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;
