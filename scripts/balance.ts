// Offline balance check: runs the real server BusinessSim with a greedy bot.
//   npx tsx scripts/balance.ts
import { COOP_GOAL, MATCH, STRUCTURE_IDS, UPGRADE_IDS, WORKER_IDS } from '../shared/constants/config';
import {
  checkStructure, checkTier, checkUpgrade, checkWorker, emptyBusiness, megaMallMissing, NO_MODS, formatMoney,
} from '../shared/game/economy';
import { BusinessSim } from '../server/game/BusinessSim';

const noop = { spawn() {}, paid() {}, left() {}, delivery() {} };

function run(minutes: number, manualPerSec: number, players: number, label: string) {
  let seq = 1;
  const sim = new BusinessSim(emptyBusiness(0, 0, ['a'], MATCH.startCash), () => seq++);
  const b = sim.b;
  let t = 0;
  const step = 100;
  let megaAt = -1;
  const log: string[] = [];
  while (t < minutes * 60_000) {
    t += step;
    sim.step(step, t, NO_MODS, noop);
    // Manual play: alternate produce/serve.
    if (Math.random() < (manualPerSec * players * step) / 1000) {
      if (b.stock < 3) sim.manualProduce(NO_MODS); else sim.manualServe(NO_MODS, noop, t);
    }
    if (t % 1000 !== 0) continue;
    if (megaAt < 0 && megaMallMissing(b).length === 0) megaAt = t;
    // Greedy: cheapest affordable purchase.
    const opts: { cost: number; buy: () => void; name: string }[] = [];
    const tc = checkTier(b);
    if (tc.ok) opts.push({ cost: tc.cost * 0.7, name: `tier${b.tier + 1}`, buy: () => { sim.spend(tc.cost, 'spentBuilding'); b.tier++; } });
    for (const id of UPGRADE_IDS) { const c = checkUpgrade(b, id); if (c.ok) opts.push({ cost: c.cost, name: id, buy: () => { sim.spend(c.cost, 'spentUpgrade'); b.upgrades[id]++; } }); }
    for (const id of WORKER_IDS) { const c = checkWorker(b, id); if (c.ok) opts.push({ cost: c.cost, name: id, buy: () => { sim.spend(c.cost, 'spentWorker'); b.workers[id]++; } }); }
    for (const id of STRUCTURE_IDS) { const c = checkStructure(b, id); if (c.ok) opts.push({ cost: c.cost, name: id, buy: () => { sim.spend(c.cost, 'spentStructure'); b.structures.push(id); } }); }
    // In co-op, stop spending once only money is missing for the Mega Mall.
    const saving = label.startsWith('coop') && megaMallMissing(b).every((m) => m.startsWith('$'));
    if (opts.length && !saving) {
      opts.sort((x, y) => x.cost - y.cost);
      opts[0].buy();
    }
    if (t % 60_000 === 0) log.push(`  ${t / 60000}m: cash $${formatMoney(b.cash)} value $${formatMoney(sim.b.value)} tier ${b.tier} customers ${b.stats.customers}`);
  }
  sim.refreshValue();
  console.log(`\n${label}`);
  console.log(log.join('\n'));
  console.log(`  FINAL value $${formatMoney(b.value)} tier ${b.tier}${label.startsWith('coop') ? ` · Mega Mall ($${formatMoney(COOP_GOAL.cost)}) ${megaAt >= 0 ? `possible at ${(megaAt / 60000).toFixed(1)} min` : 'NOT reached'}` : ''}`);
}

run(10, 0.5, 1, 'VS — active player (0.5 actions/s)');
run(10, 0.1, 1, 'VS — idle player (0.1 actions/s)');
run(15, 0.5, 2, 'coop — 2 active players, 15 min');
run(15, 0.3, 1, 'coop/solo — 1 player, 15 min');
