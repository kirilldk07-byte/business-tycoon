import { ACHIEVEMENTS, COOP_GOAL, COSMETICS, MATCHMAKING, MATCH, type AchievementId } from '../../shared/constants/config';
import { formatMoney } from '../../shared/game/economy';
import { C2S, ERR, S2C, type DevCmd, type ErrCode } from '../../shared/protocol/messages';
import type { GameMode, RoomSnapshot } from '../../shared/types/state';
import { AudioManager } from './audio/AudioManager';
import { CLIENT, isTouch } from './config/client';
import { qualitySetting, resolveQuality, type QualityName } from './config/quality';
import { Game } from './game/Game';
import { Net, type NetStatus } from './multiplayer/Net';
import { LocalStore } from './platform/LocalStore';
import { Platform } from './platform/Yandex';
import { Hud, esc } from './ui/Hud';
import { Tutorial } from './ui/Tutorial';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
type Screen = 'menu' | 'friend' | 'join' | 'lobby' | 'search' | 'shop' | 'leaderboard' | 'settings' | 'results' | 'pause' | null;
const SCREENS: Exclude<Screen, null>[] = ['menu', 'friend', 'join', 'lobby', 'search', 'shop', 'leaderboard', 'settings', 'results', 'pause'];

const HAT_ICONS: Record<string, string> = { none: '🙂', cap: '🧢', tophat: '🎩', crown: '👑', chef: '👨‍🍳', cowboy: '🤠' };
const MODE_DESC: Record<GameMode, string> = {
  vs: `⚔️ Каждый строит свой бизнес. Через ${MATCH.durationMs.vs / 60000} минут побеждает большая BUSINESS VALUE.`,
  coop: `🤝 Один общий бизнес. Цель — построить MEGA MALL ($${formatMoney(COOP_GOAL.cost)} + условия) за ${MATCH.durationMs.coop / 60000} минут.`,
  solo: '🎮 Одиночная игра.',
};
/** Player-facing error texts (no technical WebSocket details). */
const JOIN_ERRORS: Partial<Record<ErrCode, string>> = {
  [ERR.ROOM_NOT_FOUND]: 'ROOM NOT FOUND — проверь код',
  [ERR.ROOM_FULL]: 'ROOM FULL — в комнате уже 2 игрока',
  [ERR.ROOM_IN_PROGRESS]: 'В этой комнате уже идёт матч',
  [ERR.BAD_MESSAGE]: 'INVALID CODE',
};

class App {
  platform = new Platform();
  audio = new AudioManager();
  net: Net;
  game: Game;
  hud: Hud;
  tutorial = new Tutorial();
  room: RoomSnapshot | null = null;
  screen: Screen = null;
  searchSince = 0;
  searchTimer = 0;
  wasPlaying = false;
  endedShown = '';
  joining = false;
  private wasDisconnected = false;

  constructor() {
    if (isTouch) document.body.classList.add('touch');
    this.net = new Net(CLIENT.wsUrl, () => this.playerName());
    this.hud = new Hud(this.net, this.audio, {
      room: () => this.room,
      myId: () => this.net.playerId,
      ipm: (id) => this.game.ipm.get(id) ?? 0,
      emote: (i) => this.game.emote(i),
      interact: () => this.game.input.pressInteract(),
      jump: () => this.game.input.pressJump(),
      pause: () => this.togglePause(),
    });
    this.game = new Game($('scene') as HTMLCanvasElement, this.net, this.audio, this.hud, $('floats'), $('joy-base'), $('joy-knob'));
    this.game.onOpenPanel = (tab) => this.hud.openTab(tab);
    this.bindUi();
    this.bindNet();
    setInterval(() => { this.hud.update(); this.tickTutorial(); this.devInfo(); }, 200);
    setInterval(() => this.updatePing(), 1000);
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
    const name = CLIENT.presetName ?? LocalStore.get().name ?? this.platform.playerName() ?? '';
    ($('name-input') as HTMLInputElement).value = name;
    $('loading-text').textContent = 'Подключаемся к серверу…';
    this.net.connect();
    document.addEventListener('visibilitychange', () => this.audio.suspend('hidden', document.hidden));
    window.addEventListener('blur', () => this.audio.suspend('blur', true));
    window.addEventListener('focus', () => this.audio.suspend('blur', false));
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
    if (s === 'settings') this.renderSettings();
    if (s === 'join') { this.setJoinError(''); setTimeout(() => $('code-input').focus(), 60); }
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
    $('lobby-mode').addEventListener('click', (e) => {
      const m = (e.target as HTMLElement).closest('button')?.dataset.mode as GameMode | undefined;
      if (m && this.isHost()) this.net.send({ t: C2S.SET_MODE, mode: m });
    });
    const code = $('code-input') as HTMLInputElement;
    code.addEventListener('input', () => {
      code.value = code.value.replace(/\D/g, '').slice(0, 6);
      this.setJoinError('');
      if (code.value.length === 6) this.onAction('connect'); // auto-submit
    });
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.onAction('connect'); });
    $('quality-seg').addEventListener('click', (e) => {
      const q = (e.target as HTMLElement).closest('button')?.dataset.q as QualityName | undefined;
      if (!q) return;
      LocalStore.set({ quality: q });
      this.game.applyQuality(resolveQuality(q));
      this.renderSettings();
    });
    $('set-music').onclick = () => { this.audio.setMusic(!this.audio.music); this.renderSettings(); };
    $('set-sfx').onclick = () => { this.audio.setSfx(!this.audio.sfx); this.renderSettings(); };
    if (!navigator.share) $('btn-share').classList.add('hidden');
    this.bindDev();
  }

  private needOnline(): boolean {
    if (this.net.isOpen) return true;
    alertToast('CONNECTION LOST — подожди пару секунд, переподключаемся…');
    return false;
  }

  private setJoinError(text: string) {
    $('join-error').textContent = text;
    $('code-input').classList.toggle('err', !!text);
    if (text) { $('btn-connect').classList.remove('loading'); this.joining = false; }
  }

  private onAction(act: string) {
    const r = this.room;
    switch (act) {
      case 'solo': if (this.needOnline()) { this.stopSearch(); this.net.send({ t: C2S.PLAY_SOLO }); } break;
      case 'friend': this.show('friend'); break;
      case 'quick': if (this.needOnline()) this.startSearch(); break;
      case 'shop': this.show('shop'); break;
      case 'leaderboard': this.show('leaderboard'); break;
      case 'settings': this.show('settings'); break;
      case 'back': this.show('menu'); break;
      case 'back-friend': this.show('friend'); break;
      case 'create': if (this.needOnline()) this.net.send({ t: C2S.CREATE_ROOM, mode: 'vs' }); break;
      case 'create-private': if (this.needOnline()) { this.stopSearch(); this.net.send({ t: C2S.CREATE_ROOM, mode: 'vs' }); } break;
      case 'join': this.show('join'); break;
      case 'paste':
        navigator.clipboard?.readText?.().then((t) => {
          const digits = (t.match(/\d{6}/)?.[0] ?? t.replace(/\D/g, '')).slice(0, 6);
          const input = $('code-input') as HTMLInputElement;
          input.value = digits;
          input.dispatchEvent(new Event('input'));
        }).catch(() => this.setJoinError('Не удалось прочитать буфер — введи код вручную'));
        break;
      case 'connect': {
        const c = ($('code-input') as HTMLInputElement).value;
        if (!/^\d{6}$/.test(c)) { this.setJoinError('INVALID CODE — нужно 6 цифр'); return; }
        if (this.joining) return;
        if (!this.net.isOpen) { this.setJoinError('CONNECTION LOST — переподключаемся, попробуй через секунду'); return; }
        this.joining = true;
        $('btn-connect').classList.add('loading');
        this.net.send({ t: C2S.JOIN_ROOM, code: c });
        setTimeout(() => { if (this.joining) this.setJoinError('Сервер не ответил — попробуй ещё раз'); }, 8000);
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
      case 'toggle-music': this.audio.setMusic(!this.audio.music); this.renderPause(); break;
      case 'toggle-sfx': this.audio.setSfx(!this.audio.sfx); this.renderPause(); break;
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
    this.game.syncRoom(emptyRoom(), '');
    this.platform.gameplayStop();
    this.show('menu');
    // Interstitial ONLY between matches (never during an active multiplayer match).
    if (this.wasPlaying) { this.wasPlaying = false; void this.platform.showFullscreen(); }
  }

  private isHost() {
    return !!this.room?.players.find((p) => p.id === this.net.playerId)?.isHost;
  }

  private togglePause() {
    if (this.screen === 'pause') { this.show(null); return; }
    if (this.room && this.room.status !== 'lobby') {
      $('leave-warn').textContent = this.room.mode === 'vs' && this.room.status === 'playing' ? 'Выход из VS матча = поражение.' : '';
      this.renderPause();
      this.show('pause');
    }
  }

  private renderPause() {
    $('pause-music').classList.toggle('off', !this.audio.music);
    $('pause-sfx').classList.toggle('off', !this.audio.sfx);
  }

  // ---------------------------------------------------------------- network

  /** Small ping indicator (🟢 / 🟡 / 🔴), refreshed once per second. */
  private updatePing() {
    if (this.net.status !== 'online') return;
    const r = Math.round(this.net.rtt);
    this.hud.setConnection(r < 100 ? 'ok' : r < 200 ? 'warn' : 'bad', `${r} ms`);
  }

  private onNetStatus(s: NetStatus) {
    const map: Record<NetStatus, ['ok' | 'warn' | 'bad', string]> = {
      online: ['ok', 'Connected'], connecting: ['warn', 'Connecting…'], reconnecting: ['warn', 'Reconnecting…'], offline: ['bad', 'Connection lost'],
    };
    const [cls, text] = map[s];
    const chip = $('conn-chip');
    chip.className = `conn ${cls}`;
    chip.querySelector('span')!.textContent = text;
    this.hud.setConnection(cls, s === 'online' ? `${Math.round(this.net.rtt) || '—'} ms` : text);
    const inMatch = !!this.room && this.room.status !== 'lobby' && this.room.status !== 'ended';
    $('reconnect').classList.toggle('hidden', s === 'online' || !inMatch);
    $('reconnect-attempt').textContent = `Attempt ${Math.max(1, this.net.attempts)}`;
    if (s !== 'online' && inMatch) this.wasDisconnected = true;
    if (s === 'online') {
      if (this.wasDisconnected) { this.hud.toast('✅ CONNECTED!', 'good'); this.audio.play('reconnect'); }
      this.wasDisconnected = false;
      this.renderMenu();
    }
  }

  private bindNet() {
    const n = this.net;
    n.onStatus((s) => this.onNetStatus(s));
    n.onAttempt(() => { $('reconnect-attempt').textContent = `Attempt ${n.attempts}`; });
    n.on(S2C.WELCOME, () => this.renderMenu());
    n.on(S2C.PROFILE, (m) => {
      this.renderMenu();
      if (this.screen === 'shop') this.renderShop();
      if (this.screen === 'settings') this.renderSettings();
      void this.platform.setLeaderboardScore(CLIENT.leaderboardName, m.profile.wins);
      void this.platform.cloudSave({ profileId: LocalStore.get().profileId, secret: LocalStore.get().secret });
    });
    n.on(S2C.ACHIEVEMENT, (m) => this.hud.achievement(m.id));
    n.on(S2C.ERROR, (m) => {
      this.audio.play('error');
      if (this.screen === 'join') { this.setJoinError(JOIN_ERRORS[m.code] ?? m.msg); return; }
      if (this.room && this.room.status !== 'lobby' && this.screen === null) this.hud.toast(m.msg, 'bad');
      else alertToast(m.msg);
      if (m.code === 'BAD_TOKEN' && this.room) { this.room = null; this.game.syncRoom(emptyRoom(), ''); this.show('menu'); }
      this.hud.update();
    });
    n.on(S2C.TOAST, (m) => this.hud.toast(m.text, m.kind));
    n.on(S2C.ROOM_JOINED, (m) => {
      this.joining = false;
      $('btn-connect').classList.remove('loading');
      this.stopSearch();
      this.applyRoom(m.room, true);
    });
    n.on(S2C.ROOM_STATE, (m) => this.applyRoom(m.room, false));
    n.on(S2C.ROOM_LEFT, (m) => {
      this.room = null;
      this.game.syncRoom(emptyRoom(), '');
      if (m.reason === 'error') alertToast('Матч прерван из-за ошибки сервера');
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
      if (m.id !== n.playerId) { this.hud.toast('✅ Игрок вернулся', 'good'); this.audio.play('joined'); }
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
      if (prev && prev.players.length < room.players.length && !joined) { this.audio.play('joined'); alertToast('👋 Игрок подключился!'); }
      return;
    }
    if (room.status === 'countdown' || room.status === 'playing') {
      $('reconnect').classList.add('hidden');
      if (this.screen !== null && this.screen !== 'pause') this.show(null);
      if (prev?.status !== room.status && room.status === 'countdown') this.tutorial.reset();
      this.platform.gameplayStart();
      this.wasPlaying = true;
      this.endedShown = '';
      return;
    }
    if (room.status === 'ended' && room.result) {
      this.platform.gameplayStop();
      this.hud.setTutorial(null);
      this.game.setTutorialPad(null);
      const key = room.roomId + room.startTime;
      if (this.endedShown !== key) {
        this.endedShown = key;
        const won = room.result.winnerIds.includes(myId);
        this.audio.play(won ? 'victory' : 'defeat');
        this.game.endCinematic(room.result);
        // Let the camera fly-over and celebration play before the results card.
        setTimeout(() => { if (this.room?.status === 'ended') { this.renderResults(); this.show('results'); } }, 3200);
      } else if (this.screen === 'results') {
        this.renderResults();
      }
    }
  }

  private tickTutorial() {
    const r = this.room;
    if (!r || r.status !== 'playing' || this.screen !== null) { if (!r || r.status !== 'playing') { this.hud.setTutorial(null); this.game.setTutorialPad(null); } return; }
    const biz = r.businesses.find((b) => b.ownerIds.includes(this.net.playerId ?? ''));
    const st = this.tutorial.step(biz, r.mode);
    this.hud.setTutorial(st?.text ?? null, st?.sub);
    this.game.setTutorialPad(st?.pad ?? null);
  }

  // ---------------------------------------------------------------- renders

  private renderMenu() {
    const p = this.net.profile;
    $('menu-coins').textContent = `🪙 ${p?.coins ?? 0}`;
    $('profile-line').textContent = p ? `🏆 ${p.wins} побед · ⭐ ${p.rating} · 🎮 ${p.gamesPlayed} матчей · 🏅 ${p.achievements?.length ?? 0}/${Object.keys(ACHIEVEMENTS).length}` : 'Подключение к серверу…';
  }

  private renderSettings() {
    const q = qualitySetting();
    for (const b of $('quality-seg').querySelectorAll('button')) b.classList.toggle('on', (b as HTMLElement).dataset.q === q);
    const eff = resolveQuality(q);
    $('quality-note').textContent = `Сейчас: ${eff.name.toUpperCase()} · тени ${eff.shadows ? 'вкл' : 'выкл'} · до ${eff.maxNpcs} NPC на бизнес${q === 'high' ? ' · сглаживание включится после перезапуска' : ''}`;
    $('set-music').classList.toggle('off', !this.audio.music);
    $('set-sfx').classList.toggle('off', !this.audio.sfx);
    const owned = new Set(this.net.profile?.achievements ?? []);
    $('ach-grid').innerHTML = (Object.keys(ACHIEVEMENTS) as AchievementId[]).map((id) => {
      const a = ACHIEVEMENTS[id];
      return `<div class="ach ${owned.has(id) ? 'on' : ''}">${a.icon} ${a.name}<small>${a.desc}</small></div>`;
    }).join('');
  }

  private renderLobby() {
    const r = this.room!;
    const myId = this.net.playerId;
    $('room-code').textContent = r.code;
    $('lobby-hint').textContent = r.isPrivate ? 'ROOM CODE · отправь другу' : 'QUICK MATCH · соперник найден!';
    const max = MATCH.maxPlayers[r.mode];
    $('lobby-waiting').classList.toggle('hidden', r.players.length >= max);
    const cards: string[] = [];
    for (let i = 0; i < max; i++) {
      const p = r.players.find((x) => x.slot === i);
      if (!p) { cards.push(`<div class="pcard empty">⏳ PLAYER ${i + 1}<br/>WAITING…</div>`); continue; }
      const ping = p.ping ? `${p.ping < 80 ? '🟢' : p.ping < 180 ? '🟡' : '🔴'} ${p.ping} ms` : '—';
      cards.push(`<div class="pcard ${p.id === myId ? 'me' : ''} ${p.ready ? 'ready-on' : ''}">
        <div class="slot">PLAYER ${i + 1}${p.isHost ? ' · 👑' : ''}${p.id === myId ? ' · ВЫ' : ''}</div>
        <div class="pname"><span class="dot" style="background:#${p.color.toString(16).padStart(6, '0')}"></span>${HAT_ICONS[p.hat] ?? ''} ${esc(p.name)}</div>
        <div class="ready ${p.ready ? 'ok' : ''}">${!p.connected ? '📡 переподключается…' : p.ready ? 'READY ✓' : 'не готов'}</div>
        <div class="muted small" style="text-align:left">PING ${ping}</div></div>`);
    }
    $('lobby-players').innerHTML = cards.join('');
    for (const b of $('lobby-mode').querySelectorAll('button')) b.classList.toggle('on', (b as HTMLElement).dataset.mode === r.mode);
    $('lobby-mode').classList.toggle('locked', !this.isHost());
    $('mode-desc').textContent = MODE_DESC[r.mode] + (this.isHost() ? '' : ' (режим выбирает хост)');
    const me = r.players.find((p) => p.id === myId);
    const readyBtn = $('btn-ready');
    readyBtn.textContent = me?.ready ? 'READY ✓' : 'READY';
    readyBtn.className = `btn ${me?.ready ? 'blue' : 'green'}`;
    const all = r.players.length === max && r.players.every((p) => p.ready && p.connected);
    ($('btn-start') as HTMLButtonElement).disabled = !all;
    $('btn-start').textContent = all ? '▶ START' : r.players.length < max ? 'WAITING…' : 'ЖДЁМ READY';
  }

  private renderResults() {
    const r = this.room!;
    const res = r.result!;
    const myId = this.net.playerId!;
    const won = res.winnerIds.includes(myId);
    const bizOf = (bid: number) => res.businesses.find((b) => b.id === bid)!;
    const meP = res.players.find((p) => p.id === myId);
    const opP = res.players.find((p) => p.id !== myId);
    const myB = meP ? bizOf(meP.businessId) : res.businesses[0];
    const opB = opP ? bizOf(opP.businessId) : undefined;
    let badge = '🏆', title = '', reason = '';
    const reasons: Record<string, string> = {
      time: 'Время вышло — победа по BUSINESS VALUE', goal: 'Командная цель выполнена!', forfeit: 'Соперник покинул матч (техническое поражение)',
      disconnect: 'Соперник не вернулся после потери связи', dev: 'Матч завершён',
    };
    if (res.mode === 'vs') {
      if (res.winnerIds.length === 0) { badge = '🤝'; title = 'DRAW!'; }
      else if (won) { badge = '🏆'; title = 'VICTORY'; }
      else { badge = '🥈'; title = '2ND PLACE'; }
      reason = reasons[res.reason] ?? '';
    } else {
      badge = won ? '🏬' : '⏰';
      title = won ? 'MEGA MALL COMPLETE!' : 'TIME IS UP';
      reason = won ? 'Вы построили MEGA MALL вместе!' : `Не хватило совсем чуть-чуть — попробуйте ещё раз`;
    }
    $('res-badge').textContent = badge;
    $('res-title').textContent = title;
    $('res-reason').textContent = reason;
    if (res.mode === 'vs' && opB) {
      const diff = Math.abs(myB.value - opB.value);
      $('res-score').innerHTML = `<div class="v ${won ? 'win' : ''}"><small>YOU</small><b>$${formatMoney(myB.value)}</b></div><span class="vs">VS</span>
        <div class="v ${!won && res.winnerIds.length ? 'win' : ''}"><small>${esc((opP?.name ?? 'OPPONENT').toUpperCase())}</small><b>$${formatMoney(opB.value)}</b></div>
        ${!won && res.winnerIds.length ? `<div class="diff">DIFFERENCE $${formatMoney(diff)} — в следующий раз получится!</div>` : ''}`;
    } else {
      $('res-score').innerHTML = `<div class="v ${won ? 'win' : ''}"><small>TEAM VALUE</small><b>$${formatMoney(myB.value)}</b></div>`;
    }
    const cols = res.mode === 'vs' ? res.players : [{ id: 'team', name: 'КОМАНДА', value: myB.value, businessId: myB.id }];
    const win = (id: string) => res.winnerIds.includes(id);
    const row = (label: string, f: (b: (typeof res.businesses)[0]) => string) => `<tr><td>${label}</td>${cols.map((c) => `<td class="${win(c.id) ? 'win' : ''}">${f(bizOf(c.businessId))}</td>`).join('')}</tr>`;
    $('res-table').innerHTML = `<tr><th></th>${cols.map((c) => `<th>${esc(c.name)}${c.id === myId ? ' (ты)' : ''}</th>`).join('')}</tr>` +
      row('Customers Served', (b) => formatMoney(b.customers)) +
      row('Buildings Built', (b) => String(b.buildings)) +
      row('Upgrades', (b) => String(b.upgrades)) +
      row('Peak Income', (b) => `$${formatMoney(b.peakIncome)}/мин`) +
      row('Total Income', (b) => `$${formatMoney(b.income)}`);
    const rw = res.rewards[myId];
    const ach = (rw?.achievements ?? []).map((a) => `<div class="chip">🏅 ${ACHIEVEMENTS[a].icon} ${ACHIEVEMENTS[a].name}</div>`).join('');
    $('res-rewards').innerHTML = rw ? `<div class="chip">🪙 +${rw.coins}</div>${rw.ratingDelta ? `<div class="chip">⭐ ${rw.ratingDelta > 0 ? '+' : ''}${rw.ratingDelta}</div>` : ''}${ach}` : '';
    const others = r.players.filter((p) => p.id !== myId);
    const me = r.players.find((p) => p.id === myId);
    const canRematch = r.players.length === MATCH.maxPlayers[r.mode] && r.status === 'ended';
    const rb = $('btn-rematch') as HTMLButtonElement;
    rb.disabled = !canRematch || !!me?.rematch;
    rb.textContent = me?.rematch ? '⏳ Ждём соперника…' : !won && res.mode !== 'solo' ? '🔁 TRY AGAIN' : '🔁 REMATCH';
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
    this.audio.suspend('ad', true);
    const ok = await this.platform.showRewarded();
    this.audio.suspend('ad', false);
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
    $('lb-source').textContent = `🏆 WINS · источник: ${source}`;
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
    $('search-title').textContent = 'SEARCHING…';
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
    if (this.screen === 'search') { $('search-title').textContent = 'PLAYER FOUND!'; this.audio.play('joined'); }
  }

  // ---------------------------------------------------------------- dev tools

  private bindDev() {
    const dev = $('dev');
    $('dev-toggle').onclick = () => { dev.classList.toggle('collapsed'); $('dev-toggle').textContent = dev.classList.contains('collapsed') ? 'DEV ▸' : 'DEV ▾'; };
    // Dev tools exist only when the SERVER runs with DEV_TOOLS=1 (production rejects them anyway).
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

  /** Dev mode only: technical connection details. */
  private devInfo() {
    if ($('dev').classList.contains('hidden')) return;
    $('dev-info').textContent = `ws=${this.net.status} rtt=${Math.round(this.net.rtt)}ms off=${Math.round(this.net.offset)}ms fps=${this.game.fps} q=${this.game.quality.name}`;
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
    Object.assign(el.style, { position: 'fixed', left: '50%', bottom: 'calc(24px + env(safe-area-inset-bottom, 0px))', transform: 'translateX(-50%)', zIndex: '60' });
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.display = 'block';
  clearTimeout(Number(el.dataset.t));
  el.dataset.t = String(setTimeout(() => { el!.style.display = 'none'; }, 2600));
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
