import {
  COOP_GOAL, ECONOMY, STRUCTURES, STRUCTURE_IDS, TIERS, UPGRADES, UPGRADE_IDS, VENUES, VENUE_IDS, WORKERS, WORKER_IDS,
} from '../../../shared/constants/config';
import { EVENT_INFO } from '../../../shared/events';
import {
  checkStructure, checkTier, checkUpgrade, checkVenue, checkWorker, computeRates, formatMoney, megaMallMissing, upgradeCost, venueCost, venueUnlocked, workerCost,
} from '../../../shared/game/economy';
import { C2S, EMOTES } from '../../../shared/protocol/messages';
import type { ActiveEvent, BusinessState, RoomSnapshot } from '../../../shared/types/state';
import type { AudioManager } from '../audio/AudioManager';
import type { HudSink } from '../game/Game';
import type { Net } from '../multiplayer/Net';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
type Tab = 'build' | 'upgrades' | 'staff' | 'goal';

export class Hud implements HudSink {
  private root = $('hud');
  private panelOpen = false;
  private tab: Tab = 'build';
  private lastPanelKey = '';
  private lastPing = 0;
  private lastCountdown = '';
  private eventKey = '';

  constructor(private net: Net, private audio: AudioManager, private ctx: { room: () => RoomSnapshot | null; myId: () => string | null; emote: (i: number) => void; interact: () => void; jump: () => void; pause: () => void }) {
    $('btn-biz').onclick = () => this.togglePanel();
    $('panel-close').onclick = () => this.togglePanel(false);
    $('btn-interact').addEventListener('touchstart', (e) => { e.preventDefault(); ctx.interact(); });
    $('btn-jump').addEventListener('touchstart', (e) => { e.preventDefault(); ctx.jump(); });
    $('btn-pause').onclick = () => ctx.pause();
    const em = $('emotes');
    EMOTES.forEach((e, i) => {
      const b = document.createElement('button');
      b.textContent = e;
      b.title = `${i + 1}`;
      b.onclick = () => ctx.emote(i);
      em.appendChild(b);
    });
    window.addEventListener('keydown', (e) => {
      if (this.root.classList.contains('hidden') || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.code === 'KeyB' || e.code === 'Tab') { e.preventDefault(); this.togglePanel(); }
      if (e.code === 'Escape') { if (this.panelOpen) this.togglePanel(false); else ctx.pause(); }
    });
    $('panel-body').addEventListener('click', (e) => this.onPanelClick(e));
    $('panel-tabs').addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button')?.dataset.tab as Tab | undefined;
      if (t) { this.tab = t; this.lastPanelKey = ''; this.audio.play('ui'); this.renderPanel(); }
    });
  }

  show(on: boolean) {
    this.root.classList.toggle('hidden', !on);
    if (!on) { this.togglePanel(false); $('countdown').classList.add('hidden'); }
  }

  openTab(tab: Tab) {
    this.tab = tab;
    this.lastPanelKey = '';
    this.togglePanel(true);
  }

  togglePanel(open = !this.panelOpen) {
    this.panelOpen = open;
    $('panel').classList.toggle('hidden', !open);
    if (open) { this.audio.play('ui'); this.lastPanelKey = ''; this.renderPanel(); }
  }

  prompt(text: string | null) {
    const p = $('prompt');
    if (!text) { p.classList.add('hidden'); $('btn-interact').classList.remove('ready'); return; }
    p.textContent = text;
    p.classList.remove('hidden');
    $('btn-interact').classList.add('ready');
  }

  toast(text: string, kind: 'info' | 'good' | 'bad' = 'info') {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    box.prepend(el);
    while (box.children.length > 4) box.lastChild?.remove();
    setTimeout(() => el.remove(), 2600);
  }

  flashMoney() {
    const m = $('hud-money');
    m.classList.remove('flash');
    void m.offsetWidth;
    m.classList.add('flash');
  }

  private myBiz(room: RoomSnapshot): BusinessState | undefined {
    const id = this.ctx.myId();
    return room.businesses.find((b) => b.ownerIds.includes(id ?? ''));
  }

  /** Per-frame: countdown overlay from server time. */
  frame() {
    const room = this.ctx.room();
    const cd = $('countdown');
    if (!room || room.status === 'lobby') { cd.classList.add('hidden'); return; }
    const now = this.net.serverNow();
    const left = room.startTime - now;
    let text = '';
    if (room.status === 'countdown' || (left > -900 && left < 3500)) {
      if (left > 0) text = String(Math.ceil(left / 1000));
      else if (left > -900) text = 'BUILD!';
    }
    if (text !== this.lastCountdown) {
      this.lastCountdown = text;
      if (text) {
        cd.innerHTML = `<span>${text}</span>`;
        cd.classList.toggle('go', text === 'BUILD!');
        this.audio.play(text === 'BUILD!' ? 'go' : 'countdown');
      }
      cd.classList.toggle('hidden', !text);
    }
  }

  /** ~5 Hz HUD refresh. */
  update() {
    const room = this.ctx.room();
    if (!room) return;
    const biz = this.myBiz(room);
    const now = this.net.serverNow();
    if (biz) {
      $('hud-money').textContent = `💰 $${formatMoney(biz.cash)}`;
      $('hud-value').textContent = `🏢 $${formatMoney(biz.value)}`;
    }
    const remain = room.status === 'playing' ? Math.max(0, room.endTime - now) : room.status === 'countdown' ? room.endTime - room.startTime : 0;
    const mm = Math.floor(remain / 60000), ss = Math.floor((remain % 60000) / 1000);
    const timer = $('hud-timer');
    timer.textContent = `⏱ ${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    timer.classList.toggle('low', room.status === 'playing' && remain < 30_000);

    const opp = $('hud-opp');
    const vs = $('hud-vs');
    if (room.mode === 'vs') {
      const me = room.players.find((p) => p.id === this.ctx.myId());
      const other = room.players.find((p) => p.id !== this.ctx.myId());
      const ob = other ? room.businesses.find((b) => b.ownerIds.includes(other.id)) : undefined;
      opp.className = 'stat opp';
      opp.textContent = `⚔️ ${other?.name ?? '—'} $${formatMoney(ob?.value ?? 0)}`;
      vs.innerHTML = `<span class="side">YOU $${formatMoney(biz?.value ?? 0)}</span><span class="vsx">VS</span><span class="side">${esc(other?.name ?? 'P2')} $${formatMoney(ob?.value ?? 0)}</span>`;
      void me;
    } else if (biz) {
      const pct = Math.min(100, Math.floor((biz.cash / COOP_GOAL.cost) * 100));
      opp.className = 'stat';
      opp.innerHTML = `🎯 ${COOP_GOAL.name}: ${pct}%<div class="goal-bar"><div style="width:${pct}%"></div></div>`;
      vs.textContent = room.mode === 'coop' ? '🤝 TEAM GOAL' : '🎮 SOLO';
    }

    // Ping (throttled to 1 Hz)
    if (performance.now() - this.lastPing > 1000) {
      this.lastPing = performance.now();
      const r = Math.round(this.net.rtt);
      const icon = this.net.status !== 'online' ? '🔴' : r < 80 ? '🟢' : r < 180 ? '🟡' : '🔴';
      $('hud-ping').textContent = this.net.status !== 'online' ? '🔴 offline' : `${icon} ${r} ms`;
    }

    // Opponent reconnecting
    const waiting = room.players.filter((p) => !p.connected && p.id !== this.ctx.myId());
    const ow = $('opp-wait');
    if (waiting.length && room.status !== 'lobby') {
      const p = waiting[0];
      const sec = Math.max(0, Math.ceil(((p.graceUntil ?? now) - now) / 1000));
      ow.textContent = `⏳ ${p.name} переподключается… ${sec}с`;
      ow.classList.remove('hidden');
    } else ow.classList.add('hidden');

    this.renderEvent(room.event, now);
    if (this.panelOpen) this.renderPanel();
  }

  private renderEvent(ev: ActiveEvent | null, now: number) {
    const el = $('event-banner');
    if (!ev) { el.classList.add('hidden'); this.eventKey = ''; return; }
    const info = EVENT_INFO[ev.kind];
    const sec = Math.max(0, Math.ceil((ev.endsAt - now) / 1000));
    let extra = '';
    if (ev.kind === 'delivery') {
      const mine = this.ctx.room() && this.myBiz(this.ctx.room()!);
      extra = ` · твои ящики: ${mine ? ev.crates?.[mine.id]?.length ?? 0 : 0}`;
    }
    if (ev.kind === 'vip' && ev.reward) extra = ` · платит $${formatMoney(ev.reward)}`;
    if (ev.kind === 'power') extra = ` · рубильники: ${(ev.switches ?? []).map((t) => (t && now - t < 5000 ? '🟢' : '🔴')).join(' ')}`;
    el.innerHTML = `${info.icon} ${info.title} · ${sec}с<small>${info.desc}${extra}</small>`;
    el.classList.remove('hidden');
    const key = `${ev.kind}${ev.startedAt}`;
    if (key !== this.eventKey) { this.eventKey = key; this.audio.play('notify'); }
  }

  // ------------------------------------------------------------ panel

  private renderPanel() {
    const room = this.ctx.room();
    if (!room) return;
    const b = this.myBiz(room);
    if (!b) return;
    const tabs: [Tab, string][] = [['build', '🏢 Здание'], ['upgrades', '⬆️ Улучшения'], ['staff', '👷 Персонал']];
    if (room.mode !== 'vs') tabs.push(['goal', '🎯 Mega Mall']);
    const key = JSON.stringify([this.tab, b.cash, b.tier, b.upgrades, b.workers, b.structures, room.status, room.mode]);
    if (key === this.lastPanelKey) return;
    this.lastPanelKey = key;
    $('panel-tabs').innerHTML = tabs.map(([t, l]) => `<button data-tab="${t}" class="${t === this.tab ? 'on' : ''}">${l}</button>`).join('');
    const r = computeRates(b);
    $('panel-cash').innerHTML = `💰 $${formatMoney(b.cash)} <span class="muted small">· $${r.price}/клиент · ${(r.spawnRate * 60).toFixed(0)} клиентов/мин</span>`;
    const rows: string[] = [];
    const btn = (ok: boolean, code: string, price: number, data: string) => {
      if (code === 'MAXED') return `<button class="btn ghost" disabled>MAX</button>`;
      if (code === 'LOCKED') return `<button class="btn ghost" disabled>🔒</button>`;
      return `<button class="btn ${ok ? 'green' : 'ghost'}" ${ok ? '' : 'disabled'} ${data}>$${formatMoney(price)}</button>`;
    };
    const lvl_ = (n: number, max: number) => `<div class="lvl">${Array.from({ length: max }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</div>`;
    const lvl = (n: number, max: number) => `<div class="lvl">${Array.from({ length: max }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</div>`;

    if (this.tab === 'build') {
      const c = checkTier(b);
      const next = TIERS[b.tier];
      rows.push(`<div class="shop-row big"><div class="ico">🏗️</div><div class="info"><div class="title">HQ LEVEL ${b.tier}: ${b.tier ? TIERS[b.tier - 1].name : 'пустой участок'}</div>
        <div class="desc">${next ? `Следующий: ${next.icon} ${next.name} — больше клиентов, выше цена` : 'Максимальный уровень!'}</div>${lvl(b.tier, 10)}</div>
        ${btn(c.ok, c.ok ? '' : c.code, c.ok ? c.cost : next?.cost ?? 0, 'data-buy="tier"')}</div>`);
      for (const vid of VENUE_IDS) {
        const d = VENUES[vid];
        const lvl = b.venues[vid];
        const c = checkVenue(b, vid);
        const locked = lvl === 0 && !venueUnlocked(b, vid);
        rows.push(`<div class="shop-row"><div class="ico">${d.icon}</div><div class="info"><div class="title">${d.name}${lvl ? ` ★${lvl}` : ''}</div>
          <div class="desc">${lvl ? 'Расширить: больше клиентов и выше чек' : `Новый бизнес · $${d.price}/клиент`}${locked ? ` · нужен HQ ур. ${d.minTier} и предыдущий бизнес` : ''}</div>${lvl ? lvl_(lvl, ECONOMY.venueLevelMult.length) : ''}</div>
          ${btn(c.ok, c.ok ? '' : c.code, venueCost(vid, lvl), `data-venue="${vid}"`)}</div>`);
      }
      for (const id of STRUCTURE_IDS) {
        const d = STRUCTURES[id];
        const cs = checkStructure(b, id);
        const locked = !cs.ok && cs.code === 'LOCKED';
        rows.push(`<div class="shop-row"><div class="ico">${d.icon}</div><div class="info"><div class="title">${d.name}</div>
          <div class="desc">${d.desc}${locked ? ` · нужен уровень ${d.minTier}` : ''}</div></div>
          ${btn(cs.ok, cs.ok ? '' : cs.code, d.cost, `data-struct="${id}"`)}</div>`);
      }
    } else if (this.tab === 'upgrades') {
      for (const id of UPGRADE_IDS) {
        const d = UPGRADES[id];
        const c = checkUpgrade(b, id);
        rows.push(`<div class="shop-row"><div class="ico">${d.icon}</div><div class="info"><div class="title">${d.name} · ур. ${b.upgrades[id]}</div>
          <div class="desc">${d.desc}</div>${lvl(b.upgrades[id], d.max)}</div>
          ${btn(c.ok, c.ok ? '' : c.code, upgradeCost(id, b.upgrades[id]), `data-up="${id}"`)}</div>`);
      }
    } else if (this.tab === 'staff') {
      for (const id of WORKER_IDS) {
        const d = WORKERS[id];
        const c = checkWorker(b, id);
        rows.push(`<div class="shop-row"><div class="ico">${d.icon}</div><div class="info"><div class="title">${d.name} × ${b.workers[id]}</div>
          <div class="desc">${d.desc}</div>${lvl(b.workers[id], d.max)}</div>
          ${btn(c.ok, c.ok ? '' : c.code, workerCost(id, b.workers[id]), `data-hire="${id}"`)}</div>`);
      }
    } else {
      const miss = megaMallMissing(b);
      const reqs = [
        [`Здание уровня ${COOP_GOAL.minTier}+`, b.tier >= COOP_GOAL.minTier],
        ...Object.entries(COOP_GOAL.minUpgrades).map(([k, v]) => [`${UPGRADES[k as keyof typeof UPGRADES].name} ур. ${v}+`, b.upgrades[k as keyof typeof UPGRADES] >= (v ?? 0)]),
        [`$${formatMoney(COOP_GOAL.cost)} в кассе`, b.cash >= COOP_GOAL.cost],
      ] as [string, boolean][];
      rows.push(`<div class="shop-row big"><div class="ico">🏬</div><div class="info"><div class="title">BUILD THE MEGA MALL</div>
        <div class="desc">Общая цель команды. Постройте до конца таймера!</div>
        ${reqs.map(([t, ok]) => `<div class="req ${ok ? 'ok' : 'no'}">${ok ? '✓' : '✗'} ${t}</div>`).join('')}</div></div>`);
      rows.push(`<button class="btn orange" data-mega="1" ${miss.length ? 'disabled' : ''}>🏗️ ПОСТРОИТЬ MEGA MALL</button>`);
    }
    $('panel-body').innerHTML = rows.join('');
  }

  private onPanelClick(e: Event) {
    const el = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!el || el.disabled) return;
    const d = el.dataset;
    // The client only REQUESTS purchases; the server validates and applies.
    if (d.buy === 'tier') this.net.send({ t: C2S.BUILD_BUSINESS, kind: 'tier' });
    else if (d.struct) this.net.send({ t: C2S.BUILD_BUSINESS, kind: 'structure', id: d.struct as never });
    else if (d.venue) this.net.send({ t: C2S.BUILD_BUSINESS, kind: 'venue', id: d.venue as never });
    else if (d.up) this.net.send({ t: C2S.BUY_UPGRADE, id: d.up as never });
    else if (d.hire) this.net.send({ t: C2S.HIRE_WORKER, id: d.hire as never });
    else if (d.mega) this.net.send({ t: C2S.BUILD_MEGA_MALL });
    else return;
    this.audio.play('ui');
    el.disabled = true; // until the authoritative update arrives
  }
}

export function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
