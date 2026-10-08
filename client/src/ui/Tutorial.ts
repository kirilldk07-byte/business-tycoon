import type { BusinessState, GameMode } from '../../../shared/types/state';
import { isTouch } from '../config/client';
import { LocalStore } from '../platform/LocalStore';

const KEY = isTouch ? 'зелёную кнопку E' : 'E';

// First-match tutorial: short hints driven by the real (server) business
// state — no long modal windows. Returns the hint and which pad to point at.

export interface TutorialStep { text: string; sub?: string; pad: string | null }

type Stage = 'pad' | 'customers' | 'upgrade' | 'beat' | 'done';

export class Tutorial {
  private stage: Stage;
  private stageAt = performance.now();
  private startCustomers = 0;

  constructor() {
    this.stage = LocalStore.get().tutorialDone ? 'done' : 'pad';
  }

  get active() { return this.stage !== 'done'; }

  reset() { if (!LocalStore.get().tutorialDone) { this.stage = 'pad'; this.stageAt = performance.now(); } }

  private go(s: Stage) {
    this.stage = s;
    this.stageAt = performance.now();
    if (s === 'done') LocalStore.set({ tutorialDone: true });
  }

  step(b: BusinessState | undefined, mode: GameMode): TutorialStep | null {
    if (!b || this.stage === 'done') return null;
    const age = performance.now() - this.stageAt;
    const upgrades = Object.values(b.upgrades).reduce((a, x) => a + x, 0) + Object.values(b.workers).reduce((a, x) => a + x, 0);
    switch (this.stage) {
      case 'pad':
        if (b.tier >= 1) { this.startCustomers = b.stats.customers; this.go('customers'); return this.step(b, mode); }
        return { text: '👇 Иди к зелёной площадке', sub: `Встань на неё и нажми ${KEY}: КУПИ ПЕРВЫЙ БИЗНЕС`, pad: 'hq' };
      case 'customers':
        if (b.stats.customers - this.startCustomers >= 3 || age > 25_000) { this.go('upgrade'); return this.step(b, mode); }
        return { text: '💰 Клиенты приносят деньги!', sub: `Обслуживай у кассы (${KEY}) и делай товар у машины`, pad: null };
      case 'upgrade':
        if (upgrades > 0) { this.go('beat'); return this.step(b, mode); }
        return { text: '⬆️ УЛУЧШИ БИЗНЕС', sub: 'Площадка UPGRADE SHOP или кнопка «Бизнес»: найми кассира или подними цену', pad: b.workers.cashier === 0 ? 'hire:cashier' : 'upgrades' };
      case 'beat':
        if (age > 6000) { this.go('done'); return null; }
        return mode === 'vs'
          ? { text: '🏆 Обгони соперника!', sub: 'Открывай новые бизнесы — у кого выше BUSINESS VALUE, тот победил', pad: null }
          : { text: '🤝 СТРОЙТЕ БИЗНЕС ВМЕСТЕ!', sub: 'Общая касса. Цель — MEGA MALL', pad: null };
    }
    return null;
  }
}
