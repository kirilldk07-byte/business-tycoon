/** Classic token bucket. One instance per (connection, category). */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(private perSec: number, private burst: number) { this.tokens = burst; }
  take(n = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSec);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}
