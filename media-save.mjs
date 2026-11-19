// Retrieve an SD segment from the camera (local, no cloud) and save it as a playable
// H.264 Annex-B elementary stream, using our own reimplementation of the full protocol:
// LAN-pass login -> record-file-list -> replay request -> AES-128-CBC per-frame decrypt
// -> strip per-frame header -> concatenate NAL units.
// Usage: node media-save.mjs <ip> <YYYY-MM-DD> <idx> [seconds] [outfile]
import net from 'node:net';
import crypto from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import * as v from './v380lan.mjs';
import * as cipher from './cipher-sectype2.mjs';

const IP = process.argv[2] ?? '172.20.10.2';
const DAY = process.argv[3] ?? '2026-11-19';
const IDX = Number(process.argv[4] ?? 0);
const SECS = Number(process.argv[5] ?? 12);
const OUT = process.argv[6] ?? 'clip.local.h264';
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const MEDIA = 0x38030820, INFO = 0x38030822;

function req(sess, methodId, params) {
  const hj = { id: crypto.randomInt(10, 1e6), chn: 1, method_id: methodId, ts: Math.floor(Date.now() / 1000), params };
  const body = cipher.encrypt(Buffer.from(JSON.stringify(hj), 'latin1'), sess.sKey, 2);
  const h = Buffer.alloc(16); u32(v.CMD_COMMON_IOT).copy(h, 0); h[4] = 1; h[5] = 2; h[6] = sess.sid & 0xff; h[7] = 0; u32(body.length).copy(h, 12);
  return Buffer.concat([h, body]);
}

// AES-128-CBC no-pad over the 16-aligned prefix; tail (len%16) kept verbatim.
function decryptFrame(body, key, iv) {
  const n = body.length & ~15;
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv); d.setAutoPadding(false);
  return Buffer.concat([d.update(body.subarray(0, n)), d.final(), body.subarray(n)]);
}
// Find first Annex-B start code (00 00 01 or 00 00 00 01); return offset of the 00 00 01.
function firstStart(b) {
  for (let i = 0; i + 3 < b.length; i++)
    if (b[i] === 0 && b[i + 1] === 0 && (b[i + 2] === 1 || (b[i + 2] === 0 && b[i + 3] === 1))) return i;
  return -1;
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
  console.log('segment', new Date(lStart).toISOString(), 'dur', seg.d, 'ms  sid', sess.sid);

  const params = { sts: lStart, pts: lStart + 1, time_id: 0, frames: 200, speed: 10, mode: 2, video: 1, audio: 1, rtype: seg.t };
  const sock = net.connect({ host: IP, port: v.PORT });
  let buf = Buffer.alloc(0); let info = null; const vids = []; let nFrames = 0;
  await new Promise(resolve => {
    sock.on('connect', () => sock.write(req(sess, 197154, params)));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 16) {
        const cmd = buf.readUInt32LE(0), size = buf.readUInt32LE(12);
        if (buf.length < 16 + size) break;
        const body = buf.subarray(16, 16 + size); buf = buf.subarray(16 + size);
        if (cmd === INFO) { try { info = JSON.parse(cipher.decrypt(body, sess.sKey, 2).toString('latin1'))?.params?.info; } catch {} }
        else if (cmd === MEDIA) {
          nFrames++;
          const dec = decryptFrame(body, key, iv);
          const s = firstStart(dec);
          if (s >= 0) vids.push(dec.subarray(s)); // Annex-B NAL(s); audio frames have no start code -> skipped
        }
      }
    });
    sock.on('error', () => resolve());
    // periodically ask for more frames to cover the window
    const more = setInterval(() => { if (!sock.destroyed) sock.write(req(sess, 197154, { ...params, pts: 0, frames: 200 })); }, 1500);
    const ka = setInterval(() => { if (!sock.destroyed) sock.write(req(sess, 0x30200, { flag: 2, tms1: 0, decode_tms: 0 })); }, 2000);
    setTimeout(() => { clearInterval(more); clearInterval(ka); sock.destroy(); resolve(); }, SECS * 1000);
  });

  const out = Buffer.concat(vids);
  await writeFile(new URL('./' + OUT, import.meta.url), out);
  console.log('media frames:', nFrames, 'video NAL frames:', vids.length, 'bytes:', out.length);
  console.log('video info:', JSON.stringify(info?.vattr), 'audio:', JSON.stringify(info?.aattr));
  console.log('wrote', OUT);
}
main().catch(e => { console.error('ERROR', e.stack); process.exit(1); });
