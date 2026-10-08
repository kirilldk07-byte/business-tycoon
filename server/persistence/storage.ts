import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RATING } from '../../shared/constants/config';
import type { PlayerProfile } from '../../shared/protocol/messages';

// Storage layer is separated from room logic behind interfaces. MVP uses JSON
// files; swap for Redis/Postgres implementations without touching rooms/.

export interface ProfileRecord { profile: PlayerProfile; secretHash: string }

export interface ProfileStore {
  get(id: string): ProfileRecord | undefined;
  create(name: string): { record: ProfileRecord; secret: string };
  save(profile: PlayerProfile): void;
  top(n: number): PlayerProfile[];
}

/** Opaque serialized room used for crash/restart recovery. */
export interface RoomStore {
  saveAll(rooms: unknown[]): void;
  loadAll(): unknown[];
}

export const hashSecret = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('hex');

class JsonFile<T> {
  private timer: NodeJS.Timeout | null = null;
  constructor(private file: string, private fallback: T) {}
  read(): T {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) as T; } catch { return this.fallback; }
  }
  /** Atomic write (tmp + rename) so a crash mid-write can't corrupt data. */
  writeNow(data: T) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.file);
  }
  writeSoon(get: () => T, delay = 1000) {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.writeNow(get()); }, delay);
  }
}

export class FileProfileStore implements ProfileStore {
  private file: JsonFile<Record<string, ProfileRecord>>;
  private data: Record<string, ProfileRecord>;
  constructor(dir: string) {
    this.file = new JsonFile(path.join(dir, 'profiles.json'), {});
    this.data = this.file.read();
  }
  get(id: string) {
    const r = this.data[id];
    if (r && !r.profile.achievements) r.profile.achievements = []; // migrate old profiles
    return r;
  }
  create(name: string) {
    const secret = randomToken(16);
    const profile: PlayerProfile = {
      id: 'p_' + randomToken(8), name, wins: 0, losses: 0, coopWins: 0, rating: RATING.start,
      coins: 0, hats: ['none', 'cap'], hat: 'cap', gamesPlayed: 0, achievements: [],
    };
    const record = { profile, secretHash: hashSecret(secret) };
    this.data[profile.id] = record;
    this.persist();
    return { record, secret };
  }
  save(profile: PlayerProfile) {
    const r = this.data[profile.id];
    if (r) { r.profile = profile; this.persist(); }
  }
  top(n: number) {
    return Object.values(this.data).map((r) => r.profile)
      .filter((p) => p.gamesPlayed > 0)
      .sort((a, b) => b.wins - a.wins || b.rating - a.rating).slice(0, n);
  }
  private persist() { this.file.writeSoon(() => this.data); }
}

export class FileRoomStore implements RoomStore {
  private file: JsonFile<unknown[]>;
  constructor(dir: string) { this.file = new JsonFile(path.join(dir, 'rooms.json'), []); }
  saveAll(rooms: unknown[]) { this.file.writeNow(rooms); }
  loadAll() { return this.file.read(); }
}
