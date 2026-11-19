// Sweep REPLAY_CTRL param variants to find the schema the camera accepts (clears
// code 1106 PARAM_ILLEGAL). Each variant: fresh connection, send one request, read the
// first control frame (plaintext), report result code. No changes to the camera.
// Usage: node replay-sweep.mjs <ip> <YYYY-MM-DD> <idx>
import net from 'node:net';
import crypto from 'node:crypto';
import * as v from './v380lan.mjs';
import * as cipher from './cipher-sectype2.mjs';

const IP = process.argv[2] ?? '172.20.10.2';
const DAY = process.argv[3] ?? '2026-11-19';
const IDX = Number(process.argv[4] ?? 0);
const REPLAY = 197154;
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };

function frame(sess, params) {
  const hj = { id: crypto.randomInt(10, 1e6), chn: 1, method_id: REPLAY, ts: Math.floor(Date.now() / 1000), params };
  const body = cipher.encrypt(Buffer.from(JSON.stringify(hj), 'latin1'), sess.sKey, 2);
  const h = Buffer.alloc(16); u32(v.CMD_COMMON_IOT).copy(h, 0); h[4] = 1; h[5] = 2; h[6] = sess.sid & 0xff; h[7] = 0; u32(body.length).copy(h, 12);
  return Buffer.concat([h, body]);
}

function sendOne(sess, params) {
  return new Promise(resolve => {
    const sock = net.connect({ host: IP, port: v.PORT, timeout: 6000 });
    let buf = Buffer.alloc(0); let got = null;
    const finish = r => { try { sock.destroy(); } catch {} resolve(r); };
    sock.on('connect', () => sock.write(frame(sess, params)));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 16) {
        const sec = buf[5], size = buf.readUInt32LE(12), mid = buf.readUInt32LE(8);
        if (buf.length < 16 + size) return;
        const b = buf.subarray(16, 16 + size); buf = buf.subarray(16 + size);
        let txt = null; try { txt = (sec === 0 ? b : cipher.decrypt(b, sess.sKey, sec)).toString('latin1'); } catch {}
        let code = null; try { code = JSON.parse(txt).result?.code; } catch {}
        if (got === null) { got = { mid, sec, size, code, txt: code == null ? txt?.slice(0, 80) : undefined }; }
        if (code != null) return finish({ ...got });      // got a control result
        if (size > 200) return finish({ mid, sec, size, note: 'stream frame (no result code) — likely media!' });
      }
    });
    sock.on('error', e => finish({ error: e.message }));
    setTimeout(() => finish(got ?? { note: 'no response' }), 4000);
  });
}

async function main() {
  const sess = await v.keyExchange(IP, v.PORT, process.env.V380_LAN_PASS ?? 'origin');
  if (sess.result !== 1000) { console.log('auth fail', sess.result); return; }
  const [Y, M, D] = DAY.split('-').map(Number);
  const start = Date.UTC(Y, M - 1, D, 0, 0, 0, 0), end = Date.UTC(Y, M - 1, D, 23, 59, 59, 999);
  const { json } = await v.recFileList(IP, v.PORT, sess, { mode: 2, filter: 15, start, end });
  const list = (json?.data?.list || []).sort((a, b) => a.s - b.s);
  const seg = list[Math.min(IDX, list.length - 1)];
  const lStart = start + seg.s, lEnd = lStart + seg.d;
  const rawOff = -new Date().getTimezoneOffset() * 60000; // ms
  const lPlay = lStart - rawOff;
  console.log('segment', { sOffsetMs: seg.s, durMs: seg.d, type: seg.t, lStart, absUTC: new Date(lStart).toISOString() });

  // Initial replay-START shape (native log 0x696): {sts, pts:0, time_id, rtype} — no frames/vsspec.
  const sec = Math.floor(lStart / 1000);
  const variants = {
    'A start sts=ms rtype=type':   { sts: lStart, pts: 0, time_id: 0, rtype: seg.t },
    'B start sts=ms rtype=0':      { sts: lStart, pts: 0, time_id: 0, rtype: 0 },
    'C start sts=sec rtype=type':  { sts: sec, pts: 0, time_id: 0, rtype: seg.t },
    'D start sts=sec rtype=0':     { sts: sec, pts: 0, time_id: 0, rtype: 0 },
    'E start sts=play rtype=type': { sts: lPlay, pts: 0, time_id: 0, rtype: seg.t },
    'F start sts=playSec rtype=t': { sts: Math.floor(lPlay/1000), pts: 0, time_id: 0, rtype: seg.t },
    'G start sts=seg rtype=type':  { sts: seg.s, pts: 0, time_id: 0, rtype: seg.t },
    'H start sts=ms rtype=15':     { sts: lStart, pts: 0, time_id: 0, rtype: 15 },
  };
  for (const [name, params] of Object.entries(variants)) {
    const r = await sendOne(sess, params);
    console.log(name.padEnd(32), JSON.stringify(r));
  }
}
main().catch(e => { console.error('ERROR', e.message); process.exit(1); });
