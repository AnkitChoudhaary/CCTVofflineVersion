// Exploratory: open the media (getter) channel the way native getDataFromDeviceOrServer does
// (single TCP connection to 8089), send the full replay request and capture the raw stream.
// Read-only; writes raw frames to media-probe.local.bin + a JSON summary.
// Usage: node media-probe.mjs <ip> <YYYY-MM-DD> <idx> [mode=2] [seconds=8]
import net from 'node:net';
import crypto from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import * as v from './v380lan.mjs';
import * as cipher from './cipher-sectype2.mjs';

const IP = process.argv[2] ?? '172.20.10.2';
const DAY = process.argv[3] ?? '2026-11-19';
const IDX = Number(process.argv[4] ?? 0);
const MODE = Number(process.argv[5] ?? 2);
const SECS = Number(process.argv[6] ?? 8);
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };

function req(sess, methodId, params) {
  const hj = { id: crypto.randomInt(10, 1e6), chn: 1, method_id: methodId, ts: Math.floor(Date.now() / 1000), params };
  const body = cipher.encrypt(Buffer.from(JSON.stringify(hj), 'latin1'), sess.sKey, 2);
  const h = Buffer.alloc(16); u32(v.CMD_COMMON_IOT).copy(h, 0); h[4] = 1; h[5] = 2; h[6] = sess.sid & 0xff; h[7] = 0; u32(body.length).copy(h, 12);
  return Buffer.concat([h, body]);
}

async function main() {
  const sess = await v.keyExchange(IP, v.PORT, process.env.V380_LAN_PASS ?? 'origin');
  if (sess.result !== 1000) { console.log('auth fail', sess.result); return; }
  const [Y, M, D] = DAY.split('-').map(Number);
  const start = Date.UTC(Y, M - 1, D), end = Date.UTC(Y, M - 1, D, 23, 59, 59, 999);
  const { json } = await v.recFileList(IP, v.PORT, sess, { mode: 2, filter: 15, start, end });
  const list = (json?.data?.list || []).sort((a, b) => a.s - b.s);
  const seg = list[Math.min(IDX, list.length - 1)];
  const lStart = start + seg.s;
  console.log('segment', { s: seg.s, durMs: seg.d, type: seg.t, utc: new Date(lStart).toISOString(), sid: sess.sid });

  // getter streaming params: pts = playTime+1 (non-zero), speed=10(=x1), mode, video/audio=1
  const params = { sts: lStart, pts: lStart + 1, time_id: 0, frames: 200, speed: 10, mode: MODE, video: 1, audio: 1, rtype: seg.t };
  const sock = net.connect({ host: IP, port: v.PORT });
  const chunks = []; let total = 0;
  const t0 = Date.now();
  await new Promise(resolve => {
    sock.on('connect', () => { sock.write(req(sess, 197154, params)); });
    sock.on('data', d => { chunks.push(d); total += d.length; });
    sock.on('error', e => { console.log('err', e.message); resolve(); });
    sock.on('close', resolve);
    // keep-alive like native (method 0x30200 {flag:2, tms1:0, decode_tms:0}) every 2 s
    const ka = setInterval(() => { if (!sock.destroyed) sock.write(req(sess, 0x30200, { flag: 2, tms1: 0, decode_tms: 0 })); }, 2000);
    setTimeout(() => { clearInterval(ka); sock.destroy(); resolve(); }, SECS * 1000);
  });
  const raw = Buffer.concat(chunks);
  console.log(`received ${raw.length} bytes in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await writeFile(new URL('./media-probe.local.bin', import.meta.url), raw);

  // Walk 16-byte-header frames: cmd@0, ver@4, secType@5, b6@6, b7@7, u32@8, size@12
  const frames = []; let o = 0;
  while (o + 16 <= raw.length && frames.length < 4000) {
    const cmd = raw.readUInt32LE(o), size = raw.readUInt32LE(o + 12);
    if (o + 16 + size > raw.length) { frames.push({ off: o, cmd, size, partial: true }); break; }
    const hdr = raw.subarray(o, o + 16).toString('hex');
    const body = raw.subarray(o + 16, o + 16 + size);
    let json = null;
    if (raw[o + 5] === 0) { try { json = JSON.parse(body.toString('latin1')); } catch {} }
    else if (raw[o + 5] === 2 && size % 16 === 0 && size < 4096) { try { json = JSON.parse(cipher.decrypt(body, sess.sKey, 2).toString('latin1')); } catch {} }
    frames.push({ off: o, cmd: '0x' + cmd.toString(16), size, hdr, json, bodyHead: json ? undefined : body.subarray(0, 24).toString('hex') });
    o += 16 + size;
  }
  const kinds = {};
  for (const f of frames) { const k = `${f.cmd} sec=${f.hdr?.slice(10, 12)}`; kinds[k] = (kinds[k] || 0) + 1; }
  console.log('frames parsed', frames.length, 'leftover', raw.length - o, kinds);
  for (const f of frames.slice(0, 14)) console.log(JSON.stringify(f).slice(0, 260));
  await writeFile(new URL('./media-probe.local.json', import.meta.url), JSON.stringify({ seg, params, frames: frames.slice(0, 300) }, null, 1));
}
main().catch(e => { console.error('ERROR', e.stack); process.exit(1); });
