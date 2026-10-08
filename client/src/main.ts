import { COSMETICS, MATCHMAKING, MATCH } from '../../shared/constants/config';
import { formatMoney } from '../../shared/game/economy';
import { C2S, S2C, type DevCmd } from '../../shared/protocol/messages';
import type { GameMode, RoomSnapshot } from '../../shared/types/state';
import { AudioManager } from './audio/AudioManager';
import { CLIENT, isTouch } from './config/client';
import { Game } from './game/Game';
import { Net } from './multiplayer/Net';
import { LocalStore } from './platform/LocalStore';
import { Platform } from './platform/Yandex';
import { Hud, esc } from './ui/Hud';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
type Screen = 'menu' | 'friend' | 'join' | 'lobby' | 'search' | 'shop' | 'leaderboard' | 'results' | 'pause' | null;
const SCREENS: Exclude<Screen, null>[] = ['menu', 'friend', 'join', 'lobby', 'search', 'shop', 'leaderboard', 'results', 'pause'];

const HAT_ICONS: Record<string, string> = { none: '🙂', cap: '🧢', tophat: '🎩', crown: '👑', chef: '👨‍🍳', cowboy: '🤠' };
const MODE_DESC: Record<GameMode, string> = {
  vs: '⚔️ Каждый строит свой бизнес. Через 10 минут побеждает большая BUSINESS VALUE.',
  coop: '🤝 Один общий бизнес. Цель — построить MEGA MALL ($1M + улучшения) за 20 минут.',
  solo: '🎮 Одиночная игра.',
};

class App {
  platform = new Platform();
  audio = new AudioManager();
  net: Net;
  game: Game;
  hud: Hud;
  room: RoomSnapshot | null = null;
  screen: Screen = null;
  createMode: GameMode = 'vs';
  searchSince = 0;
  searchTimer = 0;
  wasPlaying = false;
  endedShown = '';

  constructor() {
    if (isTouch) document.body.classList.add('touch');
    this.net = new Net(CLIENT.wsUrl, () => this.playerName());
    this.hud = new Hud(this.net, this.audio, {
      room: () => this.room,
      myId: () => this.net.playerId,
      emote: (i) => this.game.emote(i),
      interact: () => this.game.input.pressInteract(),
      jump: () => this.game.input.pressJump(),
      pause: () => this.togglePause(),
    });
    this.game = new Game($('scene') as HTMLCanvasElement, this.net, this.audio, this.hud, $('floats'), $('joy-base'), $('joy-knob'));
    this.bindUi();
    this.bindNet();
    setInterval(() => this.hud.update(), 200);
    const loop = () => { this.hud.frame(); requestAnimationFrame(loop); };
    loop();
  }

  async boot() {
    $('loading-text').textContent = 'Подключаем платформу…';
    await this.platform.init();
    this.platform.onAdState = (open) => this.audio.suspend('ad', open);
    // Cloud save (Yandex) restores the profile on another device of the same account.
    const cloud = await this.platform.cloudLoad();
    if (cloud?.profileId && cloud?.secret && !LocalStore.get().profileId) {
      LocalStore.set({ profileId: String(cloud.profileId), secret: String(cloud.secret) });
    }
    const yaName = this.platform.playerName();
    const name = CLIENT.presetName ?? LocalStore.get().name ?? yaName ?? '';
    ($('name-input') as HTMLInputElement).value = name;
    $('loading-text').textContent = 'Подключаемся к серверу…';
    this.net.connect();
    document.addEventListener('visibilitychange', () => this.audio.suspend('hidden', document.hidden));
    this.platform.loadingReady();
    $('loading').classList.remove('show');
    this.show('menu');
    if (CLIENT.inviteCode && /^\d{6}$/.test(CLIENT.inviteCode)) {
      ($('code-input') as HTMLInputElement).value = CLIENT.inviteCode;
      this.show('join');
    }
  }

  playerName() {
    const v = ($('name-input') as HTMLInputElement).value.trim();
    return v || this.platform.playerName() || '';
  }

  // ---------------------------------------------------------------- screens

  show(s: Screen) {
    this.screen = s;
    for (const id of SCREENS) $(id).classList.toggle('show', id === s);
    const inGame = !!this.room && this.room.status !== 'lobby';
    this.hud.show(inGame && (s === null || s === 'pause'));
    this.game.input.enabled = inGame && s === null;
    if (s === 'menu') this.renderMenu();
    if (s === 'shop') this.renderShop();
    if (s === 'leaderboard') this.loadLeaderboard();
  }

  private bindUi() {
    document.body.addEventListener('pointerdown', () => this.audio.unlock(), { capture: true });
    document.body.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      if (!el || (el as HTMLButtonElement).disabled) return;
      this.audio.play('ui');
      this.onAction(el.dataset.act!);
    });
    $('name-input').addEventListener('change', () => {
      const n = this.playerName();
      LocalStore.set({ name: n });
      if (this.net.isOpen) this.net.send({ t: C2S.HELLO, v: 1, profileId: LocalStore.get().profileId, secret: LocalStore.get().secret, name: n });
    });
    $('create-mode').addEventListener('click', (e) => {
      const m = (e.target as HTMLElement).closest('button')?.dataset.mode as GameMode | undefined;
      if (!m) return;
      this.createMode = m;
      for (const b of $('create-mode').querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === m);
    });
    $('lobby-mode').addEventListener('click', (e) => {
      const m = (e.target as HTMLElement).closest('button')?.dataset.mode as GameMode | undefined;
      if (m && this.isHost()) this.net.send({ t: C2S.SET_MODE, mode: m });
    });
    ($('code-input') as HTMLInputElement).addEventListener('input', (e) => {
      const i = e.target as HTMLInputElement;
      i.value = i.value.replace(/\D/g, '').slice(0, 6);
    });
    $('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.onAction('connect'); });
    $('btn-music').onclick = () => { this.audio.setMusic(!this.audio.music); this.renderMenu(); };
    $('btn-sfx').onclick = () => { this.audio.setSfx(!this.audio.sfx); this.renderMenu(); };
    if (!navigator.share) $('btn-share').classList.add('hidden');
    this.bindDev();
  }

  private needOnline(): boolean {
    if (this.net.isOpen) return true;
    this.hud.toast('Нет связи с сервером. Переподключаемся…', 'bad');
    alertToast('Нет связи с сервером. Подожди пару секунд.');
    return false;
  }

  private onAction(act: string) {
    const r = this.room;
    switch (act) {
      case 'solo': if (this.needOnline()) { this.stopSearch(); this.net.send({ t: C2S.PLAY_SOLO }); } break;
      case 'friend': this.show('friend'); break;
      case 'quick': if (this.needOnline()) this.startSearch(); break;
      case 'shop': this.show('shop'); break;
      case 'leaderboard': this.show('leaderboard'); break;
      case 'back': this.show('menu'); break;
      case 'back-friend': this.show('friend'); break;
      case 'create': if (this.needOnline()) this.net.send({ t: C2S.CREATE_ROOM, mode: this.createMode }); break;
      case 'create-private': if (this.needOnline()) { this.stopSearch(); this.net.send({ t: C2S.CREATE_ROOM, mode: 'vs' }); } break;
      case 'join': this.show('join'); setTimeout(() => $('code-input').focus(), 50); break;
      case 'connect': {
        const code = ($('code-input') as HTMLInputElement).value;
        if (!/^\d{6}$/.test(code)) { alertToast('Код — это 6 цифр'); return; }
        if (this.needOnline()) this.net.send({ t: C2S.JOIN_ROOM, code });
        break;
      }
      case 'copy': if (r) copyText(r.code).then(() => alertToast('Код скопирован ✓')); break;
      case 'copy-link': if (r) copyText(this.inviteUrl(r.code)).then(() => alertToast('Ссылка скопирована ✓')); break;
      case 'share':
        if (r && navigator.share) void navigator.share({ title: 'Business Tycoon', text: `Го играть в Business Tycoon! Код комнаты: ${r.code}`, url: this.inviteUrl(r.code) }).catch(() => {});
        break;
      case 'ready': {
        const me = r?.players.find((p) => p.id === this.net.playerId);
        this.net.send({ t: C2S.PLAYER_READY, ready: !me?.ready });
        break;
      }
      case 'start': this.net.send({ t: C2S.START_MATCH }); break;
      case 'leave': this.leaveRoom(); break;
      case 'leave-match': {
        const vsRunning = r?.mode === 'vs' && (r.status === 'playing' || r.status === 'countdown');
        if (vsRunning && !confirm('Выход из VS матча засчитывается как поражение. Выйти?')) return;
        this.leaveRoom();
        break;
      }
      case 'resume': this.show(null); break;
      case 'toggle-music': this.audio.setMusic(!this.audio.music); break;
      case 'toggle-sfx': this.audio.setSfx(!this.audio.sfx); break;
      case 'rematch': this.net.send({ t: C2S.REMATCH }); break;
      case 'cancel-search': this.stopSearch(); this.net.send({ t: C2S.CANCEL_QUICK_MATCH }); this.show('menu'); break;
      case 'continue-search': this.searchSince = Date.now(); $('search-alt').classList.add('hidden'); break;
      case 'ad-coins': void this.watchAdForCoins(); break;
    }
  }

  private inviteUrl(code: string) {
    const u = new URL(location.href);
    u.search = '';
    u.searchParams.set('room', code);
    return u.toString();
  }

  private leaveRoom() {
    this.net.send({ t: C2S.LEAVE });
    this.net.clearSession();
    this.room = null;
    this.game.syncRoom({ ...emptyRoom() }, '');
    this.platform.gameplayStop();
    this.show('menu');
    // Interstitial only between matches, after the player left.
    if (this.wasPlaying) { this.wasPlaying = false; void this.platform.showFullscreen(); }
  }

  private isHost() {
    return !!this.room?.players.find((p) => p.id === this.net.playerId)?.isHost;
  }

  private togglePause() {
    if (this.screen === 'pause') { this.show(null); return; }
    if (this.room && this.room.status !== 'lobby') {
      $('leave-warn').textContent = this.room.mode === 'vs' && this.room.status === 'playing' ? 'Выход из VS матча = поражение.' : '';
      this.show('pause');
    }
  }

  // ---------------------------------------------------------------- network

  private bindNet() {
    const n = this.net;
    n.onStatus((s) => {
      const chip = $('conn-chip');
      chip.textContent = s === 'online' ? '🟢 online' : s === 'connecting' ? '🟡 подключение' : s === 'reconnecting' ? '🟡 переподключение' : '🔴 offline';
      const inMatch = !!this.room && this.room.status !== 'lobby';
      $('reconnect').classList.toggle('hidden', s === 'online' || !inMatch);
      if (s === 'online') this.renderMenu();
    });
    n.on(S2C.WELCOME, () => this.renderMenu());
    n.on(S2C.PROFILE, (m) => {
      this.renderMenu();
      if (this.screen === 'shop') this.renderShop();
      void this.platform.setLeaderboardScore(CLIENT.leaderboardName, m.profile.wins);
      void this.platform.cloudSave({ profileId: LocalStore.get().profileId, secret: LocalStore.get().secret });
    });
    n.on(S2C.ERROR, (m) => {
      this.audio.play('error');
      if (this.room && this.room.status !== 'lobby' && this.screen === null) this.hud.toast(m.msg, 'bad');
      else alertToast(m.msg);
      if (m.code === 'BAD_TOKEN' && this.room) { this.room = null; this.game.syncRoom(emptyRoom(), ''); this.show('menu'); }
      this.hud.update();
    });
    n.on(S2C.TOAST, (m) => this.hud.toast(m.text, m.kind));
    n.on(S2C.ROOM_JOINED, (m) => {
      this.stopSearch();
      this.applyRoom(m.room, true);
    });
    n.on(S2C.ROOM_STATE, (m) => this.applyRoom(m.room, false));
    n.on(S2C.ROOM_LEFT, () => {
      this.room = null;
      this.game.syncRoom(emptyRoom(), '');
      if (this.screen !== 'menu') this.show('menu');
    });
    n.on(S2C.QUEUE_STATUS, (m) => { if (!m.searching && this.screen === 'search' && !this.room) this.show('menu'); });
    n.on(S2C.MATCH_COUNTDOWN, (m) => {
      if (this.room) { this.room.startTime = m.startAt; this.room.endTime = m.endAt; }
    });
    n.on(S2C.BUSINESS_UPDATE, () => this.hud.update());
    n.on(S2C.PLAYER_DISCONNECTED, (m) => {
      if (m.id !== n.playerId) { this.hud.toast('⚠️ Соперник потерял связь — ждём', 'bad'); this.audio.play('notify'); }
    });
    n.on(S2C.PLAYER_RECONNECTED, (m) => {
      if (m.id !== n.playerId) { this.hud.toast('✅ Игрок вернулся', 'good'); this.audio.play('notify'); }
    });
    n.on(S2C.MATCH_END, (m) => {
      if (!this.room) return;
      this.room.result = m.result;
      this.room.status = 'ended';
    });
    n.on(S2C.LEADERBOARD, (m) => this.renderLeaderboard(m.entries.map((e, i) => ({ rank: i + 1, name: e.name, score: e.wins, rating: e.rating })), 'Сервер игры'));
  }

  private applyRoom(room: RoomSnapshot, joined: boolean) {
    const prev = this.room;
    this.room = room;
    const myId = this.net.playerId ?? '';
    this.game.syncRoom(room, myId);
    if (room.status === 'lobby') {
      this.platform.gameplayStop();
      this.renderLobby();
      if (this.screen !== 'lobby') this.show('lobby');
      if (prev && prev.players.length < room.players.length && !joined) this.audio.play('notify');
      return;
    }
    if (room.status === 'countdown' || room.status === 'playing') {
      $('reconnect').classList.add('hidden');
      if (this.screen !== null && this.screen !== 'pause') this.show(null);
      this.platform.gameplayStart();
      this.wasPlaying = true;
      this.endedShown = '';
      return;
    }
    if (room.status === 'ended' && room.result) {
      this.platform.gameplayStop();
      const key = room.roomId + room.startTime;
      if (this.endedShown !== key) {
        this.endedShown = key;
        const won = room.result.winnerIds.includes(myId);
        this.audio.play(won ? 'victory' : 'defeat');
        this.game.celebrate(won);
        // Let the victory/lose animation play briefly before the results card.
        setTimeout(() => { if (this.room?.status === 'ended') { this.renderResults(); this.show('results'); } }, 1600);
      } else if (this.screen === 'results') {
        this.renderResults();
      }
    }
  }

  // ---------------------------------------------------------------- renders

  private renderMenu() {
    const p = this.net.profile;
    $('menu-coins').textContent = `🪙 ${p?.coins ?? 0}`;
    $('btn-music').classList.toggle('off', !this.audio.music);
    $('btn-sfx').classList.toggle('off', !this.audio.sfx);
    $('profile-line').textContent = p ? `🏆 ${p.wins} побед · ⭐ ${p.rating} · 🎮 ${p.gamesPlayed} матчей` : 'Подключение к серверу…';
  }

  private renderLobby() {
    const r = this.room!;
    const myId = this.net.playerId;
    $('room-code').textContent = r.code;
    $('lobby-hint').textContent = r.isPrivate ? 'Отправь код другу' : 'Быстрая игра — соперник найден!';
    const cards: string[] = [];
    const max = MATCH.maxPlayers[r.mode];
    for (let i = 0; i < max; i++) {
      const p = r.players.find((x) => x.slot === i);
      if (!p) { cards.push(`<div class="pcard empty">⏳ Ждём игрока ${i + 1}…</div>`); continue; }
      const ping = p.ping ? `${p.ping < 80 ? '🟢' : p.ping < 180 ? '🟡' : '🔴'} ${p.ping} ms` : '—';
      cards.push(`<div class="pcard ${p.id === myId ? 'me' : ''}">
        <div class="slot">PLAYER ${i + 1}${p.isHost ? ' · 👑 HOST' : ''}${p.id === myId ? ' · ВЫ' : ''}</div>
        <div class="pname"><span class="dot" style="background:#${p.color.toString(16).padStart(6, '0')}"></span>${HAT_ICONS[p.hat] ?? ''} ${esc(p.name)}</div>
        <div class="ready ${p.ready ? 'ok' : ''}">${!p.connected ? '📡 переподключается…' : p.ready ? 'READY ✓' : 'не готов'}</div>
        <div class="muted small" style="text-align:left">PING ${ping}</div></div>`);
    }
    $('lobby-players').innerHTML = cards.join('');
    for (const b of $('lobby-mode').querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === r.mode);
    $('lobby-mode').classList.toggle('locked', !this.isHost());
    $('mode-desc').textContent = MODE_DESC[r.mode] + (this.isHost() ? '' : ' (режим выбирает хост)');
    const me = r.players.find((p) => p.id === myId);
    const readyBtn = $('btn-ready');
    readyBtn.textContent = me?.ready ? 'READY ✓ (отменить)' : 'READY';
    readyBtn.className = `btn ${me?.ready ? 'blue' : 'green'}`;
    const all = r.players.length === max && r.players.every((p) => p.ready && p.connected);
    ($('btn-start') as HTMLButtonElement).disabled = !all;
    $('btn-start').textContent = all ? '▶ START' : r.players.length < max ? 'Ждём игрока…' : 'Ждём READY…';
  }

  private renderResults() {
    const r = this.room!;
    const res = r.result!;
    const myId = this.net.playerId!;
    const won = res.winnerIds.includes(myId);
    let title: string;
    if (res.mode === 'vs') {
      const w = res.players.find((p) => p.id === res.winnerIds[0]);
      title = res.winnerIds.length === 0 ? '🤝 НИЧЬЯ!' : `🏆 ${esc(w?.name ?? 'PLAYER')} WINS!`;
    } else title = won ? '🏬 MEGA MALL ПОСТРОЕН!' : '⏰ ВРЕМЯ ВЫШЛО';
    $('res-title').innerHTML = title;
    const reasons: Record<string, string> = {
      time: 'Время матча вышло — победа по BUSINESS VALUE', goal: 'Командная цель выполнена!', forfeit: 'Соперник покинул матч (техническое поражение)',
      disconnect: 'Соперник не вернулся после потери связи', dev: 'Матч завершён',
    };
    $('res-reason').textContent = (res.mode === 'vs' ? (won ? 'Ты победил! ' : res.winnerIds.length ? 'Ты проиграл. ' : '') : '') + (reasons[res.reason] ?? '');
    const cols = res.mode === 'vs' ? res.players : [{ id: 'team', name: 'КОМАНДА', value: res.businesses[0]?.value ?? 0, businessId: 0 }];
    const bizOf = (bid: number) => res.businesses.find((b) => b.id === bid)!;
    const win = (id: string) => res.winnerIds.includes(id);
    const row = (label: string, f: (c: (typeof cols)[0]) => string) => `<tr><td>${label}</td>${cols.map((c) => `<td class="${win(c.id) ? 'win' : ''}">${f(c)}</td>`).join('')}</tr>`;
    $('res-table').innerHTML = `<tr><th></th>${cols.map((c) => `<th>${esc(c.name)}${c.id === myId ? ' (ты)' : ''}</th>`).join('')}</tr>` +
      row('BUSINESS VALUE', (c) => `$${formatMoney(bizOf(c.businessId)?.value ?? c.value)}`) +
      row('TOTAL CUSTOMERS', (c) => formatMoney(bizOf(c.businessId)?.customers ?? 0)) +
      row('UPGRADES', (c) => String(bizOf(c.businessId)?.upgrades ?? 0)) +
      row('BUILDINGS', (c) => String(bizOf(c.businessId)?.buildings ?? 0)) +
      row('INCOME', (c) => `$${formatMoney(bizOf(c.businessId)?.income ?? 0)}`);
    const rw = res.rewards[myId];
    $('res-rewards').innerHTML = rw ? `<div class="chip">🪙 +${rw.coins}</div>${rw.ratingDelta ? `<div class="chip">⭐ ${rw.ratingDelta > 0 ? '+' : ''}${rw.ratingDelta}</div>` : ''}` : '';
    const others = r.players.filter((p) => p.id !== myId);
    const me = r.players.find((p) => p.id === myId);
    const canRematch = r.players.length === MATCH.maxPlayers[r.mode] && r.status === 'ended';
    ($('btn-rematch') as HTMLButtonElement).disabled = !canRematch || !!me?.rematch;
    $('btn-rematch').textContent = me?.rematch ? '⏳ Ждём соперника…' : '🔁 REMATCH';
    $('rematch-status').textContent = !canRematch && r.mode !== 'solo' ? 'Соперник покинул комнату' : others.some((p) => p.rematch) ? '🔥 Соперник хочет реванш!' : '';
  }

  private renderShop() {
    const p = this.net.profile;
    $('shop-coins').textContent = `🪙 ${p?.coins ?? 0}`;
    $('shop-grid').innerHTML = COSMETICS.map((c) => {
      const owned = p?.hats.includes(c.id);
      const on = p?.hat === c.id;
      const action = on ? '<button class="btn small ghost" disabled>НАДЕТО</button>'
        : owned ? `<button class="btn small" data-equip="${c.id}">НАДЕТЬ</button>`
        : `<button class="btn small" data-buyhat="${c.id}" ${p && p.coins >= c.price ? '' : 'disabled'}>🪙 ${c.price}</button>`;
      return `<div class="item ${on ? 'on' : ''}"><div class="ico">${HAT_ICONS[c.id]}</div><div>${c.name}</div>${action}</div>`;
    }).join('');
    $('shop-grid').onclick = (e) => {
      const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!b || b.disabled) return;
      if (b.dataset.equip) this.net.send({ t: C2S.SET_COSMETIC, id: b.dataset.equip as never });
      if (b.dataset.buyhat) this.net.send({ t: C2S.BUY_COSMETIC, id: b.dataset.buyhat as never });
      this.audio.play('purchase');
    };
  }

  private async watchAdForCoins() {
    if (!this.needOnline()) return;
    const ok = await this.platform.showRewarded();
    if (ok) this.net.send({ t: C2S.AD_REWARD });
  }

  private async loadLeaderboard() {
    $('lb-list').innerHTML = '<div class="spinner"></div>';
    const ya = await this.platform.getLeaderboard(CLIENT.leaderboardName);
    if (ya && ya.length) this.renderLeaderboard(ya, 'Яндекс Игры');
    else this.net.send({ t: C2S.GET_LEADERBOARD });
  }

  private renderLeaderboard(entries: { rank: number; name: string; score: number; rating?: number }[], source: string) {
    if (this.screen !== 'leaderboard') return;
    $('lb-source').textContent = `🏆 Победы · источник: ${source}`;
    const me = this.net.profile?.name;
    $('lb-list').innerHTML = entries.length
      ? entries.map((e) => `<li class="${e.name === me ? 'me' : ''}"><span>${e.rank}. ${esc(e.name)}</span><span>${e.score} 🏆${e.rating ? ` · ⭐${e.rating}` : ''}</span></li>`).join('')
      : '<p class="muted">Пока пусто — сыграй первый матч!</p>';
  }

  // ---------------------------------------------------------------- quick match

  private startSearch() {
    this.net.send({ t: C2S.QUICK_MATCH });
    this.searchSince = Date.now();
    $('search-alt').classList.add('hidden');
    $('search-title').textContent = 'SEARCHING FOR PLAYER…';
    this.show('search');
    clearInterval(this.searchTimer);
    this.searchTimer = window.setInterval(() => {
      const s = Math.floor((Date.now() - this.searchSince) / 1000);
      $('search-timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      if (Date.now() - this.searchSince > MATCHMAKING.offerAlternativesAfterMs) $('search-alt').classList.remove('hidden');
    }, 250);
  }

  private stopSearch() {
    clearInterval(this.searchTimer);
    if (this.screen === 'search') { $('search-title').textContent = 'PLAYER FOUND!'; this.audio.play('notify'); }
  }

  // ---------------------------------------------------------------- dev tools

  private bindDev() {
    const dev = $('dev');
    $('dev-toggle').onclick = () => { dev.classList.toggle('collapsed'); $('dev-toggle').textContent = dev.classList.contains('collapsed') ? 'DEV ▸' : 'DEV ▾'; };
    const refresh = () => dev.classList.toggle('hidden', !(CLIENT.devRequested && this.net.devTools));
    this.net.on(S2C.WELCOME, refresh);
    dev.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!b) return;
      if (b.dataset.dev) {
        this.net.send({ t: C2S.DEV, cmd: b.dataset.dev as DevCmd, arg: b.dataset.arg ? Number(b.dataset.arg) : undefined });
        if (b.dataset.dev === 'triggerEvent') b.dataset.arg = String(Number(b.dataset.arg ?? 0) + 1);
      }
      if (b.dataset.devc === 'drop') this.net.simulateDisconnect(0);
      if (b.dataset.devc === 'offline') this.net.simulateDisconnect(10_000);
      if (b.dataset.devc === 'client2') {
        const u = new URL(location.href);
        u.search = '';
        u.searchParams.set('dev', '1');
        u.searchParams.set('name', 'TestClient');
        if (this.room?.status === 'lobby') u.searchParams.set('room', this.room.code);
        window.open(u.toString(), '_blank', 'width=900,height=600');
      }
    });
    ($('dev-lag') as HTMLSelectElement).onchange = (e) => { this.net.simulateLatency((e.target as HTMLSelectElement).value); };
  }
}

function emptyRoom(): RoomSnapshot {
  return {
    roomId: '', code: '', mode: 'vs', status: 'lobby', isPrivate: true, serverTime: 0, countdownEndsAt: 0, startTime: 0, endTime: 0,
    players: [], businesses: [], event: null, result: null, megaMallBuilt: false, devTools: false,
  };
}

function alertToast(text: string) {
  let el = document.getElementById('menu-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'menu-toast';
    el.className = 'toast';
    Object.assign(el.style, { position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)', zIndex: '60' });
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.display = 'block';
  clearTimeout(Number(el.dataset.t));
  el.dataset.t = String(setTimeout(() => { el!.style.display = 'none'; }, 2400));
}

async function copyText(t: string) {
  try { await navigator.clipboard.writeText(t); } catch {
    const ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
}

const app = new App();
void app.boot();
(window as unknown as { __app: App }).__app = app;
