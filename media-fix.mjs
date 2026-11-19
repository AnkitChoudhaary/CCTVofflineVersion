// CORRECTED media retrieval: the camera encrypts the media stream as ONE continuous
// AES-128-CBC (key=sKey[0:16], IV=sKey[16:32], no padding) over the concatenation of all
// media frame BODIES (header+payload) in arrival order, with partial blocks carrying across
// frame boundaries. We concatenate the raw bodies, decrypt the whole stream once, then split
// back by the transport-known lengths. Fixes the bottom-of-frame (slice-tail) corruption.
// Usage: node media-fix.mjs <ip> <YYYY-MM-DD> <idx> [out.mp4] [maxSeconds]
import net from 'node:net';
import crypto from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import * as v from './v380lan.mjs';
import * as cipher from './cipher-sectype2.mjs';
import { mux } from './mp4mux.mjs';

const IP = process.argv[2] ?? '172.20.10.2';
const DAY = process.argv[3] ?? '2026-11-19';
const IDX = Number(process.argv[4] ?? 0);
const OUT = process.argv[5] ?? 'fix.local.mp4';
const MAX_S = Number(process.argv[6] ?? 180);
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const MEDIA = 0x38030820, INFO = 0x38030822;

function req(sess, m, p) {
  const hj = { id: crypto.randomInt(10, 1e6), chn: 1, method_id: m, ts: Math.floor(Date.now() / 1000), params: p };
  const body = cipher.encrypt(Buffer.from(JSON.stringify(hj), 'latin1'), sess.sKey, 2);
  const h = Buffer.alloc(16); u32(v.CMD_COMMON_IOT).copy(h, 0); h[4] = 1; h[5] = 2; h[6] = sess.sid & 0xff; h[7] = 0; u32(body.length).copy(h, 12);
  return Buffer.concat([h, body]);
}
function splitNals(b){ const st=[]; for(let i=0;i+3<b.length;i++){ if(b[i]===0&&b[i+1]===0){ if(b[i+2]===1){st.push([i,3]);i+=2;} else if(b[i+2]===0&&b[i+3]===1){st.push([i,4]);i+=3;} } } return st.map(([p,n],k)=>b.subarray(p+n,k+1<st.length?st[k+1][0]:b.length)); }
const findNal = (frame, type) => { for (const n of splitNals(frame)) if ((n[0] & 0x1f) === type) return n; return null; };

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
  console.log('segment', new Date(lStart).toISOString(), 'dur', (seg.d / 1000).toFixed(1), 's');

  const rawBodies = [];                // raw ciphertext bodies in arrival order
  const sock = net.connect({ host: IP, port: v.PORT });
  let buf = Buffer.alloc(0); let info = null; let lastDataAt = Date.now(); const t0 = Date.now();
  const CAP = Number(process.env.FRAME_CAP || 0); let mediaCount = 0;

  await new Promise(resolve => {
    const fin = (w) => { clearInterval(pump); clearInterval(ka); clearInterval(watch); try { sock.destroy(); } catch {}; console.log('stop:', w); resolve(); };
    sock.on('connect', () => sock.write(req(sess, 197154, { sts: lStart, pts: lStart + 1, time_id: 0, frames: 400, speed: 10, mode: 2, video: 1, audio: 1, rtype: seg.t })));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]); lastDataAt = Date.now();
      while (buf.length >= 16) {
        const cmd = buf.readUInt32LE(0), size = buf.readUInt32LE(12);
        if (buf.length < 16 + size) break;
        const body = buf.subarray(16, 16 + size); buf = buf.subarray(16 + size);
        if (cmd === INFO) { try { info = JSON.parse(cipher.decrypt(body, sess.sKey, 2).toString('latin1'))?.params?.info; } catch {} continue; }
        if (cmd !== MEDIA) continue;
        rawBodies.push(Buffer.from(body));
        mediaCount++;
      }
    });
    sock.on('error', () => fin('err')); sock.on('close', () => fin('closed'));
    const pump = process.env.NO_PUMP ? { } : setInterval(() => { if (!sock.destroyed) sock.write(req(sess, 197154, { frames: 400 })); }, 500);
    const ka = setInterval(() => { if (!sock.destroyed) sock.write(req(sess, 0x30200, { flag: 2, tms1: 0, decode_tms: 0 })); }, 2000);
    const watch = setInterval(() => {
      if (CAP && mediaCount >= CAP) fin('cap');
      else if (Date.now() - t0 > MAX_S * 1000) fin('maxtime');
      else if (Date.now() - lastDataAt > 4000 && mediaCount > 0) fin('idle end');
    }, 300);
  });
  // Continuous CBC over the WHOLE concatenation of media bodies (partial blocks carry across
  // frames). Decrypt the aligned prefix in one pass; the final <16B remainder stays as-is.
  const big = Buffer.concat(rawBodies);
  const alignedLen = big.length & ~15;
  const dall = crypto.createDecipheriv('aes-128-cbc', key, iv); dall.setAutoPadding(false);
  const full = Buffer.concat([dall.update(big.subarray(0, alignedLen)), dall.final(), big.subarray(alignedLen)]);

  // split by body offsets, parse, dedup
  const vByseq = new Map(), aByseq = new Map(); let sps=null, pps=null, asc=null;
  let off = 0;
  for (const rb of rawBodies) {
    const b = { off, len: rb.length }; off += rb.length;
    if (b.off + b.len > full.length) break;
    const f = full.subarray(b.off, b.off + b.len);
    const type = f[1], seq = f.readUInt16LE(2), hdrLen = b.len - f.readUInt16LE(6);
    const payload = f.subarray(hdrLen);
    if (type === 1 || type === 2) {
      if (!vByseq.has(seq)) { vByseq.set(seq, { payload, key: type === 1 }); if(!sps)sps=findNal(payload,7); if(!pps)pps=findNal(payload,8); }
    } else if (type === 4 && payload[0] === 0xff && (payload[1] & 0xf0) === 0xf0) {
      if (!aByseq.has(seq)) { aByseq.set(seq, payload.subarray((payload[1]&1)?7:9)); if(!asc){const aot=((payload[2]>>6)&3)+1,sf=(payload[2]>>2)&0xf,ch=((payload[2]&1)<<2)|((payload[3]>>6)&3);const vv=(aot<<11)|(sf<<7)|(ch<<3);asc=Buffer.from([(vv>>8)&255,vv&255]);} }
    }
  }
  const vSeqs=[...vByseq.keys()].sort((a,b)=>a-b), aSeqs=[...aByseq.keys()].sort((a,b)=>a-b);
  const videoFrames=vSeqs.map(k=>vByseq.get(k).payload);
  const keyframes=vSeqs.map((k,i)=>vByseq.get(k).key?i+1:0).filter(Boolean);
  const audioFrames=aSeqs.map(k=>aByseq.get(k));
  if(!sps||!pps){console.log('no SPS/PPS');return;}
  const W=info?.vattr?.width??2304, H=info?.vattr?.height??2592, RATE=info?.aattr?.samplerate??8000;
  const fps=15, videoTimescale=90000, videoFrameDur=Math.round(videoTimescale/fps);
  const mp4=mux({videoFrames,audioFrames,width:W,height:H,videoTimescale,videoFrameDur,audioRate:RATE,sps,pps,asc:asc??Buffer.from([0x15,0x88]),keyframes});
  await writeFile(new URL('./'+OUT,import.meta.url),mp4);
  console.log(`video ${videoFrames.length}f, audio ${audioFrames.length}f, ${W}x${H}, mp4 ${(mp4.length/1e6).toFixed(1)}MB -> ${OUT}`);
}
main().catch(e=>{console.error('ERROR',e.stack);process.exit(1);});
