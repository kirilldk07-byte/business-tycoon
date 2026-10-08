import { ECONOMY, EVENTS, VENUE_IDS } from '../../shared/constants/config';
import { CUSTOMER_KIND } from '../../shared/events';
import { businessValue, computeRates, venueRates, type Modifiers } from '../../shared/game/economy';
import { sideForVenue, walkMs } from '../../shared/game/paths';
import type { BusinessState, BusinessTick } from '../../shared/types/state';

export interface SimEmitter {
  spawn(b: number, id: number, dest: number, kind: number, arrive: number, side: number): void;
  paid(b: number, id: number, amt: number): void;
  left(b: number, id: number): void;
  delivery(b: number, amt: number): void;
}

interface Walking { id: number; dest: number; arrive: number; kind: number; reward: number }
interface Queued { id: number; kind: number; arrivedAt: number; reward: number }

const BUCKET_MS = 5_000;
const BUCKETS = 12; // 60 s window

/**
 * Authoritative per-business economy simulation. All income happens here;
 * purchases go through spend(). Flagship = manual counter + production;
 * venues = automated businesses whose customers pay when they reach the door.
 */
export class BusinessSim {
  private spawnAcc = 0;
  private serviceAcc = 0;
  private deliveryAcc = 0;
  private venueAcc = new Map<number, number>();
  private walking: Walking[] = [];
  private queue: Queued[] = [];
  private buckets: number[] = new Array(BUCKETS).fill(0);
  private bucketStart = 0;
  private bucketIdx = 0;

  constructor(public b: BusinessState, private nextId: () => number) {}

  private earn(amt: number, now: number) {
    this.b.cash += amt;
    this.b.stats.income += amt;
    this.rollBuckets(now);
    this.buckets[this.bucketIdx] += amt;
  }

  private rollBuckets(now: number) {
    if (!this.bucketStart) this.bucketStart = now;
    while (now - this.bucketStart >= BUCKET_MS) {
      this.bucketStart += BUCKET_MS;
      this.bucketIdx = (this.bucketIdx + 1) % BUCKETS;
      this.buckets[this.bucketIdx] = 0;
    }
  }

  /** Income over the last 60 s. */
  ipm(now: number) {
    this.rollBuckets(now);
    return Math.round(this.buckets.reduce((a, x) => a + x, 0));
  }

  step(dtMs: number, now: number, baseMods: Modifiers, emit: SimEmitter) {
    const b = this.b;
    const mods = b.boostUntil > now ? { ...baseMods, productionMult: baseMods.productionMult * EVENTS.deliveryBoostMult } : baseMods;
    const r = computeRates(b, mods);
    const dt = dtMs / 1000;

    // Flagship customers
    this.spawnAcc += r.spawnRate * dt;
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      if (this.flagshipLoad() < r.capacity) this.spawnCustomer(now, CUSTOMER_KIND.normal, emit);
    }
    // Venue customers (automated businesses)
    VENUE_IDS.forEach((vid, idx) => {
      const v = venueRates(b, vid, r);
      if (!v.rate) return;
      let acc = (this.venueAcc.get(idx) ?? 0) + v.rate * dt;
      while (acc >= 1) {
        acc -= 1;
        const inFlight = this.walking.filter((w) => w.dest === idx).length;
        if (inFlight < v.cap) {
          const id = this.nextId();
          const side = sideForVenue(idx);
          const arrive = now + walkMs(idx, side);
          this.walking.push({ id, dest: idx, arrive, kind: CUSTOMER_KIND.normal, reward: v.price });
          emit.spawn(b.id, id, idx, CUSTOMER_KIND.normal, arrive, side);
        }
      }
      this.venueAcc.set(idx, acc);
    });

    // Arrivals: venue customers pay at the door; flagship customers queue.
    for (let i = this.walking.length - 1; i >= 0; i--) {
      const w = this.walking[i];
      if (w.arrive > now) continue;
      this.walking.splice(i, 1);
      if (w.dest >= 0) {
        this.earn(w.reward, now);
        b.stats.customers += 1;
        emit.paid(b.id, w.id, w.reward);
      } else {
        this.queue.push({ id: w.id, kind: w.kind, arrivedAt: now, reward: w.reward });
      }
    }

    // Impatient customers leave (golden/VIP wait forever).
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i];
      if (q.kind === CUSTOMER_KIND.normal && now - q.arrivedAt > ECONOMY.patienceMs) {
        this.queue.splice(i, 1);
        emit.left(b.id, q.id);
      }
    }

    if (b.tier >= 1) b.stock = Math.min(r.stockCap, b.stock + r.production * dt);

    // Automatic counter service
    if (this.queue.length > 0 && b.stock >= 1) {
      this.serviceAcc += r.serviceRate * dt;
      while (this.serviceAcc >= 1 && this.queue.length > 0 && b.stock >= 1) {
        this.serviceAcc -= 1;
        this.serveFront(r.price, emit, now);
      }
    } else {
      this.serviceAcc = Math.min(this.serviceAcc, 1);
    }

    // Delivery workers sell stock off-site.
    if (b.workers.delivery > 0 && !mods.halted) {
      this.deliveryAcc += dtMs;
      if (this.deliveryAcc >= ECONOMY.deliveryIntervalMs) {
        this.deliveryAcc = 0;
        const units = Math.min(Math.floor(b.stock), 2 * b.workers.delivery);
        if (units > 0) {
          const amt = Math.round(units * r.price * 1.5);
          b.stock -= units;
          this.earn(amt, now);
          emit.delivery(b.id, amt);
        }
      }
    }
    b.queue = this.queue.length;
    const ipm = this.ipm(now);
    if (ipm > b.stats.peakIncome) b.stats.peakIncome = ipm;
  }

  /** Queue pressure: waiting customers count fully, ones still walking count half (long walk ≠ full queue). */
  private flagshipLoad() {
    return this.walking.filter((w) => w.dest < 0).length * 0.5 + this.queue.length;
  }

  /** Spawn a flagship customer. reward overrides the price (VIP flat reward). */
  spawnCustomer(now: number, kind: number, emit: SimEmitter, reward = 0) {
    if (this.b.tier < 1) return;
    const id = this.nextId();
    const side = Math.random() < 0.5 ? 0 : 1;
    const arrive = now + walkMs(-1, side);
    this.walking.push({ id, dest: -1, arrive, kind, reward });
    emit.spawn(this.b.id, id, -1, kind, arrive, side);
  }

  /** Manual serve by a player at the counter. Returns true if someone was served. */
  manualServe(mods: Modifiers, emit: SimEmitter, now: number): boolean {
    if (this.queue.length === 0 || this.b.stock < 1) return false;
    this.serveFront(computeRates(this.b, mods).price, emit, now);
    this.b.queue = this.queue.length;
    return true;
  }

  manualProduce(mods: Modifiers): number {
    const r = computeRates(this.b, mods);
    const before = this.b.stock;
    this.b.stock = Math.min(r.stockCap, this.b.stock + r.manualProduce);
    return this.b.stock - before;
  }

  private serveFront(price: number, emit: SimEmitter, now: number) {
    const q = this.queue.shift()!;
    const amt = q.kind === CUSTOMER_KIND.vip ? q.reward : q.kind === CUSTOMER_KIND.golden ? price * ECONOMY.goldenPriceMult : price;
    this.b.stock -= 1;
    this.b.stats.customers += 1;
    this.earn(amt, now);
    emit.paid(this.b.id, q.id, amt);
  }

  /** Spend money authoritatively. Caller has already validated. */
  spend(cost: number, category: 'spentBuilding' | 'spentStructure' | 'spentUpgrade' | 'spentWorker' | 'spentVenue') {
    this.b.cash -= cost;
    this.b.stats[category] += cost;
    this.refreshValue();
  }

  refreshValue() { this.b.value = businessValue(this.b); }

  tick(now: number): BusinessTick {
    this.refreshValue();
    const b = this.b;
    return { id: b.id, cash: Math.floor(b.cash), stock: Math.floor(b.stock), queue: b.queue, value: b.value, customers: b.stats.customers, ipm: this.ipm(now) };
  }

  /** Customers in flight are not persisted; restored sims start with empty queues. */
  resetCustomers() { this.walking = []; this.queue = []; this.b.queue = 0; }
}
