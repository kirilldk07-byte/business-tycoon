import {
  COSMETICS, STRUCTURE_IDS, UPGRADE_IDS, WORKER_IDS,
} from '../../shared/constants/config';
import { C2S, EMOTES, type ClientMsg } from '../../shared/protocol/messages';

// Structural validation of every inbound message. Anything that doesn't match
// exactly is dropped before it reaches room logic.

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown, max = 64): v is string => typeof v === 'string' && v.length <= max;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const MODES = ['vs', 'coop', 'solo'] as const;
const DEV_CMDS = ['addMoney', 'speedTimer', 'buildTier', 'endMatch', 'triggerEvent', 'dropSocket'] as const;
const COSMETIC_IDS = COSMETICS.map((c) => c.id);

export function validateClientMsg(m: any): m is ClientMsg {
  switch (m.t) {
    case C2S.HELLO:
      return isNum(m.v) && (m.profileId === undefined || isStr(m.profileId)) && (m.secret === undefined || isStr(m.secret)) && (m.name === undefined || isStr(m.name, 40));
    case C2S.PING: return isNum(m.c) && isNum(m.rtt);
    case C2S.CREATE_ROOM: return oneOf(MODES, m.mode) && m.mode !== 'solo';
    case C2S.JOIN_ROOM: return typeof m.code === 'string' && /^\d{6}$/.test(m.code);
    case C2S.RESUME: return isStr(m.token, 128);
    case C2S.QUICK_MATCH: case C2S.CANCEL_QUICK_MATCH: case C2S.PLAY_SOLO: case C2S.START_MATCH:
    case C2S.BUILD_MEGA_MALL: case C2S.REMATCH: case C2S.LEAVE: case C2S.AD_REWARD: case C2S.GET_LEADERBOARD:
      return true;
    case C2S.SET_MODE: return oneOf(MODES, m.mode) && m.mode !== 'solo';
    case C2S.PLAYER_READY: return typeof m.ready === 'boolean';
    case C2S.PLAYER_MOVE:
      return Array.isArray(m.p) && m.p.length === 5 && m.p.every(isNum) && isNum(m.seq);
    case C2S.BUY_UPGRADE: return oneOf(UPGRADE_IDS, m.id);
    case C2S.HIRE_WORKER: return oneOf(WORKER_IDS, m.id);
    case C2S.BUILD_BUSINESS:
      return m.kind === 'tier' || (m.kind === 'structure' && oneOf(STRUCTURE_IDS, m.id));
    case C2S.INTERACT: {
      const g = m.target;
      if (!g || typeof g !== 'object') return false;
      if (g.kind === 'counter' || g.kind === 'machine') return Number.isInteger(g.biz);
      if (g.kind === 'crate') return Number.isInteger(g.index);
      if (g.kind === 'switch') return Number.isInteger(g.id);
      return false;
    }
    case C2S.EMOTE: return Number.isInteger(m.e) && m.e >= 0 && m.e < EMOTES.length;
    case C2S.BUY_COSMETIC: case C2S.SET_COSMETIC: return oneOf(COSMETIC_IDS, m.id);
    case C2S.DEV: return oneOf(DEV_CMDS, m.cmd) && (m.arg === undefined || isNum(m.arg));
    default: return false;
  }
}

export function sanitizeName(name: string | undefined): string {
  const clean = (name ?? '').replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, 16);
  return clean || `Player${Math.floor(1000 + Math.random() * 9000)}`;
}
