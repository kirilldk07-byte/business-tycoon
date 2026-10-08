import crypto from 'node:crypto';
import { MATCH, RATING, REWARDS } from '../../shared/constants/config';
import { S2C } from '../../shared/protocol/messages';
import type { GameMode, MatchResult } from '../../shared/types/state';
import type { ProfileStore, RoomStore } from '../persistence/storage';
import { Room, type Conn, type PlayerSlot, type RoomHooks } from './Room';

const LOBBY_IDLE_MS = 30 * 60_000;
const ENDED_IDLE_MS = 5 * 60_000;

/** Owns all rooms, room codes and session tokens; drives ticks; cleans up. */
export class RoomManager {
  rooms = new Map<string, Room>(); // by code
  private tokens = new Map<string, { room: Room; playerId: string }>();
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private profiles: ProfileStore,
    private store: RoomStore,
    private devTools: boolean,
    private maxRooms: number,
    private log: (m: string) => void,
  ) {}

  private hooks: RoomHooks = {
    onMatchEnd: (room, result) => this.applyResult(room, result),
    log: (m) => this.log(m),
  };

  start(snapshotMs: number) {
    this.restore();
    const tickMs = 1000 / MATCH.serverTickHz;
    let n = 0;
    this.timers.push(setInterval(() => {
      const now = Date.now();
      for (const r of this.rooms.values()) r.step(now);
      if (++n % (MATCH.serverTickHz * 5) === 0) this.cleanup(now);
      // Lobby: refresh pings/connection status every 2 s.
      if (n % (MATCH.serverTickHz * 2) === 0) {
        for (const r of this.rooms.values()) if (r.status === 'lobby' && r.connectedCount > 0) r.broadcastState();
      }
    }, tickMs));
    this.timers.push(setInterval(() => {
      for (const r of this.rooms.values()) {
        if (r.status !== 'lobby' && r.connectedCount > 0) r.broadcast(r.movementSnapshot());
      }
    }, 1000 / MATCH.snapshotHz));
    this.timers.push(setInterval(() => {
      for (const r of this.rooms.values()) {
        if (r.status === 'playing' && r.connectedCount > 0) r.broadcast(r.economySnapshot());
      }
    }, 1000 / MATCH.economyHz));
    this.timers.push(setInterval(() => this.persist(), snapshotMs));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.persist();
  }

  private newCode(): string {
    for (let i = 0; i < 50; i++) {
      const code = String(crypto.randomInt(100000, 1000000));
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('no free room codes');
  }

  canCreate() { return this.rooms.size < this.maxRooms; }

  create(mode: GameMode, isPrivate: boolean): Room {
    const room = new Room(this.newCode(), mode, isPrivate, this.hooks, this.devTools);
    this.rooms.set(room.code, room);
    this.log(`room ${room.code} created (${mode}, ${isPrivate ? 'private' : 'public'})`);
    return room;
  }

  join(room: Room, conn: Conn, profileId: string, name: string, hat: PlayerSlot['hat']): PlayerSlot {
    const p = room.addPlayer(conn, profileId, name, hat);
    this.tokens.set(p.token, { room, playerId: p.id });
    return p;
  }

  byCode(code: string) { return this.rooms.get(code); }

  byToken(token: string) {
    const ref = this.tokens.get(token);
    if (!ref) return undefined;
    const p = ref.room.players.get(ref.playerId);
    if (!p || !this.rooms.has(ref.room.code)) {
      this.tokens.delete(token);
      return undefined;
    }
    return { room: ref.room, player: p };
  }

  /** Remove a player and drop their token. */
  leave(room: Room, p: PlayerSlot, reason: 'leave' | 'timeout') {
    room.leave(p, reason);
    this.tokens.delete(p.token);
  }

  private cleanup(now: number) {
    for (const [code, r] of this.rooms) {
      // Players whose grace expired were removed inside room.step(); drop their tokens.
      for (const [tok, ref] of this.tokens) {
        if (ref.room === r && !r.players.has(ref.playerId)) this.tokens.delete(tok);
      }
      const idle = now - r.lastActivity;
      const empty = r.players.size === 0;
      const stale = (r.status === 'lobby' && idle > LOBBY_IDLE_MS) || (r.status === 'ended' && idle > ENDED_IDLE_MS && r.connectedCount === 0);
      if (empty || stale) {
        for (const p of r.players.values()) { this.tokens.delete(p.token); p.conn?.terminate(); }
        this.rooms.delete(code);
        this.log(`room ${code} destroyed (${empty ? 'empty' : 'stale'}), rooms=${this.rooms.size}`);
      }
    }
  }

  // ---------- results → persistent profiles ----------

  private applyResult(room: Room, result: MatchResult) {
    const ids = result.players.map((p) => p.id);
    const slots = ids.map((id) => room.players.get(id)!).filter(Boolean);
    const recs = slots.map((s) => this.profiles.get(s.profileId)?.profile);
    const won = (id: string) => result.winnerIds.includes(id);

    // Elo for VS with exactly two players.
    const deltas: Record<string, number> = {};
    if (result.mode === 'vs' && slots.length === 2 && recs[0] && recs[1]) {
      const [a, b] = recs as NonNullable<(typeof recs)[0]>[];
      const ea = 1 / (1 + Math.pow(10, (b.rating - a.rating) / 400));
      const sa = result.winnerIds.length === 0 ? 0.5 : won(slots[0].id) ? 1 : 0;
      const d = Math.round(RATING.k * (sa - ea));
      deltas[slots[0].id] = d;
      deltas[slots[1].id] = -d;
    }

    slots.forEach((s, i) => {
      const prof = recs[i];
      let coins: number;
      if (result.mode === 'vs') coins = won(s.id) ? REWARDS.win : REWARDS.loss;
      else coins = won(s.id) ? REWARDS.coopWin : REWARDS.coopLoss;
      const ratingDelta = deltas[s.id] ?? 0;
      result.rewards[s.id] = { coins, ratingDelta };
      if (!prof) return;
      prof.gamesPlayed++;
      prof.coins += coins;
      prof.rating += ratingDelta;
      if (result.mode === 'vs') {
        if (won(s.id)) prof.wins++;
        else if (result.winnerIds.length) prof.losses++;
      } else if (won(s.id)) {
        prof.coopWins++;
        if (result.mode === 'coop') prof.wins++;
      }
      this.profiles.save(prof);
      s.conn?.send({ t: S2C.PROFILE, profile: prof });
    });
  }

  // ---------- restart recovery ----------

  private persist() {
    const live = [...this.rooms.values()].filter((r) => r.status === 'playing' || r.status === 'countdown');
    try {
      this.store.saveAll(live.map((r) => r.serialize()));
    } catch (e) {
      this.log(`persist failed: ${(e as Error).message}`);
    }
  }

  private restore() {
    const saved = this.store.loadAll() as ReturnType<Room['serialize']>[];
    for (const data of saved) {
      try {
        const room = Room.restore(data, this.hooks, this.devTools);
        this.rooms.set(room.code, room);
        for (const p of room.players.values()) this.tokens.set(p.token, { room, playerId: p.id });
        this.log(`restored room ${room.code} (${room.status}) with ${room.players.size} players`);
      } catch (e) {
        this.log(`restore failed: ${(e as Error).message}`);
      }
    }
  }
}
