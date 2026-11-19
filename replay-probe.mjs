// Exploratory: send a REPLAY_CTRL request for one SD segment and capture the camera's
// response frames over a persistent connection, to learn the replay/download stream format.
// Does not change anything. Usage: node replay-probe.mjs <ip> <YYYY-MM-DD> <indexWithinDay>
import net from 'node:net';
import crypto from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import * as v from './v380lan.mjs';
import * as cipher from './cipher-sectype2.mjs';

const IP = process.argv[2] ?? '172.20.10.2';
const DAY = process.argv[3] ?? '2026-11-19';
const IDX = Number(process.argv[4] ?? 0);
const METHOD_ID_REPLAY_CTRL_REQUEST = 197154;

function u32le(n){const b=Buffer.alloc(4);b.writeUInt32LE(n>>>0,0);return b;}

async function main() {
  const sess = await v.keyExchange(IP, v.PORT, process.env.V380_LAN_PASS ?? 'origin');
  if (sess.result !== 1000 || !sess.sKey) { console.log('auth failed', sess.result); return; }
  console.log('auth ok sid', sess.sid);

  // get the segment from the day listing
  const [Y,M,D] = DAY.split('-').map(Number);
  const start = Date.UTC(Y,M-1,D,0,0,0,0), end = Date.UTC(Y,M-1,D,23,59,59,999);
  const { json } = await v.recFileList(IP, v.PORT, sess, { mode:2, filter:15, start, end });
  const list = (json?.data?.list||[]).sort((a,b)=>a.s-b.s);
  if (!list.length) { console.log('no segments'); return; }
  const seg = list[Math.min(IDX, list.length-1)];
  const absStart = start + seg.s;            // epoch ms
  console.log('segment', { sOffsetMs: seg.s, durMs: seg.d, type: seg.t, absStartUTC: new Date(absStart).toISOString() });

  // Replay START (verified: code 1000): {sts, pts:0, time_id, rtype}. No frames/vsspec.
  const params = { sts: absStart, pts: 0, time_id: 0, rtype: seg.t };
  const randId = crypto.randomInt(10,1000010);
  const headerJson = { id: randId, chn: 1, method_id: METHOD_ID_REPLAY_CTRL_REQUEST, ts: Math.floor(Date.now()/1000), params };
  const bodyEnc = cipher.encrypt(Buffer.from(JSON.stringify(headerJson),'latin1'), sess.sKey, 2);
  const h = Buffer.alloc(16); u32le(v.CMD_COMMON_IOT).copy(h,0); h[4]=1; h[5]=2; h[6]=sess.sid&0xff; h[7]=0; u32le(bodyEnc.length).copy(h,12);
  const req = Buffer.concat([h, bodyEnc]);

  // continuation request: {"frames": N} pulls media frames
  function contReq(nFrames) {
    const hj = { id: crypto.randomInt(10,1e6), chn: 1, method_id: METHOD_ID_REPLAY_CTRL_REQUEST, ts: Math.floor(Date.now()/1000), params: { frames: nFrames } };
    const be = cipher.encrypt(Buffer.from(JSON.stringify(hj),'latin1'), sess.sKey, 2);
    const hh = Buffer.alloc(16); u32le(v.CMD_COMMON_IOT).copy(hh,0); hh[4]=1; hh[5]=2; hh[6]=sess.sid&0xff; hh[7]=0; u32le(be.length).copy(hh,12);
    return Buffer.concat([hh, be]);
  }

  const sock = net.connect({ host: IP, port: v.PORT, timeout: 8000 });
  const frames = []; let buf = Buffer.alloc(0); let sentCont = false;
  const done = new Promise(resolve => {
    sock.on('connect', () => { console.log('connected, sending replay start'); sock.write(req); setTimeout(()=>{ if(!sock.destroyed){ console.log('sending continuation frames=200'); sock.write(contReq(200)); sentCont=true; } }, 400); });
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      // parse 16-byte-header frames
      while (buf.length >= 16) {
        const cmd = buf.readUInt32LE(0), sec = buf[5], size = buf.readUInt32LE(12), mid = buf.readUInt32LE(8);
        if (buf.length < 16 + size) break;
        const body = buf.subarray(16, 16 + size);
        buf = buf.subarray(16 + size);
        let dec = null, asJson = null;
        try { dec = sec === 0 ? body : cipher.decrypt(body, sess.sKey, sec); } catch {}
        if (dec) { try { asJson = JSON.parse(dec.toString('latin1')); } catch {} }
        frames.push({ cmd, methodId: mid, secureType: sec, size,
          bodyHex: body.toString('hex'),
          decText: dec && asJson ? dec.toString('latin1') : null,
          decHeadHex: dec ? dec.subarray(0, 48).toString('hex') : null,
          json: asJson });
        if (frames.length >= 40) { sock.destroy(); resolve(); return; }
      }
    });
    sock.on('error', e => { console.log('err', e.message); resolve(); });
    sock.on('close', () => resolve());
    setTimeout(() => { sock.destroy(); resolve(); }, 6000);
  });
  await done;
  console.log(`captured ${frames.length} frames`);
  for (const f of frames.slice(0, 12)) console.log(JSON.stringify(f).slice(0, 300));
  await writeFile(new URL('./replay-probe.local.json', import.meta.url), JSON.stringify({ segment: seg, params, frames }, null, 2) + '\n');
}
main().catch(e => { console.error('ERROR', e.message); process.exit(1); });
