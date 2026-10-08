import { decode, encode } from '../../../shared/protocol/codec';
import {
  C2S, PROTOCOL_VERSION, S2C, type ClientMsg, type PlayerProfile, type ServerMsg, type ServerMsgOf,
} from '../../../shared/protocol/messages';
import { CLIENT } from '../config/client';
import { LocalStore } from '../platform/LocalStore';

type Handler<T extends ServerMsg['t']> = (m: ServerMsgOf<T>) => void;
export type NetStatus = 'connecting' | 'online' | 'reconnecting' | 'offline';

/**
 * WebSocket client: auto-reconnect with backoff, session resume by token,
 * clock sync against the server (all timers use serverNow()), RTT tracking
 * and optional artificial latency for testing.
 */
export class Net {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<(m: ServerMsg) => void>>();
  private statusHandlers = new Set<(s: NetStatus) => void>();
  private attemptHandlers = new Set<() => void>();
  /** Reconnect attempts since the connection was lost (for the UI). */
  attempts = 0;
  private attempt = 0;
  private pingTimer = 0;
  private offsetSamples: { rtt: number; off: number }[] = [];
  private blockedUntil = 0;
  status: NetStatus = 'connecting';
  offset = 0; // serverTime - Date.now()
  rtt = 0;
  profile: PlayerProfile | null = null;
  devTools = false;
  simLatencyMs = 0; // one-way, dev only
  sessionToken: string | null = null;
  playerId: string | null = null;
  welcomed = false;

  constructor(public url = CLIENT.wsUrl, private nameProvider: () => string) {
    const s = LocalStore.get().session;
    // Recent session (page reload / app re-open within the grace window) → resume.
    if (s && Date.now() - s.at < 60_000) this.sessionToken = s.token;
  }

  serverNow() { return Date.now() + this.offset; }

  connect() {
    if (Date.now() < this.blockedUntil) { this.scheduleReconnect(); return; }
    this.setStatus(this.attempt === 0 && !this.welcomed ? 'connecting' : 'reconnecting');
    let ws: WebSocket;
    try { ws = new WebSocket(this.url); } catch { this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.attempts = 0;
      const saved = LocalStore.get();
      this.send({ t: C2S.HELLO, v: PROTOCOL_VERSION, profileId: saved.profileId, secret: saved.secret, name: this.nameProvider() });
      this.startPing();
    };
    ws.onmessage = (ev) => {
      const m = decode<ServerMsg>(typeof ev.data === 'string' ? ev.data : '');
      if (!m) return;
      if (this.simLatencyMs > 0) setTimeout(() => this.receive(m), this.simLatencyMs);
      else this.receive(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      this.scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private scheduleReconnect() {
    this.setStatus(this.welcomed ? 'reconnecting' : 'offline');
    const delay = Math.min(5000, 400 * Math.pow(1.7, this.attempt++));
    this.attempts++;
    this.attemptHandlers.forEach((h) => h());
    setTimeout(() => this.connect(), Math.max(delay, this.blockedUntil - Date.now()));
  }

  private receive(m: ServerMsg) {
    switch (m.t) {
      case S2C.WELCOME:
        this.profile = m.profile;
        this.devTools = m.devTools;
        this.offset = m.serverTime - Date.now();
        LocalStore.set({ profileId: m.profile.id, secret: m.secret });
        this.welcomed = true;
        this.setStatus('online');
        if (this.sessionToken) this.send({ t: C2S.RESUME, token: this.sessionToken });
        break;
      case S2C.PROFILE: this.profile = m.profile; break;
      case S2C.ROOM_JOINED:
        this.sessionToken = m.token;
        this.playerId = m.playerId;
        LocalStore.set({ session: { token: m.token, at: Date.now() } });
        break;
      case S2C.ROOM_LEFT: this.clearSession(); break;
      case S2C.ERROR: if (m.code === 'BAD_TOKEN') this.clearSession(); break;
      case S2C.PONG: this.onPong(m.c, m.s); break;
    }
    this.handlers.get(m.t)?.forEach((h) => h(m));
  }

  clearSession() {
    this.sessionToken = null;
    this.playerId = null;
    LocalStore.set({ session: undefined });
  }

  /** Keep the stored session fresh so a reload can resume. */
  touchSession() {
    if (this.sessionToken) LocalStore.set({ session: { token: this.sessionToken, at: Date.now() } });
  }

  private startPing() {
    clearInterval(this.pingTimer);
    const ping = () => this.send({ t: C2S.PING, c: Date.now(), rtt: this.rtt });
    ping();
    this.pingTimer = window.setInterval(() => { ping(); this.touchSession(); }, CLIENT.pingIntervalMs);
  }

  private onPong(c: number, s: number) {
    const now = Date.now();
    const rtt = now - c;
    this.rtt = this.rtt ? this.rtt * 0.7 + rtt * 0.3 : rtt;
    // NTP-style: trust the samples with the lowest RTT.
    this.offsetSamples.push({ rtt, off: s + rtt / 2 - now });
    if (this.offsetSamples.length > 10) this.offsetSamples.shift();
    const best = [...this.offsetSamples].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
    const target = best.reduce((acc, x) => acc + x.off, 0) / best.length;
    // Slew instead of jumping so timers don't stutter.
    this.offset = Math.abs(target - this.offset) > 1000 ? target : this.offset * 0.8 + target * 0.2;
  }

  send(m: ClientMsg): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const raw = encode(m);
    if (this.simLatencyMs > 0) setTimeout(() => ws.readyState === WebSocket.OPEN && ws.send(raw), this.simLatencyMs);
    else ws.send(raw);
    return true;
  }

  get isOpen() { return this.ws?.readyState === WebSocket.OPEN && this.welcomed; }

  on<T extends ServerMsg['t']>(t: T, h: Handler<T>) {
    if (!this.handlers.has(t)) this.handlers.set(t, new Set());
    this.handlers.get(t)!.add(h as (m: ServerMsg) => void);
    return () => this.handlers.get(t)!.delete(h as (m: ServerMsg) => void);
  }

  onStatus(h: (s: NetStatus) => void) { this.statusHandlers.add(h); }
  onAttempt(h: () => void) { this.attemptHandlers.add(h); }
  private setStatus(s: NetStatus) {
    if (s === this.status) return;
    this.status = s;
    this.statusHandlers.forEach((h) => h(s));
  }

  // ---- dev helpers ----
  /** Artificial one-way latency applied to both send and receive. */
  simulateLatency(ms: string | number) { this.simLatencyMs = Math.max(0, Number(ms) || 0); }

  /** Simulate a network drop: kill the socket, optionally stay offline for a while. */
  simulateDisconnect(offlineMs = 0) {
    this.blockedUntil = Date.now() + offlineMs;
    this.ws?.close();
  }
}
