import path from 'node:path';

const bool = (v: string | undefined) => v === '1' || v === 'true';

export const ENV = {
  port: Number(process.env.PORT ?? 3040),
  host: process.env.HOST ?? '0.0.0.0',
  /** Dev tools (add money, end match...). MUST be off in production. */
  devTools: bool(process.env.DEV_TOOLS),
  dataDir: path.resolve(process.env.DATA_DIR ?? 'data'),
  publicDir: path.resolve(process.env.PUBLIC_DIR ?? 'dist/client'),
  /** Comma-separated list of allowed Origin headers; empty = allow all. */
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  snapshotIntervalMs: Number(process.env.ROOM_SNAPSHOT_MS ?? 3000),
  maxRooms: Number(process.env.MAX_ROOMS ?? 2000),
  maxConnectionsPerIp: Number(process.env.MAX_CONN_PER_IP ?? 20),
};
