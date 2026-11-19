// Capture a FULL SD segment as clean H.264 Annex-B, our own code, local, no cloud.
// Frame header (32 bytes, decrypted): [1]=type(1=I,2=P,4=audio) [2..3]=u16 seq
// [6..7]=u16 payloadSize [10..11]=u16 ms-timestamp; video NAL payload starts at offset 32.
// We stream the replay, send continuation {"frames":N} when the socket drains, dedup video
// frames by sequence, and stop when the sequence stalls (segment end). Audio is dropped.
// Usage: node media-full.mjs <ip> <YYYY-MM-DD> <idx> [outfile] [maxSeconds]
import net from 'node:net';
import crypto from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import * as v from './v380lan.mjs';
import * as cipher from './cipher-sectype2.mjs';

const IP = process.argv[2] ?? '172.20.10.2';
const DAY = process.argv[3] ?? '2026-11-19';
const IDX = Number(process.argv[4] ?? 0);
const OUT = process.argv[5] ?? 'clip-full.local.h264';
const MAX_S = Number(process.argv[6] ?? 180);
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const MEDIA = 0x38030820, INFO = 0x38030822;

function req(sess, methodId, params) {
  const hj = { id: crypto.randomInt(10, 1e6), chn: 1, method_id: methodId, ts: Math.floor(Date.now() / 1000), params };
  const body = cipher.encrypt(Buffer.from(JSON.stringify(hj), 'latin1'), sess.sKey, 2);
  const h = Buffer.alloc(16); u32(v.CMD_COMMON_IOT).copy(h, 0); h[4] = 1; h[5] = 2; h[6] = sess.sid & 0xff; h[7] = 0; u32(body.length).copy(h, 12);
  return Buffer.concat([h, body]);
}
function decryptFrame(body, key, iv) {
  const n = body.length & ~15;
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv); d.setAutoPadding(false);
  return Buffer.concat([d.update(body.subarray(0, n)), d.final(), body.subarray(n)]);
}

async function main() {
  const sess = await v.keyExchange(IP, v.PORT, process.env.V380_LAN_PASS ?? 'origin');
  if (sess.result !== 1000) { console.log('auth fail', sess.result); return; }
  const key = sess.sKey.subarray(0, 16), iv = sess.sKey.subarray(16, 32);
  const [Y, M, D] = DAY.split('-').map(Number);
  const start = Date.UTC(Y, M - 1, D), end = Date.UTC(Y, M - 1, D, 23, 59, 59, 999);
  const { json } = await v.recFileList(IP, v.PORT, sess, { mode: 2, filter: 15, start, end });
  const list = (json?.data?.list || []).sort((a, b) => a.s - b.s);
  const seg = list[Math.min(IDX, list.length - 1)];
  const lStart = start + seg.s;
  console.log('segment', new Date(lStart).toISOString(), 'duration', (seg.d / 1000).toFixed(1), 's  sid', sess.sid);

  const sock = net.connect({ host: IP, port: v.PORT });
  const videoBySeq = new Map();            // seq -> {type, payload}
  let buf = Buffer.alloc(0);
  let maxSeq = -1, minSeq = Infinity, iFrames = 0, pFrames = 0, audio = 0;
  let lastNewSeqAt = Date.now(); const t0 = Date.now();
  const params = { sts: lStart, pts: lStart + 1, time_id: 0, frames: 400, speed: 10, mode: 2, video: 1, audio: 1, rtype: seg.t };

  await new Promise(resolve => {
    const finish = (why) => { clearInterval(pump); clearInterval(ka); clearInterval(watch); try { sock.destroy(); } catch {} console.log('stop:', why); resolve(); };
    sock.on('connect', () => sock.write(req(sess, 197154, params)));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 16) {
        const cmd = buf.readUInt32LE(0), size = buf.readUInt32LE(12);
        if (buf.length < 16 + size) break;
        const body = buf.subarray(16, 16 + size); buf = buf.subarray(16 + size);
        if (cmd !== MEDIA) continue;
        const dec = decryptFrame(body, key, iv);
        const type = dec[1], seq = dec.readUInt16LE(2);
        if (type === 4) { audio++; continue; }
        if (type === 1 || type === 2) {
          if (!videoBySeq.has(seq)) {
            videoBySeq.set(seq, { type, payload: dec.subarray(32) });
            if (type === 1) iFrames++; else pFrames++;
            if (seq > maxSeq) { maxSeq = seq; lastNewSeqAt = Date.now(); }
            if (seq < minSeq) minSeq = seq;
          }
        }
      }
    });
    sock.on('error', () => finish('socket error'));
    sock.on('close', () => finish('closed'));
    const pump = setInterval(() => { if (!sock.destroyed) sock.write(req(sess, 197154, { frames: 400 })); }, 500);
    const ka = setInterval(() => { if (!sock.destroyed) sock.write(req(sess, 0x30200, { flag: 2, tms1: 0, decode_tms: 0 })); }, 2000);
    const watch = setInterval(() => {
      if ((Date.now() - t0) > MAX_S * 1000) finish('max time');
      else if (Date.now() - lastNewSeqAt > 4000 && maxSeq >= 0) finish('sequence stalled (end)');
    }, 500);
  });

  // order by sequence; a clean segment starts at an I-frame
  const seqs = [...videoBySeq.keys()].sort((a, b) => a - b);
  const parts = [];
  for (const s of seqs) parts.push(videoBySeq.get(s).payload);
  const out = Buffer.concat(parts);
  await writeFile(new URL('./' + OUT, import.meta.url), out);
  console.log(`unique video frames ${videoBySeq.size} (I ${iFrames}, P ${pFrames}), audio ${audio}`);
  console.log(`seq range ${minSeq}..${maxSeq}, bytes ${out.length}, elapsed ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log('wrote', OUT);
}
main().catch(e => { console.error('ERROR', e.stack); process.exit(1); });
