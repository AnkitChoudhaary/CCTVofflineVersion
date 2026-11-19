// List SD recordings for specific day(s) in LIST mode (per-day). The BRIEF bitmask
// gives which days have data; this enumerates segments for a given day.
// Usage: node sd-day.mjs <cameraIp> <YYYY-MM-DD> [YYYY-MM-DD ...]
//   TZ handling: queries [00:00:00, 23:59:59.999] of the day, interpreted in the
//   machine's local time AND in UTC, since the camera's day boundary TZ is unconfirmed.
import * as v from './v380lan.mjs';

const IP = process.argv[2] ?? '172.20.10.2';
const days = process.argv.slice(3);
const LAN_PASS = process.env.V380_LAN_PASS ?? 'origin';
const fmt = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

async function queryDay(sess, label, start, end) {
  const { json } = await v.recFileList(IP, v.PORT, sess, { mode: 2, filter: 15, start, end });
  const data = json?.data ?? {};
  const list = data.list || [];
  return { label, window: `${fmt(start)}..${fmt(end)}`, code: json?.result?.code,
    count: list.length, slice: data.slice, flag: data.flag,
    sample: list.slice(0, 8).map(d => ({ sMsFromStart: d.s, durMs: d.d, type: d.t })) };
}

async function main() {
  const sess = await v.keyExchange(IP, v.PORT, LAN_PASS);
  console.log('auth:', JSON.stringify({ result: sess.result, origin: sess.origin, sid: sess.sid, haveKey: !!sess.sKey }));
  if (sess.result !== 1000 || !sess.sKey) return;
  for (const d of days) {
    const [Y, M, D] = d.split('-').map(Number);
    const utcStart = Date.UTC(Y, M - 1, D, 0, 0, 0, 0);
    const utcEnd = Date.UTC(Y, M - 1, D, 23, 59, 59, 999);
    const locStart = new Date(Y, M - 1, D, 0, 0, 0, 0).getTime();
    const locEnd = new Date(Y, M - 1, D, 23, 59, 59, 999).getTime();
    console.log(d, 'UTC  ->', JSON.stringify(await queryDay(sess, d + ' UTC', utcStart, utcEnd)));
    console.log(d, 'local->', JSON.stringify(await queryDay(sess, d + ' local', locStart, locEnd)));
  }
}
main().catch(e => { console.error('ERROR', e.message); process.exit(1); });
