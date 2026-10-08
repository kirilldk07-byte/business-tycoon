// Client configuration. The production WebSocket URL is baked at build time
// via VITE_WS_URL (e.g. wss://game.example.com/ws). Fallback: same host /ws.

const params = new URLSearchParams(location.search);

function resolveWsUrl(): string {
  const override = params.get('server');
  if (override) return override;
  const env = import.meta.env.VITE_WS_URL as string | undefined;
  if (env) return env;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export const CLIENT = {
  wsUrl: resolveWsUrl(),
  devRequested: params.get('dev') === '1' || import.meta.env.DEV,
  inviteCode: params.get('room') ?? params.get('join'),
  presetName: params.get('name'),
  leaderboardName: 'wins', // must match the technical name in Yandex Games console
  sendHz: 15,
  interpDelayMs: 110,
  pingIntervalMs: 2000,
};

export const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
