// Thin wrapper over the official Yandex Games SDK (https://yandex.ru/dev/games/doc/ru/sdk/sdk-about).
// Only documented methods are used. Every call degrades gracefully when the
// game runs outside Yandex Games (local dev, direct link testing).
//
// NOTE: The SDK is NOT a multiplayer transport. Real-time play goes through
// our own WebSocket server (see multiplayer/Net.ts).

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global { interface Window { YaGames?: { init(opts?: object): Promise<any> } } }

function loadScript(src: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    const t = setTimeout(() => resolve(false), timeoutMs);
    s.onload = () => { clearTimeout(t); resolve(!!window.YaGames); };
    s.onerror = () => { clearTimeout(t); resolve(false); };
    document.head.appendChild(s);
  });
}

export class Platform {
  ysdk: any = null;
  player: any = null;
  lang = 'ru';
  private adOpen = false;
  onAdState: (open: boolean) => void = () => {};
  /** Platform pause (ads, purchase window, tab switch, minimize). Multiplayer time keeps running on the server. */
  onPlatformPause: (paused: boolean) => void = () => {};
  private gameplayActive = false;
  private wantGameplay = false;

  get available() { return !!this.ysdk; }

  async init() {
    // On Yandex the SDK is served from the same origin at /sdk.js.
    if (!window.YaGames) await loadScript('/sdk.js', 4000);
    if (!window.YaGames) { console.info('[platform] Yandex SDK not available — standalone mode'); return; }
    try {
      this.ysdk = await window.YaGames.init();
      this.lang = this.ysdk.environment?.i18n?.lang ?? 'ru';
      try { this.player = await this.ysdk.getPlayer(); } catch { this.player = null; }
      // https://yandex.ru/dev/games/doc/ru/sdk/sdk-events — pause/resume events
      try {
        this.ysdk.on?.('game_api_pause', () => this.onPlatformPause(true));
        this.ysdk.on?.('game_api_resume', () => this.onPlatformPause(false));
      } catch { /* older SDK */ }
      console.info('[platform] Yandex SDK ready, lang =', this.lang);
    } catch (e) {
      console.warn('[platform] YaGames.init failed', e);
      this.ysdk = null;
    }
  }

  /** Tell the platform the game finished loading (required for moderation). */
  loadingReady() { this.ysdk?.features?.LoadingAPI?.ready(); }
  /** Gameplay markup; idempotent so start() isn't sent twice. */
  gameplayStart() {
    this.wantGameplay = true;
    if (this.gameplayActive || this.adOpen) return;
    this.gameplayActive = true;
    this.ysdk?.features?.GameplayAPI?.start();
  }
  gameplayStop() {
    this.wantGameplay = false;
    if (!this.gameplayActive) return;
    this.gameplayActive = false;
    this.ysdk?.features?.GameplayAPI?.stop();
  }

  playerName(): string | null {
    try {
      if (this.player?.isAuthorized?.()) return this.player.getName() || null;
    } catch { /* ignore */ }
    return null;
  }

  async cloudLoad(): Promise<Record<string, unknown> | null> {
    try { return this.player ? await this.player.getData() : null; } catch { return null; }
  }

  async cloudSave(data: Record<string, unknown>) {
    try { await this.player?.setData(data, true); } catch { /* ignore */ }
  }

  /** Interstitial — only between matches, never during gameplay. */
  showFullscreen(): Promise<void> {
    if (!this.ysdk) return Promise.resolve();
    return new Promise((resolve) => {
      this.ysdk.adv.showFullscreenAdv({
        callbacks: {
          onOpen: () => this.setAd(true),
          onClose: () => { this.setAd(false); resolve(); },
          onError: () => { this.setAd(false); resolve(); },
        },
      });
    });
  }

  /** Rewarded video. Resolves true only if onRewarded fired. */
  showRewarded(): Promise<boolean> {
    if (!this.ysdk) {
      // Standalone build: simulate for testing so the flow can be verified.
      return new Promise((r) => setTimeout(() => r(confirm('[DEV] Реклама недоступна вне Яндекс Игр. Засчитать просмотр?')), 50));
    }
    return new Promise((resolve) => {
      let rewarded = false;
      this.ysdk.adv.showRewardedVideo({
        callbacks: {
          onOpen: () => this.setAd(true),
          onRewarded: () => { rewarded = true; },
          onClose: () => { this.setAd(false); resolve(rewarded); },
          onError: () => { this.setAd(false); resolve(false); },
        },
      });
    });
  }

  private setAd(open: boolean) {
    if (this.adOpen === open) return;
    this.adOpen = open;
    if (open && this.gameplayActive) { this.gameplayActive = false; this.ysdk?.features?.GameplayAPI?.stop(); }
    if (!open && this.wantGameplay) this.gameplayStart();
    this.onAdState(open);
  }

  async setLeaderboardScore(name: string, score: number) {
    try {
      if (!this.ysdk || !this.player?.isAuthorized?.()) return;
      if (await this.ysdk.isAvailableMethod('leaderboards.setScore')) await this.ysdk.leaderboards.setScore(name, score);
    } catch (e) { console.warn('[platform] setScore failed', e); }
  }

  async getLeaderboard(name: string): Promise<{ rank: number; name: string; score: number }[] | null> {
    if (!this.ysdk) return null;
    try {
      const res = await this.ysdk.leaderboards.getEntries(name, { quantityTop: 10, includeUser: true, quantityAround: 2 });
      return (res.entries ?? []).map((e: any) => ({ rank: e.rank, name: e.player?.publicName || 'Игрок', score: e.score }));
    } catch (e) {
      console.warn('[platform] getEntries failed', e);
      return null;
    }
  }
}
