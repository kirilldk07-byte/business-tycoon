// Opponent drops and never returns → after the grace window the VS match ends
// with a technical win for the remaining player.
import WebSocket from 'ws';
import { C2S, PROTOCOL_VERSION, S2C, type ServerMsg } from '../shared/protocol/messages';

const URL = process.env.WS_URL ?? 'ws://localhost:3040/ws';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function client(name: string) {
  const ws = new WebSocket(URL);
  const msgs: ServerMsg[] = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  const send = (m: object) => ws.send(JSON.stringify(m));
  const wait = async (t: string, pred: (m: any) => boolean = () => true, ms = 70_000) => {
    const s = Date.now();
    for (;;) {
      const i = msgs.findIndex((m) => m.t === t && pred(m));
      if (i >= 0) return msgs.splice(i, 1)[0] as any;
      if (Date.now() - s > ms) throw new Error(`${name} timeout ${t}`);
      await sleep(50);
    }
  };
  return { ws, send, wait, open: new Promise((r) => ws.on('open', () => { send({ t: C2S.HELLO, v: PROTOCOL_VERSION, name }); r(null); })) };
}
const A = client('GraceA'), B = client('GraceB');
await A.open; await B.open;
A.send({ t: C2S.CREATE_ROOM, mode: 'vs' });
const ja = await A.wait(S2C.ROOM_JOINED);
B.send({ t: C2S.JOIN_ROOM, code: ja.room.code });
await B.wait(S2C.ROOM_JOINED);
A.send({ t: C2S.PLAYER_READY, ready: true }); B.send({ t: C2S.PLAYER_READY, ready: true });
await A.wait(S2C.ROOM_STATE, (m) => m.room.players.every((p: any) => p.ready));
A.send({ t: C2S.START_MATCH });
await A.wait(S2C.ROOM_STATE, (m) => m.room.status === 'playing');
const t0 = Date.now();
B.ws.terminate();
await A.wait(S2C.PLAYER_DISCONNECTED);
const end = await A.wait(S2C.MATCH_END);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
const okk = end.result.reason === 'disconnect' && end.result.winnerIds[0] === ja.playerId;
console.log(okk ? `✓ opponent never returned → match ended after ${secs}s, remaining player wins (reason=disconnect)` : `✗ unexpected ${JSON.stringify(end.result)}`);
process.exit(okk ? 0 : 1);
