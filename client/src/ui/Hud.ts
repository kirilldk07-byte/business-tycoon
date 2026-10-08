import {
  ACHIEVEMENTS, COOP_GOAL, ECONOMY, STRUCTURES, STRUCTURE_IDS, TIERS, UPGRADES, UPGRADE_IDS, VENUES, VENUE_IDS, WORKERS, WORKER_IDS,
  type AchievementId,
} from '../../../shared/constants/config';
import { EVENT_INFO } from '../../../shared/events';
import {
  checkStructure, checkTier, checkUpgrade, checkVenue, checkWorker, computeRates, formatMoney, incomeGain, megaMallMissing, upgradeCost,
  type Purchase,
  venueCost, venueUnlocked, workerCost,
} from '../../../shared/game/economy';
import { C2S, EMOTES, EMOTE_COOLDOWN_MS } from '../../../shared/protocol/messages';
import type { ActiveEvent, BusinessState, RoomSnapshot } from '../../../shared/types/state';
import type { AudioManager } from '../audio/AudioManager';
import type { HudSink } from '../game/Game';
import type { Net } from '../multiplayer/Net';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
type Tab = 'build' | 'upgrades' | 'staff' | 'goal';

export interface HudCtx {
  room: () => RoomSnapshot | null;
  myId: () => string | null;
  ipm: (bizId: number) => number;
  emote: (i: number) => boolean;
  interact: () => void;
  jump: () => void;
  pause: () => void;
}

/** In-match UI: compact VS card, team goal, prompts, events, toasts, emotes, business panel. */
export class Hud implements HudSink {
  private root = $('hud');
  private panelOpen = false;
  private tab: Tab = 'build';
  private lastPanelKey = '';
  private lastCountdown = '';
  private eventKey = '';
  private leader: 'you' | 'opp' | null = null;
  private lastLeadBanner = 0;
  private emoteCdUntil = 0;

  constructor(private net: Net, private audio: AudioManager, private ctx: HudCtx) {
    $('btn-biz').onclick = () => this.togglePanel();
    $('panel-close').onclick = () => this.togglePanel(false);
    const tap = (id: string, fn: () => void) => {
      const el = $(id);
      el.addEventListener('touchstart', (e) => { e.preventDefault(); fn(); }, { passive: false });
      el.addEventListener('click', fn);
    };
    tap('btn-interact', () => ctx.interact());
    tap('btn-jump', () => ctx.jump());
    $('btn-pause').onclick = () => ctx.pause();
    $('emote-toggle').onclick = () => $('emotes').classList.toggle('open');
    const em = $('emotes');
    EMOTES.forEach((e, i) => {
      const b = document.createElement('button');
      b.textContent = e;
      b.title = `${i + 1}`;
      b.onclick = () => this.tryEmote(i);
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

  /** Emote with visible cooldown (server rate-limits as well). */
  tryEmote(i: number) {
    if (performance.now() < this.emoteCdUntil) return;
    if (!this.ctx.emote(i)) return;
    this.emoteCdUntil = performance.now() + EMOTE_COOLDOWN_MS;
    const em = $('emotes');
    em.classList.add('cooldown');
    em.classList.remove('open');
    setTimeout(() => em.classList.remove('cooldown'), EMOTE_COOLDOWN_MS);
  }

  show(on: boolean) {
    this.root.classList.toggle('hidden', !on);
    if (!on) { this.togglePanel(false); $('countdown').classList.add('hidden'); this.leader = null; }
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

  prompt(text: string | null, locked = false) {
    const p = $('prompt');
    if (!text) { p.classList.add('hidden'); $('btn-interact').classList.remove('ready'); return; }
    p.textContent = text;
    p.classList.toggle('locked', locked);
    p.classList.remove('hidden');
    $('btn-interact').classList.toggle('ready', !locked);
  }

  toast(text: string, kind: 'info' | 'good' | 'bad' | 'ach' = 'info') {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    box.prepend(el);
    while (box.children.length > 4) box.lastChild?.remove();
    setTimeout(() => el.remove(), kind === 'ach' ? 4000 : 2600);
  }

  achievement(id: AchievementId) {
    const a = ACHIEVEMENTS[id];
    this.toast(`🏅 ${a.icon} ${a.name} — ${a.desc}`, 'ach');
    this.audio.play('upgrade');
  }

  flashMoney() {
    const m = $('hud-money');
    m.classList.remove('flash');
    void m.offsetWidth;
    m.classList.add('flash');
  }

  setTutorial(text: string | null, sub?: string) {
    const el = $('tutorial');
    if (!text) { el.classList.add('hidden'); return; }
    const html = `${text}${sub ? `<small>${sub}</small>` : ''}`;
    if (el.innerHTML !== html) { el.innerHTML = html; el.classList.remove('hidden'); this.audio.play('notify'); }
  }

  /** Connection indicator; detailed only in dev mode. */
  setConnection(state: 'ok' | 'warn' | 'bad', text: string) {
    const c = $('hud-conn');
    c.className = `conn small ${state}`;
    c.querySelector('span')!.textContent = text;
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
    const left = room.startTime - this.net.serverNow();
    let text = '';
    if (room.status === 'countdown' || (left > -900 && left < 3500)) {
      if (left > 0) text = String(Math.ceil(left / 1000));
      else if (left > -900) text = 'GO!';
    }
    if (text !== this.lastCountdown) {
      this.lastCountdown = text;
      if (text) {
        cd.innerHTML = `<span>${text}</span>`;
        cd.classList.toggle('go', text === 'GO!');
        this.audio.play(text === 'GO!' ? 'go' : 'countdown');
      }
      cd.classList.toggle('hidden', !text);
    }
  }

  /** ~5 Hz HUD refresh. */
  update() {
    const room = this.ctx.room();
    if (!room || room.status === 'lobby') return;
    const biz = this.myBiz(room);
    const now = this.net.serverNow();
    if (biz) {
      $('hud-money').textContent = `💰 $${formatMoney(biz.cash)}`;
      $('hud-ipm').textContent = `📈 $${formatMoney(this.ctx.ipm(biz.id))}/мин`;
    }
    const remain = room.status === 'playing' ? Math.max(0, room.endTime - now) : room.status === 'countdown' ? room.endTime - room.startTime : 0;
    const t = `${String(Math.floor(remain / 60000)).padStart(2, '0')}:${String(Math.floor((remain % 60000) / 1000)).padStart(2, '0')}`;
    const low = room.status === 'playing' && remain < 30_000;
    const vs = room.mode === 'vs';
    $('vs-card').classList.toggle('hidden', !vs);
    $('tug').classList.toggle('hidden', !vs);
    $('goal-card').classList.toggle('hidden', vs);
    for (const id of ['hud-timer', 'hud-timer2']) { $(id).textContent = `⏱ ${t}`; $(id).classList.toggle('low', low); }

    if (vs) {
      const other = room.players.find((p) => p.id !== this.ctx.myId());
      const ob = other ? room.businesses.find((b) => b.ownerIds.includes(other.id)) : undefined;
      const you = biz?.value ?? 0, opp = ob?.value ?? 0;
      $('vs-you').textContent = `$${formatMoney(you)}`;
      $('vs-opp').textContent = `$${formatMoney(opp)}`;
      $('vs-opp-name').textContent = (other?.name ?? 'OPPONENT').toUpperCase();
      const share = you + opp > 0 ? you / (you + opp) : 0.5;
      $('tug-you').style.width = `${Math.round(Math.min(0.97, Math.max(0.03, share)) * 100)}%`;
      // Lead change with hysteresis: needs a 4 % margin and 8 s between banners.
      let lead = this.leader;
      if (you > opp * 1.04 && you > 300) lead = 'you';
      else if (opp > you * 1.04 && opp > 300) lead = 'opp';
      document.querySelector('#vs-card .you')!.classList.toggle('lead', lead === 'you');
      document.querySelector('#vs-card .opp')!.classList.toggle('lead', lead === 'opp');
      if (lead !== this.leader) {
        const elapsed = now - room.startTime;
        if (this.leader !== null && room.status === 'playing' && elapsed > 25_000 && performance.now() - this.lastLeadBanner > 8000) {
          this.lastLeadBanner = performance.now();
          const b = $('lead-banner');
          b.className = lead === 'you' ? 'you' : 'opp';
          b.textContent = lead === 'you' ? 'YOU TAKE THE LEAD! 🚀' : 'RIVAL TAKES THE LEAD! 😱';
          b.classList.remove('hidden');
          void b.offsetWidth;
          b.style.animation = 'none'; void b.offsetWidth; b.style.animation = '';
          this.audio.play(lead === 'you' ? 'upgrade' : 'notify');
          setTimeout(() => b.classList.add('hidden'), 2400);
        }
        this.leader = lead;
      }
    } else if (biz) {
      const pct = Math.min(100, Math.floor((biz.cash / COOP_GOAL.cost) * 100));
      const miss = megaMallMissing(biz).filter((m) => !m.startsWith('$')).length;
      $('goal-line').textContent = `${room.mode === 'coop' ? '🎯 TEAM GOAL' : '🎯 GOAL'}: ${COOP_GOAL.name} · $${formatMoney(biz.cash)} / $${formatMoney(COOP_GOAL.cost)}${miss ? ` · ещё ${miss} условия` : ''}`;
      $('goal-fill').style.width = `${pct}%`;
    }

    // Opponent reconnecting
    const waiting = room.players.filter((p) => !p.connected && p.id !== this.ctx.myId());
    const ow = $('opp-wait');
    if (waiting.length) {
      const p = waiting[0];
      const sec = Math.max(0, Math.ceil(((p.graceUntil ?? now) - now) / 1000));
      ow.textContent = `⏳ ${p.name} переподключается… ${sec}с`;
      ow.classList.remove('hidden');
    } else ow.classList.add('hidden');

    this.renderEvent(room.event, now, room);
    if (this.panelOpen) this.renderPanel();
  }

  private renderEvent(ev: ActiveEvent | null, now: number, room: RoomSnapshot) {
    const el = $('event-banner');
    if (!ev) { el.classList.add('hidden'); this.eventKey = ''; return; }
    const info = EVENT_INFO[ev.kind];
    const sec = Math.max(0, Math.ceil((ev.endsAt - now) / 1000));
    let extra = '';
    if (ev.kind === 'delivery') {
      const mine = this.myBiz(room);
      extra = ` · твои ящики: ${mine ? ev.crates?.[mine.id]?.length ?? 0 : 0}`;
    }
    if (ev.kind === 'vip' && ev.reward) extra = ` · платит $${formatMoney(ev.reward)}`;
    if (ev.kind === 'power') extra = ` · генераторы: ${(ev.switches ?? []).map((t) => (t && now - t < 5000 ? '🟢' : '🔴')).join(' ')}`;
    el.innerHTML = `${info.icon} ${info.title} · ${sec}с<small>${info.desc}${extra}</small>`;
    el.classList.remove('hidden');
    const key = `${ev.kind}${ev.startedAt}`;
    if (key !== this.eventKey) { this.eventKey = key; this.audio.play('event'); }
  }

  // ------------------------------------------------------------ panel

  private renderPanel() {
    const room = this.ctx.room();
    if (!room) return;
    const b = this.myBiz(room);
    if (!b) return;
    const tabs: [Tab, string][] = [['build', '🏢 Бизнесы'], ['upgrades', '⬆️ Улучшения'], ['staff', '👷 Персонал']];
    if (room.mode !== 'vs') tabs.push(['goal', '🎯 Mega Mall']);
    const r = computeRates(b);
    const cashHtml = `💰 $${formatMoney(b.cash)} <span class="muted small">· 📈 $${formatMoney(this.ctx.ipm(b.id))}/мин · касса $${r.price}/клиент</span>`;
    if ($('panel-cash').innerHTML !== cashHtml) $('panel-cash').innerHTML = cashHtml;
    // Rebuild rows only when what is shown/affordable changes — NOT on every cash tick:
    // replacing buttons under a finger makes taps get lost on phones.
    const afford = [
      checkTier(b).ok, ...VENUE_IDS.map((id) => checkVenue(b, id).ok), ...STRUCTURE_IDS.map((id) => checkStructure(b, id).ok),
      ...UPGRADE_IDS.map((id) => checkUpgrade(b, id).ok), ...WORKER_IDS.map((id) => checkWorker(b, id).ok), megaMallMissing(b).length === 0,
    ].map((x) => (x ? 1 : 0)).join('');
    const key = JSON.stringify([this.tab, afford, b.tier, b.upgrades, b.workers, b.venues, b.structures, room.status, room.mode]);
    if (key === this.lastPanelKey) return;
    this.lastPanelKey = key;
    $('panel-tabs').innerHTML = tabs.map(([t, l]) => `<button data-tab="${t}" class="${t === this.tab ? 'on' : ''}">${l}</button>`).join('');
    const rows: string[] = [];
    const btn = (ok: boolean, code: string, price: number, data: string) => {
      if (code === 'MAXED') return `<button class="btn ghost" disabled>MAX</button>`;
      if (code === 'LOCKED') return `<button class="btn ghost" disabled>🔒</button>`;
      return `<button class="btn ${ok ? 'green' : 'ghost'}" ${ok ? '' : 'disabled'} ${data}>$${formatMoney(price)}</button>`;
    };
    // ROI hint: "+$25/мин · окупится за 40с" — no formulas for the player.
    const roi = (p: Purchase, price: number, open: boolean) => {
      if (!open) return '';
      const g = incomeGain(b, p);
      if (g < 1) return '';
      const pay = price / (g / 60);
      const payTxt = pay < 90 ? `${Math.max(1, Math.round(pay))}с` : pay < 3600 ? `${Math.round(pay / 60)} мин` : '';
      return `<div class="roi"><b>+$${formatMoney(g)}/мин</b>${payTxt ? ` · окупится за ${payTxt}` : ''}</div>`;
    };
    const lvl = (n: number, max: number) => `<div class="lvl">${Array.from({ length: max }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</div>`;

    if (this.tab === 'build') {
      const c = checkTier(b);
      const next = TIERS[b.tier];
      rows.push(`<div class="shop-row big"><div class="ico">${b.tier ? TIERS[b.tier - 1].icon : '🏗️'}</div><div class="info"><div class="title">HQ ${b.tier}: ${b.tier ? TIERS[b.tier - 1].name : 'пустой участок'}</div>
        <div class="desc">${next ? `Далее: ${next.icon} ${next.name} — больше клиентов, выше цены` : 'Максимальный уровень!'}</div>${roi({ kind: 'tier' }, next?.cost ?? 0, !!next && b.tier >= 1)}${lvl(b.tier, 10)}</div>
        ${btn(c.ok, c.ok ? '' : c.code, c.ok ? c.cost : next?.cost ?? 0, 'data-buy="tier"')}</div>`);
      for (const vid of VENUE_IDS) {
        const d = VENUES[vid];
        const lv = b.venues[vid];
        const c = checkVenue(b, vid);
        const locked = lv === 0 && !venueUnlocked(b, vid);
        rows.push(`<div class="shop-row"><div class="ico">${d.icon}</div><div class="info"><div class="title">${d.name}${lv ? ` ★${lv}` : ''}</div>
          <div class="desc">${lv ? 'Расширить: больше клиентов и выше чек' : `Новый бизнес · $${d.price}/клиент`}${locked ? ` · нужен HQ ${d.minTier} и предыдущий бизнес` : ''}</div>${roi({ kind: 'venue', id: vid }, venueCost(vid, lv), !locked && lv < ECONOMY.venueLevelMult.length)}${lv ? lvl(lv, ECONOMY.venueLevelMult.length) : ''}</div>
          ${btn(c.ok, c.ok ? '' : c.code, venueCost(vid, lv), `data-venue="${vid}"`)}</div>`);
      }
      for (const id of STRUCTURE_IDS) {
        const d = STRUCTURES[id];
        const cs = checkStructure(b, id);
        const locked = !cs.ok && cs.code === 'LOCKED';
        rows.push(`<div class="shop-row"><div class="ico">${d.icon}</div><div class="info"><div class="title">${d.name}</div>
          <div class="desc">${d.desc}${locked ? ` · нужен HQ ${d.minTier}` : ''}</div>${roi({ kind: 'structure', id }, d.cost, !locked && !b.structures.includes(id))}</div>
          ${btn(cs.ok, cs.ok ? '' : cs.code, d.cost, `data-struct="${id}"`)}</div>`);
      }
    } else if (this.tab === 'upgrades') {
      for (const id of UPGRADE_IDS) {
        const d = UPGRADES[id];
        const c = checkUpgrade(b, id);
        rows.push(`<div class="shop-row"><div class="ico">${d.icon}</div><div class="info"><div class="title">${d.name} · ур. ${b.upgrades[id]}</div>
          <div class="desc">${d.desc}</div>${roi({ kind: 'upgrade', id }, upgradeCost(id, b.upgrades[id]), b.upgrades[id] < d.max)}${lvl(b.upgrades[id], d.max)}</div>
          ${btn(c.ok, c.ok ? '' : c.code, upgradeCost(id, b.upgrades[id]), `data-up="${id}"`)}</div>`);
      }
    } else if (this.tab === 'staff') {
      for (const id of WORKER_IDS) {
        const d = WORKERS[id];
        const c = checkWorker(b, id);
        rows.push(`<div class="shop-row"><div class="ico">${d.icon}</div><div class="info"><div class="title">${d.name} × ${b.workers[id]}</div>
          <div class="desc">${d.desc}</div>${roi({ kind: 'worker', id }, workerCost(id, b.workers[id]), b.workers[id] < d.max)}${lvl(b.workers[id], d.max)}</div>
          ${btn(c.ok, c.ok ? '' : c.code, workerCost(id, b.workers[id]), `data-hire="${id}"`)}</div>`);
      }
    } else {
      const miss = megaMallMissing(b);
      const reqs = [
        [`HQ уровня ${COOP_GOAL.minTier}+ (${TIERS[COOP_GOAL.minTier - 1].name})`, b.tier >= COOP_GOAL.minTier],
        ...Object.entries(COOP_GOAL.minUpgrades).map(([k, v]) => [`${UPGRADES[k as keyof typeof UPGRADES].name} ур. ${v}+`, b.upgrades[k as keyof typeof UPGRADES] >= (v ?? 0)]),
        [`$${formatMoney(COOP_GOAL.cost)} в кассе`, b.cash >= COOP_GOAL.cost],
      ] as [string, boolean][];
      rows.push(`<div class="shop-row big"><div class="ico">🏬</div><div class="info"><div class="title">BUILD THE MEGA MALL</div>
        <div class="desc">Общая цель команды. Постройте до конца таймера!</div>
        ${reqs.map(([tx, ok]) => `<div class="req ${ok ? 'ok' : 'no'}">${ok ? '✓' : '✗'} ${tx}</div>`).join('')}</div></div>`);
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
