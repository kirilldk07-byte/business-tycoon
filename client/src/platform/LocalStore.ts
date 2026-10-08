// Per-device storage of THIS player's own credentials/settings only.
// Never used to exchange data between players.

const KEY = 'bt_v1';
interface Saved {
  profileId?: string;
  secret?: string;
  name?: string;
  session?: { token: string; at: number };
  music?: boolean;
  sfx?: boolean;
  quality?: string;
  tutorialDone?: boolean;
}

let cache: Saved = {};
try { cache = JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { cache = {}; }

export const LocalStore = {
  get: () => cache,
  set(patch: Partial<Saved>) {
    cache = { ...cache, ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* private mode */ }
  },
};
