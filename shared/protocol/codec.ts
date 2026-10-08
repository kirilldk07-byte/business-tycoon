import type { ClientMsg, ServerMsg } from './messages';

// JSON over WebSocket. Kept behind encode/decode so it can be swapped for a
// binary format (e.g. msgpack) later without touching game code.
export const encode = (m: ClientMsg | ServerMsg): string => JSON.stringify(m);
export function decode<T>(raw: string): T | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && typeof v.t === 'string' ? (v as T) : null;
  } catch {
    return null;
  }
}

/** Round to 2 decimals to keep movement payloads compact. */
export const q2 = (n: number) => Math.round(n * 100) / 100;
