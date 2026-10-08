import { ECONOMY } from '../../shared/constants/config';
import { businessValue, computeRates, type Modifiers } from '../../shared/game/economy';
import type { BusinessState, BusinessTick } from '../../shared/types/state';

export interface SimEmitter {
  spawn(b: number, id: number, golden: boolean, arrive: number, side: number): void;
  served(b: number, id: number, amt: number, by?: string): void;
  left(b: number, id: number): void;
  delivery(b: number, amt: number): void;
}

interface Walking { id: number; arrive: number; golden: boolean }
interface Queued { id: number; golden: boolean; arrivedAt: number }

/** Authoritative per-business economy simulation. All money changes happen here or in Room purchases. */
export class BusinessSim {
  private spawnAcc = 0;
  private serviceAcc = 0;
  private deliveryAcc = 0;
  private walking: Walking[] = [];
  private queue: Queued[] = [];

  constructor(public b: BusinessState, private nextId: () => number) {}

  step(dtMs: number, now: number, mods: Modifiers, emit: SimEmitter) {
    const b = this.b;
    const r = computeRates(b, mods);
    const dt = dtMs / 1000;

    // Spawn customers (they walk to the counter for walkTimeMs).
    this.spawnAcc += r.spawnRate * dt;
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      if (this.walking.length + this.queue.length < r.capacity) this.spawnCustomer(now, false, emit);
    }

    // Arrivals join the queue.
    for (let i = this.walking.length - 1; i >= 0; i--) {
      const w = this.walking[i];
      if (w.arrive <= now) {
        this.walking.splice(i, 1);
        this.queue.push({ id: w.id, golden: w.golden, arrivedAt: now });
      }
    }

    // Impatient customers leave without paying (golden ones wait forever).
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i];
      if (!q.golden && now - q.arrivedAt > ECONOMY.patienceMs) {
        this.queue.splice(i, 1);
        emit.left(b.id, q.id);
      }
    }

    // Production.
    b.stock = Math.min(r.stockCap, b.stock + r.production * dt);

    // Automatic service.
    if (this.queue.length > 0 && b.stock >= 1) {
      this.serviceAcc += r.serviceRate * dt;
      while (this.serviceAcc >= 1 && this.queue.length > 0 && b.stock >= 1) {
        this.serviceAcc -= 1;
        this.serveFront(r.price, emit);
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
          b.cash += amt;
          b.stats.income += amt;
          emit.delivery(b.id, amt);
        }
      }
    }
    b.queue = this.queue.length;
  }

  spawnCustomer(now: number, golden: boolean, emit: SimEmitter) {
    const id = this.nextId();
    const arrive = now + ECONOMY.walkTimeMs;
    this.walking.push({ id, arrive, golden });
    emit.spawn(this.b.id, id, golden, arrive, Math.random() < 0.5 ? 0 : 1);
  }

  /** Manual serve by a player at the counter. Returns true if someone was served. */
  manualServe(mods: Modifiers, emit: SimEmitter, by: string): boolean {
    if (this.queue.length === 0 || this.b.stock < 1) return false;
    this.serveFront(computeRates(this.b, mods).price, emit, by);
    this.b.queue = this.queue.length;
    return true;
  }

  manualProduce(mods: Modifiers): number {
    const r = computeRates(this.b, mods);
    const before = this.b.stock;
    this.b.stock = Math.min(r.stockCap, this.b.stock + r.manualProduce);
    return this.b.stock - before;
  }

  private serveFront(price: number, emit: SimEmitter, by?: string) {
    const q = this.queue.shift()!;
    const amt = q.golden ? price * ECONOMY.goldenPriceMult : price;
    this.b.stock -= 1;
    this.b.cash += amt;
    this.b.stats.customers += 1;
    this.b.stats.income += amt;
    emit.served(this.b.id, q.id, amt, by);
  }

  /** Spend money authoritatively. Caller has already validated. */
  spend(cost: number, category: 'spentBuilding' | 'spentStructure' | 'spentUpgrade' | 'spentWorker') {
    this.b.cash -= cost;
    this.b.stats[category] += cost;
    this.refreshValue();
  }

  refreshValue() { this.b.value = businessValue(this.b); }

  tick(): BusinessTick {
    this.refreshValue();
    const b = this.b;
    return { id: b.id, cash: Math.floor(b.cash), stock: Math.floor(b.stock), queue: b.queue, value: b.value, customers: b.stats.customers };
  }

  /** Customers in flight are not persisted; restored sims start with empty queues. */
  resetCustomers() { this.walking = []; this.queue = []; this.b.queue = 0; }
}
