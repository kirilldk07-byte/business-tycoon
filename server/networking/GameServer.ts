import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { COSMETICS, MATCH, RATE_LIMITS, REWARDS, type CosmeticId } from '../../shared/constants/config';
import { decode } from '../../shared/protocol/codec';
import {
  C2S, ERR, PROTOCOL_VERSION, S2C, type ClientMsg, type ErrCode, type PlayerProfile, type ServerMsg,
} from '../../shared/protocol/messages';
import { QuickMatchQueue } from '../matchmaking/QuickMatch';
import { hashSecret, type ProfileStore } from '../persistence/storage';
import type { Conn, PlayerSlot, Room } from '../rooms/Room';
import type { RoomManager } from '../rooms/RoomManager';
import { sanitizeName, validateClientMsg } from '../validation/validate';
import { TokenBucket } from './rateLimit';

type Category = keyof typeof RATE_LIMITS;

function categoryOf(t: ClientMsg['t']): Category {
  switch (t) {
    case C2S.PLAYER_MOVE: case C2S.PING: return 'move';
    case C2S.EMOTE: return 'emote';
    case C2S.CREATE_ROOM: case C2S.JOIN_ROOM: case C2S.QUICK_MATCH: case C2S.PLAY_SOLO: case C2S.RESUME: return 'room';
    case C2S.DEV: return 'dev';
    default: return 'action';
  }
}

/** One per websocket. Identity = profile; room membership = session token. */
class Session implements Conn {
  readonly id: string;
  profile: PlayerProfile | null = null;
  room: Room | null = null;
  player: PlayerSlot | null = null;
  lastAdReward = 0;
  private buckets = Object.fromEntries(
    Object.entries(RATE_LIMITS).map(([k, v]) => [k, new TokenBucket(v.perSec, v.burst)]),
  ) as Record<Category, TokenBucket>;
  private strikes = 0;

  constructor(public ws: WebSocket, public ip: string, n: number) { this.id = `c${n}`; }

  send(msg: ServerMsg) { this.sendRaw(JSON.stringify(msg)); }
  sendRaw(raw: string) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(raw); }
  terminate() { this.ws.terminate(); }
  error(code: ErrCode, msg: string) { this.send({ t: S2C.ERROR, code, msg }); }

  allow(cat: Category): boolean {
    if (this.buckets[cat].take()) return true;
    // Persistent flooding gets the socket closed.
    if (++this.strikes > 200) this.ws.close(1008, 'rate limit');
    return false;
  }
}

export class GameServer {
  private wss: WebSocketServer;
  private queue = new QuickMatchQueue();
  private connSeq = 0;
  private ipCount = new Map<string, number>();

  constructor(
    private rooms: RoomManager,
    private profiles: ProfileStore,
    private opts: { devTools: boolean; allowedOrigins: string[]; maxConnectionsPerIp: number; log: (m: string) => void },
  ) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => this.onConnection(ws, req));
    setInterval(() => this.matchmake(), 500);
    // Heartbeat to detect half-open TCP connections (mobile networks!).
    setInterval(() => {
      for (const ws of this.wss.clients) {
        const w = ws as WebSocket & { alive?: boolean };
        if (w.alive === false) { w.terminate(); continue; }
        w.alive = false;
        w.ping();
      }
    }, 10_000);
  }

  handleUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) {
    const origin = req.headers.origin ?? '';
    if (this.opts.allowedOrigins.length && !this.opts.allowedOrigins.some((o) => origin === o || (o.startsWith('*.') && origin.endsWith(o.slice(1))))) {
      this.opts.log(`rejected origin ${origin}`);
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }

  private clientIp(req: IncomingMessage) {
    const fwd = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim();
    return fwd || req.socket.remoteAddress || '?';
  }

  private onConnection(ws: WebSocket, req: IncomingMessage) {
    const ip = this.clientIp(req);
    const count = (this.ipCount.get(ip) ?? 0) + 1;
    if (count > this.opts.maxConnectionsPerIp) { ws.close(1008, 'too many connections'); return; }
    this.ipCount.set(ip, count);
    const s = new Session(ws, ip, ++this.connSeq);
    (ws as WebSocket & { alive?: boolean }).alive = true;
    ws.on('pong', () => { (ws as WebSocket & { alive?: boolean }).alive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = decode<ClientMsg>(data.toString());
      if (!msg || !validateClientMsg(msg)) { s.error(ERR.BAD_MESSAGE, 'bad message'); return; }
      if (!s.allow(categoryOf(msg.t))) {
        if (msg.t !== C2S.PLAYER_MOVE) s.error(ERR.RATE_LIMITED, 'Слишком часто');
        return;
      }
      try { this.dispatch(s, msg); } catch (e) { this.opts.log(`dispatch error ${msg.t}: ${(e as Error).stack}`); }
    });
    ws.on('close', () => {
      this.ipCount.set(ip, (this.ipCount.get(ip) ?? 1) - 1);
      if (this.ipCount.get(ip)! <= 0) this.ipCount.delete(ip);
      this.queue.remove(s.id);
      // Only the *current* connection of a player triggers the grace period.
      if (s.room && s.player && s.player.conn === s) s.room.onDisconnect(s.player);
    });
  }

  private dispatch(s: Session, m: ClientMsg) {
    if (m.t === C2S.HELLO) return this.hello(s, m);
    if (m.t === C2S.PING) {
      if (s.player) s.player.ping = Math.round(m.rtt);
      return s.send({ t: S2C.PONG, c: m.c, s: Date.now() });
    }
    if (!s.profile) return s.error(ERR.NOT_ALLOWED, 'HELLO first');
    const profile = s.profile;

    switch (m.t) {
      case C2S.CREATE_ROOM: return this.enterNewRoom(s, m.mode, true);
      case C2S.PLAY_SOLO: return this.enterNewRoom(s, 'solo', true, true);
      case C2S.JOIN_ROOM: {
        const room = this.rooms.byCode(m.code);
        if (!room || !room.isPrivate) return s.error(ERR.ROOM_NOT_FOUND, 'Комната не найдена. Проверь код.');
        if (room.status !== 'lobby') return s.error(ERR.ROOM_IN_PROGRESS, 'В этой комнате уже идёт матч');
        if (room.isFull) return s.error(ERR.ROOM_FULL, 'Комната заполнена');
        this.leaveCurrent(s);
        return this.attach(s, room, this.rooms.join(room, s, profile.id, profile.name, profile.hat));
      }
      case C2S.RESUME: {
        const found = this.rooms.byToken(m.token);
        if (!found) return s.error(ERR.BAD_TOKEN, 'Сессия устарела');
        if (found.player.profileId !== profile.id) return s.error(ERR.BAD_TOKEN, 'Чужая сессия');
        s.room = found.room;
        s.player = found.player;
        found.room.resume(found.player, s);
        return s.send({ t: S2C.ROOM_JOINED, token: found.player.token, playerId: found.player.id, room: found.room.snapshot() });
      }
      case C2S.QUICK_MATCH: {
        this.leaveCurrent(s);
        this.queue.enqueue({ conn: s, profileId: profile.id, name: profile.name, since: Date.now() });
        this.opts.log(`quick match: ${profile.name} queued (size ${this.queue.size})`);
        return s.send({ t: S2C.QUEUE_STATUS, searching: true, since: Date.now() });
      }
      case C2S.CANCEL_QUICK_MATCH:
        this.queue.remove(s.id);
        return s.send({ t: S2C.QUEUE_STATUS, searching: false, since: 0 });
      case C2S.GET_LEADERBOARD:
        return s.send({ t: S2C.LEADERBOARD, entries: this.profiles.top(20).map((p) => ({ name: p.name, wins: p.wins, rating: p.rating })) });
      case C2S.BUY_COSMETIC: {
        const item = COSMETICS.find((c) => c.id === m.id)!;
        if (profile.hats.includes(m.id)) return s.error(ERR.MAXED, 'Уже куплено');
        if (profile.coins < item.price) return s.error(ERR.NOT_ENOUGH_MONEY, 'Недостаточно монет');
        profile.coins -= item.price;
        profile.hats.push(m.id);
        profile.hat = m.id;
        return this.saveProfile(s);
      }
      case C2S.SET_COSMETIC:
        if (!profile.hats.includes(m.id)) return s.error(ERR.LOCKED, 'Сначала купи');
        profile.hat = m.id;
        if (s.player && s.room?.status === 'lobby') { s.player.hat = m.id as CosmeticId; s.room.broadcastState(); }
        return this.saveProfile(s);
      case C2S.AD_REWARD: {
        // Rewarded ads only grant cosmetic coins and never inside a VS match (fairness).
        if (s.room && s.room.mode === 'vs' && (s.room.status === 'playing' || s.room.status === 'countdown')) {
          return s.error(ERR.NOT_ALLOWED, 'Реклама недоступна во время VS матча');
        }
        if (Date.now() - s.lastAdReward < 30_000) return s.error(ERR.RATE_LIMITED, 'Попробуй позже');
        s.lastAdReward = Date.now();
        profile.coins += REWARDS.ad;
        s.send({ t: S2C.TOAST, text: `+${REWARDS.ad} 🪙`, kind: 'good' });
        return this.saveProfile(s);
      }
    }

    // ----- everything below requires room membership -----
    const room = s.room, p = s.player;
    if (!room || !p || p.conn !== s || !room.players.has(p.id)) return s.error(ERR.NOT_IN_ROOM, 'Ты не в комнате');
    let r: { ok: boolean; code?: ErrCode; msg?: string } = { ok: true };
    switch (m.t) {
      case C2S.SET_MODE: r = room.setMode(p, m.mode); break;
      case C2S.PLAYER_READY: r = room.setReady(p, m.ready); break;
      case C2S.START_MATCH: r = room.start(); break;
      case C2S.PLAYER_MOVE: room.move(p, m.p); break;
      case C2S.BUY_UPGRADE: r = room.buyUpgrade(p, m.id); break;
      case C2S.HIRE_WORKER: r = room.hireWorker(p, m.id); break;
      case C2S.BUILD_BUSINESS: r = room.build(p, m.kind, m.id); break;
      case C2S.BUILD_MEGA_MALL: r = room.buildMegaMall(p); break;
      case C2S.INTERACT: r = room.interact(p, m.target); break;
      case C2S.EMOTE: room.emote(p, m.e); break;
      case C2S.REMATCH: r = room.rematch(p); break;
      case C2S.LEAVE: this.leaveCurrent(s); break;
      case C2S.DEV:
        if (!this.opts.devTools) r = { ok: false, code: ERR.DEV_DISABLED, msg: 'Dev tools disabled' };
        else r = room.dev(p, m.cmd, m.arg);
        break;
    }
    if (!r.ok) s.error(r.code!, r.msg!);
  }

  private hello(s: Session, m: Extract<ClientMsg, { t: 'HELLO' }>) {
    if (m.v !== PROTOCOL_VERSION) return s.error(ERR.BAD_MESSAGE, 'Обнови игру (версия протокола)');
    let secret = m.secret ?? '';
    let rec = m.profileId ? this.profiles.get(m.profileId) : undefined;
    if (!rec || rec.secretHash !== hashSecret(secret)) {
      const created = this.profiles.create(sanitizeName(m.name));
      rec = created.record;
      secret = created.secret;
    }
    if (m.name) rec.profile.name = sanitizeName(m.name);
    s.profile = rec.profile;
    s.send({ t: S2C.WELCOME, serverTime: Date.now(), devTools: this.opts.devTools, profile: rec.profile, secret });
  }

  private saveProfile(s: Session) {
    this.profiles.save(s.profile!);
    s.send({ t: S2C.PROFILE, profile: s.profile! });
  }

  private enterNewRoom(s: Session, mode: 'vs' | 'coop' | 'solo', isPrivate: boolean, autoStart = false) {
    if (!this.rooms.canCreate()) return s.error(ERR.NOT_ALLOWED, 'Сервер перегружен, попробуй позже');
    this.leaveCurrent(s);
    const room = this.rooms.create(mode, isPrivate);
    const p = this.rooms.join(room, s, s.profile!.id, s.profile!.name, s.profile!.hat);
    this.attach(s, room, p);
    if (autoStart) { room.setReady(p, true); room.start(); }
  }

  private attach(s: Session, room: Room, p: PlayerSlot) {
    s.room = room;
    s.player = p;
    s.send({ t: S2C.ROOM_JOINED, token: p.token, playerId: p.id, room: room.snapshot() });
  }

  private leaveCurrent(s: Session) {
    this.queue.remove(s.id);
    if (s.room && s.player && s.room.players.has(s.player.id)) this.rooms.leave(s.room, s.player, 'leave');
    s.room = null;
    s.player = null;
  }

  private matchmake() {
    for (;;) {
      const pair = this.queue.takePair((e) => (e.conn as Session).ws.readyState === WebSocket.OPEN);
      if (!pair) return;
      const room = this.rooms.create('vs', false);
      for (const e of pair) {
        const s = e.conn as Session;
        this.attach(s, room, this.rooms.join(room, s, s.profile!.id, s.profile!.name, s.profile!.hat));
        s.send({ t: S2C.QUEUE_STATUS, searching: false, since: 0 });
      }
      this.opts.log(`quick match: paired ${pair[0].name} vs ${pair[1].name} in ${room.code}`);
    }
  }

  get stats() {
    return { connections: this.wss.clients.size, rooms: this.rooms.rooms.size, queue: this.queue.size, tickHz: MATCH.serverTickHz };
  }
}
