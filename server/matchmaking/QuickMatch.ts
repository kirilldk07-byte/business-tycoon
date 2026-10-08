import type { Conn } from '../rooms/Room';

export interface QueueEntry { conn: Conn; profileId: string; name: string; since: number }

/** Simple FIFO matchmaking. Pairs the first two live entries. */
export class QuickMatchQueue {
  private queue: QueueEntry[] = [];

  enqueue(e: QueueEntry) {
    this.remove(e.conn.id);
    this.queue.push(e);
  }

  remove(connId: string) {
    this.queue = this.queue.filter((q) => q.conn.id !== connId);
  }

  has(connId: string) { return this.queue.some((q) => q.conn.id === connId); }

  /** Returns a pair to put in one room, or null. */
  takePair(isAlive: (e: QueueEntry) => boolean): [QueueEntry, QueueEntry] | null {
    this.queue = this.queue.filter(isAlive);
    if (this.queue.length < 2) return null;
    const a = this.queue.shift()!;
    const b = this.queue.shift()!;
    return [a, b];
  }

  get size() { return this.queue.length; }
}
