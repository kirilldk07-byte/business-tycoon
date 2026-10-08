import { LocalStore } from '../platform/LocalStore';

// All sounds are synthesized with WebAudio: zero asset downloads, tiny build.
export type Sfx =
  | 'money' | 'purchase' | 'construction' | 'upgrade' | 'customer' | 'countdown' | 'go'
  | 'victory' | 'defeat' | 'ui' | 'notify' | 'error' | 'emote' | 'jump' | 'produce';

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxGain!: GainNode;
  private musicGain!: GainNode;
  private musicOn = LocalStore.get().music ?? true;
  private sfxOn = LocalStore.get().sfx ?? true;
  private musicTimer = 0;
  private nextNoteTime = 0;
  private step = 0;
  private suspendedBy = new Set<string>();
  private lastPlay = new Map<Sfx, number>();

  /** Must be called from a user gesture (browser autoplay policy). */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(this.ctx.destination);
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = this.sfxOn ? 0.6 : 0;
      this.sfxGain.connect(this.master);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = this.musicOn ? 0.22 : 0;
      this.musicGain.connect(this.master);
      this.startMusic();
    }
    if (this.ctx.state === 'suspended' && this.suspendedBy.size === 0) void this.ctx.resume();
  }

  /** Pause all audio (ads, hidden tab). Reasons stack. */
  suspend(reason: string, on: boolean) {
    if (on) this.suspendedBy.add(reason); else this.suspendedBy.delete(reason);
    if (!this.ctx) return;
    if (this.suspendedBy.size > 0) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  get music() { return this.musicOn; }
  get sfx() { return this.sfxOn; }
  setMusic(on: boolean) {
    this.musicOn = on;
    LocalStore.set({ music: on });
    if (this.musicGain) this.musicGain.gain.value = on ? 0.22 : 0;
  }
  setSfx(on: boolean) {
    this.sfxOn = on;
    LocalStore.set({ sfx: on });
    if (this.sfxGain) this.sfxGain.gain.value = on ? 0.6 : 0;
  }

  private tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', vol = 0.3, slideTo?: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, start);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(vol, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(this.sfxGain);
    o.start(start);
    o.stop(start + dur + 0.02);
  }

  private noise(start: number, dur: number, vol = 0.2, hp = 800, out?: AudioNode) {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hp;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(out ?? this.sfxGain);
    src.start(start);
  }

  play(s: Sfx) {
    if (!this.ctx || !this.sfxOn) return;
    // Throttle very frequent sounds (customers paying en masse).
    const now = performance.now();
    const minGap = s === 'money' || s === 'customer' || s === 'produce' ? 70 : 20;
    if (now - (this.lastPlay.get(s) ?? 0) < minGap) return;
    this.lastPlay.set(s, now);
    const t = this.ctx.currentTime;
    switch (s) {
      case 'money': this.tone(1318, t, 0.08, 'square', 0.08); this.tone(1760, t + 0.06, 0.14, 'square', 0.08); break;
      case 'purchase':
        this.tone(880, t, 0.08, 'triangle', 0.25); this.tone(1320, t + 0.07, 0.1, 'triangle', 0.25);
        this.noise(t + 0.12, 0.15, 0.08, 4000); this.tone(1760, t + 0.14, 0.25, 'sine', 0.2); break;
      case 'construction':
        for (let i = 0; i < 4; i++) { this.noise(t + i * 0.18, 0.08, 0.25, 300); this.tone(140, t + i * 0.18, 0.08, 'square', 0.12); }
        break;
      case 'upgrade': [523, 659, 784, 1046].forEach((f, i) => this.tone(f, t + i * 0.07, 0.18, 'triangle', 0.22)); break;
      case 'customer': this.tone(600, t, 0.07, 'sine', 0.12, 900); break;
      case 'produce': this.tone(300, t, 0.06, 'square', 0.06, 500); break;
      case 'countdown': this.tone(660, t, 0.18, 'square', 0.18); break;
      case 'go': this.tone(880, t, 0.1, 'square', 0.2); this.tone(1320, t + 0.1, 0.35, 'square', 0.2); break;
      case 'victory':
        [523, 659, 784, 1046, 784, 1046].forEach((f, i) => this.tone(f, t + i * 0.13, i === 5 ? 0.6 : 0.16, 'triangle', 0.25));
        break;
      case 'defeat': [392, 349, 311, 262].forEach((f, i) => this.tone(f, t + i * 0.22, 0.3, 'triangle', 0.22)); break;
      case 'ui': this.tone(1000, t, 0.04, 'sine', 0.12); break;
      case 'notify': this.tone(988, t, 0.1, 'sine', 0.2); this.tone(1319, t + 0.11, 0.2, 'sine', 0.2); break;
      case 'error': this.tone(220, t, 0.15, 'sawtooth', 0.12); break;
      case 'emote': this.tone(700, t, 0.1, 'sine', 0.15, 1100); break;
      case 'jump': this.tone(300, t, 0.15, 'sine', 0.12, 600); break;
    }
  }

  // ---- light energetic tycoon loop (C - Am - F - G, 116 bpm) ----
  private startMusic() {
    this.nextNoteTime = this.ctx!.currentTime + 0.1;
    const tick = () => {
      const ctx = this.ctx!;
      while (this.nextNoteTime < ctx.currentTime + 0.25) {
        this.scheduleStep(this.step, this.nextNoteTime);
        this.nextNoteTime += 60 / 116 / 2; // eighth notes
        this.step = (this.step + 1) % 64;
      }
    };
    this.musicTimer = window.setInterval(tick, 60);
  }

  private scheduleStep(step: number, t: number) {
    const ctx = this.ctx!;
    const chords = [[262, 330, 392], [220, 262, 330], [175, 220, 262], [196, 247, 294]];
    const bass = [131, 110, 87, 98];
    const bar = Math.floor(step / 16) % 4;
    const n = (f: number, dur: number, type: OscillatorType, vol: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this.musicGain);
      o.start(t);
      o.stop(t + dur + 0.02);
    };
    const s = step % 16;
    if (s % 4 === 0) n(bass[bar], 0.3, 'triangle', 0.5);
    if (s % 4 === 2) n(bass[bar] * 2, 0.15, 'triangle', 0.25);
    if (s % 2 === 1) this.noise(t, 0.04, 0.05, 7000, this.musicGain);
    if (s === 0 || s === 6 || s === 10) chords[bar].forEach((f) => n(f * 2, 0.25, 'square', 0.05));
    const melody = [0, 2, 1, 2, 0, 1, 2, 1];
    if (s % 2 === 0 && (step >> 4) % 2 === 1) n(chords[bar][melody[(s / 2) % 8]] * 4, 0.12, 'sine', 0.08);
  }

  dispose() { clearInterval(this.musicTimer); void this.ctx?.close(); }
}
