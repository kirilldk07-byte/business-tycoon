// Offline balance check: runs the real server BusinessSim with a payback-driven bot
// and prints the match timeline (when the bot reaches each milestone).
//   npx tsx scripts/balance.ts
import {
  COOP_GOAL, MATCH, STRUCTURE_IDS, UPGRADE_IDS, VENUE_IDS, VENUES, WORKER_IDS,
} from '../shared/constants/config';
import {
  checkStructure, checkTier, checkUpgrade, checkVenue, checkWorker, emptyBusiness, formatMoney, incomePerMinute,
  megaMallMissing, NO_MODS,
} from '../shared/game/economy';
import type { BusinessState } from '../shared/types/state';
import { BusinessSim } from '../server/game/BusinessSim';

const noop = { spawn() {}, paid() {}, left() {}, delivery() {} };
type Opt = { name: string; cost: number; apply: (b: BusinessState) => void; cat: 'spentBuilding' | 'spentStructure' | 'spentUpgrade' | 'spentWorker' | 'spentVenue' };

function options(b: BusinessState): Opt[] {
  const o: Opt[] = [];
  const t = checkTier(b); if (t.ok) o.push({ name: `HQ${b.tier + 1}`, cost: t.cost, cat: 'spentBuilding', apply: (x) => { x.tier++; } });
  for (const id of UPGRADE_IDS) { const c = checkUpgrade(b, id); if (c.ok) o.push({ name: id, cost: c.cost, cat: 'spentUpgrade', apply: (x) => { x.upgrades[id]++; } }); }
  for (const id of WORKER_IDS) { const c = checkWorker(b, id); if (c.ok) o.push({ name: id, cost: c.cost, cat: 'spentWorker', apply: (x) => { x.workers[id]++; } }); }
  for (const id of VENUE_IDS) { const c = checkVenue(b, id); if (c.ok) o.push({ name: `${id}${b.venues[id] ? '+' : ''}`, cost: c.cost, cat: 'spentVenue', apply: (x) => { x.venues[id]++; } }); }
  for (const id of STRUCTURE_IDS) { const c = checkStructure(b, id); if (c.ok) o.push({ name: id, cost: c.cost, cat: 'spentStructure', apply: (x) => { x.structures.push(id); } }); }
  return o;
}

function run(minutes: number, manualPerSec: number, label: string, coop = false) {
  let seq = 1;
  const sim = new BusinessSim(emptyBusiness(0, 0, ['a'], MATCH.startCash), () => seq++);
  const b = sim.b;
  let t = 0;
  const step = 100;
  let megaAt = -1;
  const milestones: string[] = [];
  const mark = (what: string) => milestones.push(`${(t / 60000).toFixed(1).padStart(4)}m  ${what}`);
  const seen = new Set<string>();
  while (t < minutes * 60_000) {
    t += step;
    sim.step(step, t, NO_MODS, noop);
    if (Math.random() < (manualPerSec * step) / 1000) {
      if (b.stock < 3) sim.manualProduce(NO_MODS); else sim.manualServe(NO_MODS, noop, t);
    }
    if (t % 1000 !== 0) continue;
    if (megaAt < 0 && megaMallMissing(b).length === 0) { megaAt = t; mark('MEGA MALL affordable'); }
    if (coop && megaMallMissing(b).every((m) => m.startsWith('$'))) continue; // save up
    if (coop && b.tier >= COOP_GOAL.minTier) {
      // Team focuses on the mandatory Mega Mall upgrades once the HQ is big enough.
      const need = Object.entries(COOP_GOAL.minUpgrades).find(([k, v]) => b.upgrades[k as keyof typeof b.upgrades] < (v ?? 0));
      if (need) {
        const id = need[0] as keyof typeof b.upgrades;
        const c = checkUpgrade(b, id);
        if (c.ok) { sim.spend(c.cost, 'spentUpgrade'); b.upgrades[id]++; }
        continue;
      }
    }
    // Payback-driven choice: best Δincome per $ (HQ tiers also add value/prestige).
    const base = incomePerMinute(b);
    let best: Opt | null = null, bestScore = 0;
    for (const o of options(b)) {
      const clone: BusinessState = JSON.parse(JSON.stringify(b));
      o.apply(clone);
      const gain = incomePerMinute(clone) - base;
      const score = (gain + (o.cat === 'spentBuilding' ? o.cost * 0.02 : 0)) / o.cost;
      if (score > bestScore) { bestScore = score; best = o; }
    }
    if (best) {
      sim.spend(best.cost, best.cat);
      best.apply(b);
      const key = best.name.replace(/\+$/, '');
      if (!seen.has(key) && (key.startsWith('HQ') || VENUE_IDS.includes(key as never) || WORKER_IDS.includes(key as never))) {
        seen.add(key);
        mark(`${key.startsWith('HQ') ? 'HQ tier ' + b.tier : VENUE_IDS.includes(key as never) ? VENUES[key as keyof typeof VENUES].name : 'hire ' + key}  ($${formatMoney(best.cost)}, value $${formatMoney(sim.b.value)}, $${formatMoney(incomePerMinute(b))}/min)`);
      }
    }
  }
  sim.refreshValue();
  console.log(`\n=== ${label}`);
  console.log(milestones.join('\n'));
  console.log(`  FINAL value $${formatMoney(b.value)} · HQ ${b.tier} · venues ${Object.values(b.venues).filter(Boolean).length} · $${formatMoney(incomePerMinute(b))}/min${coop ? ` · Mega Mall ($${formatMoney(COOP_GOAL.cost)}) ${megaAt >= 0 ? `at ${(megaAt / 60000).toFixed(1)} min` : 'NOT reached'}` : ''}`);
  return b.value;
}

run(10, 0.6, 'VS — active player');
run(10, 0.1, 'VS — passive player');
run(18, 1.0, 'coop — 2 active players, 18 min', true);
run(18, 0.4, 'solo — 1 player, 18 min', true);
