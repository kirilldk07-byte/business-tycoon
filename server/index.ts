import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ENV } from './config/env';
import { GameServer } from './networking/GameServer';
import { FileProfileStore, FileRoomStore } from './persistence/storage';
import { RoomManager } from './rooms/RoomManager';

// journald adds its own timestamps; keep ours for plain-file logs. Never log tokens/secrets.
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const startedAt = Date.now();
const VERSION = (() => {
  try { return String(JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version); } catch { return 'unknown'; }
})();

const profiles = new FileProfileStore(ENV.dataDir);
const rooms = new RoomManager(profiles, new FileRoomStore(ENV.dataDir), ENV.devTools, ENV.maxRooms, log);
const game = new GameServer(rooms, profiles, {
  devTools: ENV.devTools, allowedOrigins: ENV.allowedOrigins, maxConnectionsPerIp: ENV.maxConnectionsPerIp, log,
});

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wasm': 'application/wasm',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  // Health check for systemd/monitoring/deploy scripts: no secrets, no player data.
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ status: 'ok', version: VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000), devTools: ENV.devTools, ...game.stats }));
    return;
  }
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ok: true, devTools: ENV.devTools, ...game.stats }));
    return;
  }
  if (url.pathname === '/api/leaderboard') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(profiles.top(20).map((p) => ({ name: p.name, wins: p.wins, rating: p.rating }))));
    return;
  }
  // Static client (optional — in production the client is hosted by Yandex Games).
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  let file = path.join(ENV.publicDir, rel);
  if (!file.startsWith(ENV.publicDir)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // Missing assets (e.g. /sdk.js outside Yandex) must 404, not fall back to HTML.
    if (path.extname(rel)) { res.writeHead(404); res.end(); return; }
    file = path.join(ENV.publicDir, 'index.html');
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Client not built. Run npm run build.'); return; }
    const ext = path.extname(file);
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(buf);
  });
});

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws') { socket.destroy(); return; }
  game.handleUpgrade(req, socket, head);
});

// Graceful shutdown (systemctl stop/restart sends SIGTERM): persist rooms + profiles so a restart
// keeps matches resumable (clients reconnect within the 45 s grace window), then exit.
let stopping = false;
const shutdown = (sig: string) => {
  if (stopping) return;
  stopping = true;
  log(`${sig} received — saving state and shutting down`);
  try { rooms.stop(); profiles.flush(); } catch (e) { log(`shutdown save failed: ${(e as Error).message}`); }
  server.close();
  for (const ws of game.clients()) ws.close(1012, 'server restart');
  setTimeout(() => process.exit(0), 300).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

rooms.start(ENV.snapshotIntervalMs);
server.listen(ENV.port, ENV.host, () => {
  log(`Business Tycoon server on http://${ENV.host}:${ENV.port}  ws path /ws  devTools=${ENV.devTools}`);
});

