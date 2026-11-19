// List SD recordings from a V380 Pro new-platform camera over the local hotspot,
// entirely without vendor cloud. Authenticates (factory LAN value "origin" by default;
// override with V380_LAN_PASS), reads the BRIEF month/day bitmask to find which days
// have recordings, then enumerates each day's segments (mode=LIST, all types).
// Usage: node sd-list.mjs [cameraIp]
import * as v from './v380lan.mjs';
import { writeFile } from 'node:fs/promises';

const IP = process.argv[2] ?? '172.20.10.2';
const LAN_PASS = process.env.V380_LAN_PASS ?? 'origin';
const pad = n => String(n).padStart(2, '0');
const fmtUTC = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
const TYPE = { 1: 'continuous', 2: 'motion', 4: 'alarm', 8: 'event' };

// Each BRIEF entry is "YYYYMM-<bitmask>"; bit i set => day (i+1) has recordings.
function daysFromBrief(entry) {
  const [ym, maskStr] = entry.split('-');
  const year = Number(ym.slice(0, 4)), month = Number(ym.slice(4, 6));
  const mask = Number(maskStr);
  const days = [];
  for (let i = 0; i < 31; i++) if (mask & (1 << i)) days.push({ year, month, day: i + 1 });
  return days;
}

async function main() {
  const out = { observedAt: new Date().toISOString(), camera: `${IP}:${v.PORT}`, cloudUsed: false };
  const sess = await v.keyExchange(IP, v.PORT, LAN_PASS);
  out.auth = { result: sess.result, origin: sess.origin, sid: sess.sid, haveSessionKey: !!sess.sKey };
  if (sess.result !== 1000 || !sess.sKey) { console.log(JSON.stringify(out, null, 2)); return; }

  // BRIEF over a wide window (covers the camera's whole retained range).
  const now = Date.now();
  const brief = await v.recFileList(IP, v.PORT, sess, { mode: 1, filter: 15, start: now - 3650 * 86400_000, end: now + 86400_000 });
  const briefEntries = brief.json?.data?.brief ?? [];
  out.briefRaw = briefEntries;
  const allDays = briefEntries.flatMap(daysFromBrief);
  out.daysWithRecordings = allDays.map(d => `${d.year}-${pad(d.month)}-${pad(d.day)}`);

  // Enumerate each day's segments (UTC day window).
  out.days = [];
  let total = 0;
  for (const d of allDays) {
    const start = Date.UTC(d.year, d.month - 1, d.day, 0, 0, 0, 0);
    const end = Date.UTC(d.year, d.month - 1, d.day, 23, 59, 59, 999);
    const { json } = await v.recFileList(IP, v.PORT, sess, { mode: 2, filter: 15, start, end });
    const list = json?.data?.list ?? [];
    const segs = list.map(x => ({
      startUTC: fmtUTC(start + x.s), durationS: Math.round(x.d / 1000),
      type: TYPE[x.t] ?? `t${x.t}`, sOffsetMs: x.s, raw: x }))
      .sort((a, b) => a.sOffsetMs - b.sOffsetMs);
    total += segs.length;
    out.days.push({ date: `${d.year}-${pad(d.month)}-${pad(d.day)}`, count: segs.length, dayStartUTC: start, segments: segs });
  }
  out.totalSegments = total;

  // Human-readable summary to stdout.
  console.log(`Camera ${IP} — SD recordings (local, no cloud). Auth OK (origin=${sess.origin}).`);
  for (const day of out.days) {
    console.log(`\n${day.date}  (${day.count} segments)`);
    for (const s of day.segments.slice(0, 40))
      console.log(`  ${s.startUTC}  ${String(s.durationS).padStart(4)}s  ${s.type}`);
    if (day.segments.length > 40) console.log(`  … ${day.segments.length - 40} more`);
  }
  console.log(`\nTotal: ${total} segments across ${out.days.length} day(s).`);
  await writeFile(new URL('./sd-list.local.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
}
main().catch(e => { console.error('ERROR', e.message); process.exit(1); });
