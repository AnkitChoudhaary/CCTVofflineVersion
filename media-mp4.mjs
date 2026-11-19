// Retrieve a full SD segment (video + AAC audio) from the camera, locally, and mux it into
// a timed MP4 using our own muxer (no ffmpeg). Our own code end-to-end.
// Usage: node media-mp4.mjs <ip> <YYYY-MM-DD> <idx> [outfile.mp4] [maxSeconds]
import net from 'node:net';
import crypto from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import * as v from './v380lan.mjs';
import * as cipher from './cipher-sectype2.mjs';
import { mux } from './mp4mux.mjs';

const IP = process.argv[2] ?? '172.20.10.2';
const DAY = process.argv[3] ?? '2026-11-19';
const IDX = Number(process.argv[4] ?? 0);
const OUT = process.argv[5] ?? 'clip.local.mp4';
const MAX_S = Number(process.argv[6] ?? 180);
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const MEDIA = 0x38030820, INFO = 0x38030822;

function req(sess, m, p) {
  const hj = { id: crypto.randomInt(10, 1e6), chn: 1, method_id: m, ts: Math.floor(Date.now() / 1000), params: p };
  const body = cipher.encrypt(Buffer.from(JSON.stringify(hj), 'latin1'), sess.sKey, 2);
  const h = Buffer.alloc(16); u32(v.CMD_COMMON_IOT).copy(h, 0); h[4] = 1; h[5] = 2; h[6] = sess.sid & 0xff; h[7] = 0; u32(body.length).copy(h, 12);
  return Buffer.concat([h, body]);
}
// V380 media frame decryption (from native iotc_ms_frame_cipher): the first 32 bytes are an
// encrypted header carrying the chunk size uVar6 @ off 22; only the header + the first uVar6
// bytes of the payload are AES-128-CBC encrypted (one continuous CBC per frame, IV reset per
// frame), and the remainder of the payload is PLAINTEXT. Decrypting the plaintext bulk was the
// bug behind the bottom/accumulating corruption.
function decFrame(body, key, iv) {
  if (body.length < 32) {
    const n = body.length & ~15; const d = crypto.createDecipheriv('aes-128-cbc', key, iv); d.setAutoPadding(false);
    return Buffer.concat([d.update(body.subarray(0, n)), d.final(), body.subarray(n)]);
  }
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv); d.setAutoPadding(false);
  const hdr = d.update(body.subarray(0, 32));          // decrypted 32-byte header
  const uVar6 = hdr.readUInt32LE(22);                  // encrypted chunk size for the payload
  let encBytes = Math.min(uVar6 >>> 0, body.length - 32);
  encBytes = encBytes & ~15;                           // CBC needs whole blocks
  const encDec = encBytes > 0 ? d.update(body.subarray(32, 32 + encBytes)) : Buffer.alloc(0);
  d.final();
  return Buffer.concat([hdr, encDec, body.subarray(32 + encBytes)]); // rest is plaintext
}
const firstNalType = b => { for (let i = 0; i + 4 < b.length; i++) if (b[i] === 0 && b[i+1] === 0 && (b[i+2] === 1 || (b[i+2]===0&&b[i+3]===1))) return b[i+2]===1 ? b[i+3]&0x1f : b[i+4]&0x1f; return -1; };
function findNal(frame, type) { for (const n of splitNals(frame)) if ((n[0] & 0x1f) === type) return n; return null; }
function splitNals(b){ const st=[]; for(let i=0;i+3<b.length;i++){ if(b[i]===0&&b[i+1]===0){ if(b[i+2]===1){st.push([i,3]);i+=2;} else if(b[i+2]===0&&b[i+3]===1){st.push([i,4]);i+=3;} } } return st.map(([p,n],k)=>b.subarray(p+n,k+1<st.length?st[k+1][0]:b.length)); }

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
  console.log('segment', new Date(lStart).toISOString(), 'duration', (seg.d / 1000).toFixed(1), 's');

  const sock = net.connect({ host: IP, port: v.PORT });
  const vByseq = new Map(), aByseq = new Map();
  let buf = Buffer.alloc(0); let sps = null, pps = null, asc = null;
  let maxV = -1, lastNewAt = Date.now(); const t0 = Date.now(); let dbg = 0;
  // Per-frame AES-128-CBC (no padding), key=sKey[0:16], IV reset per frame; tail (<16B) stays plaintext.
  const chainDecrypt = body => decFrame(body, key, iv);

  await new Promise(resolve => {
    const fin = (w) => { clearInterval(pump); clearInterval(ka); clearInterval(watch); try { sock.destroy(); } catch {}; console.log('stop:', w); resolve(); };
    sock.on('connect', () => sock.write(req(sess, 197154, { sts: lStart, pts: lStart + 1, time_id: 0, frames: 400, speed: 10, mode: 2, video: 1, audio: 1, rtype: seg.t })));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 16) {
        const cmd = buf.readUInt32LE(0), size = buf.readUInt32LE(12);
        if (buf.length < 16 + size) break;
        const body = buf.subarray(16, 16 + size); buf = buf.subarray(16 + size);
        if (cmd !== MEDIA) continue;
        const f = chainDecrypt(body); const type = f[1], seq = f.readUInt16LE(2);
        const hdrLen = body.length - f.readUInt16LE(6); // total - payloadSize
        const payload = f.subarray(hdrLen);
        if ((type === 1 || type === 2) && dbg < 40) { const sc = payload[0]===0&&payload[1]===0&&(payload[2]===1||(payload[2]===0&&payload[3]===1)); if (hdrLen !== 32 || !sc) console.log('FRAME seq', seq, 'type', type, 'hdrLen', hdrLen, 'startCode', sc, 'p0', payload.subarray(0,6).toString('hex')); dbg++; }
        if (type === 1 || type === 2) {
          if (!vByseq.has(seq)) {
            vByseq.set(seq, { payload, key: type === 1 });
            if (!sps) sps = findNal(payload, 7); if (!pps) pps = findNal(payload, 8);
            void 0;
            if (seq > maxV) { maxV = seq; lastNewAt = Date.now(); }
          }
        } else if (type === 4) {
          if (payload[0] === 0xff && (payload[1] & 0xf0) === 0xf0) { // ADTS sync
            if (!aByseq.has(seq)) {
              const hdrLen = (payload[1] & 1) ? 7 : 9;
              aByseq.set(seq, payload.subarray(hdrLen));
              if (!asc) { const aot = ((payload[2] >> 6) & 3) + 1, sf = (payload[2] >> 2) & 0xf, ch = ((payload[2] & 1) << 2) | ((payload[3] >> 6) & 3); const v = (aot << 11) | (sf << 7) | (ch << 3); asc = Buffer.from([(v >> 8) & 255, v & 255]); }
            }
          }
        }
      }
    });
    sock.on('error', () => fin('err')); sock.on('close', () => fin('closed'));
    const pump = process.env.NO_PUMP ? {unref(){}} : setInterval(() => { if (!sock.destroyed) sock.write(req(sess, 197154, { frames: 400 })); }, 500);
    const ka = setInterval(() => { if (!sock.destroyed) sock.write(req(sess, 0x30200, { flag: 2, tms1: 0, decode_tms: 0 })); }, 2000);
    const CAP = Number(process.env.FRAME_CAP || 0);
    const watch = setInterval(() => { if (CAP && vByseq.size >= CAP) fin('frame cap'); else if (Date.now() - t0 > MAX_S * 1000) fin('maxtime'); else if (Date.now() - lastNewAt > 4000 && maxV >= 0) fin('sequence end'); }, 300);
  });

  const vSeqs = [...vByseq.keys()].sort((a, b) => a - b);
  const aSeqs = [...aByseq.keys()].sort((a, b) => a - b);
  const videoFrames = vSeqs.map(k => vByseq.get(k).payload);
  const keyframes = vSeqs.map((k, i) => vByseq.get(k).key ? i + 1 : 0).filter(Boolean); // 1-based sync samples
  const audioFrames = aSeqs.map(k => aByseq.get(k));
  if (!sps || !pps) { console.log('no SPS/PPS'); return; }
  const info = { width: 2304, height: 2592, rate: 8000 };
  const fps = 15; // this camera; avoids capped-clip timing error
  const videoTimescale = 90000, videoFrameDur = Math.round(videoTimescale / fps);
  const mp4 = mux({ videoFrames, audioFrames, width: info.width, height: info.height, videoTimescale, videoFrameDur, audioRate: info.rate, sps, pps, asc: asc ?? Buffer.from([0x15, 0x88]), keyframes });
  await writeFile(new URL('./' + OUT, import.meta.url), mp4);
  console.log(`video ${videoFrames.length}f @${fps.toFixed(1)}fps, audio ${audioFrames.length}f, asc ${(asc??Buffer.from([0x15,0x88])).toString('hex')}, mp4 ${(mp4.length/1e6).toFixed(1)} MB -> ${OUT}`);
}
main().catch(e => { console.error('ERROR', e.stack); process.exit(1); });
