// Retrieve one SD segment's media stream and attempt to decrypt the video frames.
// Captures cmd 0x38030820 (media data) frames, then tries several decryption strategies
// derived from iotc_ms_frame_cipher (AES-128-CBC no-pad over the 16-aligned part) to find
// H.264/H.265 NAL start codes. Writes the raw elementary stream on success.
// Usage: node media-get.mjs <ip> <YYYY-MM-DD> <idx> [seconds]
import net from 'node:net';
import crypto from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import * as v from './v380lan.mjs';
import * as cipher from './cipher-sectype2.mjs';

const IP = process.argv[2] ?? '172.20.10.2';
const DAY = process.argv[3] ?? '2026-11-19';
const IDX = Number(process.argv[4] ?? 0);
const SECS = Number(process.argv[5] ?? 10);
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const MEDIA = 0x38030820, INFO = 0x38030822, ACK = 0x38030818;

function req(sess, methodId, params) {
  const hj = { id: crypto.randomInt(10, 1e6), chn: 1, method_id: methodId, ts: Math.floor(Date.now() / 1000), params };
  const body = cipher.encrypt(Buffer.from(JSON.stringify(hj), 'latin1'), sess.sKey, 2);
  const h = Buffer.alloc(16); u32(v.CMD_COMMON_IOT).copy(h, 0); h[4] = 1; h[5] = 2; h[6] = sess.sid & 0xff; h[7] = 0; u32(body.length).copy(h, 12);
  return Buffer.concat([h, body]);
}

// AES-128-CBC no-pad over floor(n/16)*16 bytes; tail left as-is. iv optionally chained.
function cbcNoPad(buf, key, iv) {
  const n = buf.length & ~15;
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv); d.setAutoPadding(false);
  const head = Buffer.concat([d.update(buf.subarray(0, n)), d.final()]);
  return { out: Buffer.concat([head, buf.subarray(n)]), nextIv: n >= 16 ? buf.subarray(n - 16, n) : iv };
}

function scanNAL(b) {
  // find 00 00 00 01 or 00 00 01; report first few NAL type bytes
  const hits = [];
  for (let i = 0; i + 4 < b.length && hits.length < 6; i++) {
    if (b[i] === 0 && b[i+1] === 0 && ((b[i+2] === 1) || (b[i+2] === 0 && b[i+3] === 1))) {
      const nb = b[i+2] === 1 ? b[i+3] : b[i+4];
      hits.push({ off: i, h264: nb & 0x1f, h265: (nb >> 1) & 0x3f });
      i += 3;
    }
  }
  return hits;
}

async function main() {
  const sess = await v.keyExchange(IP, v.PORT, process.env.V380_LAN_PASS ?? 'origin');
  if (sess.result !== 1000) { console.log('auth fail', sess.result); return; }
  const key = sess.sKey.subarray(0, 16), iv0 = sess.sKey.subarray(16, 32);
  const [Y, M, D] = DAY.split('-').map(Number);
  const start = Date.UTC(Y, M - 1, D), end = Date.UTC(Y, M - 1, D, 23, 59, 59, 999);
  const { json } = await v.recFileList(IP, v.PORT, sess, { mode: 2, filter: 15, start, end });
  const list = (json?.data?.list || []).sort((a, b) => a.s - b.s);
  const seg = list[Math.min(IDX, list.length - 1)];
  const lStart = start + seg.s;
  console.log('segment', new Date(lStart).toISOString(), 'dur', seg.d, 'ms  sid', sess.sid);

  const params = { sts: lStart, pts: lStart + 1, time_id: 0, frames: 200, speed: 10, mode: 2, video: 1, audio: 1, rtype: seg.t };
  const sock = net.connect({ host: IP, port: v.PORT });
  const mediaFrames = []; let buf = Buffer.alloc(0); let info = null;
  await new Promise(resolve => {
    sock.on('connect', () => sock.write(req(sess, 197154, params)));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 16) {
        const cmd = buf.readUInt32LE(0), size = buf.readUInt32LE(12), sec = buf[5];
        if (buf.length < 16 + size) break;
        const body = buf.subarray(16, 16 + size); buf = buf.subarray(16 + size);
        if (cmd === INFO) { try { info = JSON.parse(cipher.decrypt(body, sess.sKey, 2).toString('latin1')); } catch {} }
        else if (cmd === MEDIA) mediaFrames.push(Buffer.from(body));
      }
    });
    sock.on('error', () => resolve());
    const ka = setInterval(() => { if (!sock.destroyed) sock.write(req(sess, 0x30200, { flag: 2, tms1: 0, decode_tms: 0 })); }, 2000);
    setTimeout(() => { clearInterval(ka); sock.destroy(); resolve(); }, SECS * 1000);
  });
  console.log('media frames:', mediaFrames.length, 'info codec:', info?.params?.info?.vattr?.codec);

  if (!mediaFrames.length) return;
  const f0 = mediaFrames[0];
  // Strategy 1: per-frame IV reset, decrypt aligned part
  const s1 = cbcNoPad(f0, key, iv0).out;
  console.log('f0 len', f0.length);
  console.log('S1 per-frame IV   NALs:', JSON.stringify(scanNAL(s1)));
  console.log('S1 head hex:', s1.subarray(0, 32).toString('hex'));
  // Strategy 2: raw (not encrypted at all?)
  console.log('S2 raw            NALs:', JSON.stringify(scanNAL(f0)));
  // Strategy 3: skip a per-frame header (try 4/8/16/32/64 byte offsets) then decrypt
  for (const hdr of [4, 8, 16, 24, 32, 64]) {
    const s = cbcNoPad(f0.subarray(hdr), key, iv0).out;
    const nals = scanNAL(s);
    if (nals.length) console.log(`S3 hdr=${hdr} NALs:`, JSON.stringify(nals), 'head', s.subarray(0,16).toString('hex'));
  }
  await writeFile(new URL('./media-f0.local.bin', import.meta.url), f0);
}
main().catch(e => { console.error('ERROR', e.stack); process.exit(1); });
