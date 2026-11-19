// Test the media-channel key exchange (method 0x30108 = 196872, MVS_IOTC_MTHID_Q_TSK_EXCHANGE).
// Native: plaintext request {uuid, cS=base64(ephemeral X25519 pubkey)}; response.data.pubkC (base64)
// -> mediaKey = X25519(ourPriv, pubkC). Also returns data.sid, data.exp.
// Usage: node media-ke.mjs <ip>
import net from 'node:net';
import crypto from 'node:crypto';
import * as v from './v380lan.mjs';

const IP = process.argv[2] ?? '172.20.10.2';
const METHOD = 0x30108;
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };

// plaintext frame (secureType 0): header + raw JSON body
function plainFrame(methodId, params, sidByte = 0) {
  const hj = { id: crypto.randomInt(10, 1e6), chn: 1, method_id: methodId, ts: Math.floor(Date.now() / 1000), params };
  const body = Buffer.from(JSON.stringify(hj), 'latin1');
  const h = Buffer.alloc(16); u32(v.CMD_COMMON_IOT).copy(h, 0); h[4] = 1; h[5] = 0; h[6] = sidByte; h[7] = 0; u32(body.length).copy(h, 12);
  return Buffer.concat([h, body]);
}

async function tryKE(uuid, label) {
  const seed = v.appSeed();
  const { priv, pubRaw } = v.x25519FromScalar(seed);
  const params = { uuid, cS: pubRaw.toString('base64') };
  const sock = net.connect({ host: IP, port: v.PORT, timeout: 6000 });
  const r = await new Promise(resolve => {
    let buf = Buffer.alloc(0);
    sock.on('connect', () => sock.write(plainFrame(METHOD, params)));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 16) {
        const size = buf.readUInt32LE(12), sec = buf[5];
        if (buf.length >= 16 + size) {
          const body = buf.subarray(16, 16 + size);
          let txt = body.toString('latin1'); let json = null; try { json = JSON.parse(txt); } catch {}
          resolve({ sec, size, json, txt: json ? undefined : txt.slice(0, 120) });
        }
      }
    });
    sock.on('error', e => resolve({ error: e.message }));
    setTimeout(() => resolve({ note: 'timeout' }), 4000);
  });
  sock.destroy();
  let mediaKey = null;
  const pubkC = r.json?.data?.pubkC;
  if (pubkC) { const sk = v.x25519Shared(priv, Buffer.from(pubkC, 'base64')); mediaKey = sk.toString('hex'); }
  console.log(label, JSON.stringify({ code: r.json?.result?.code, data: r.json?.data, sec: r.sec, raw: r.txt, err: r.error, mediaKeyLen: mediaKey ? 32 : 0 }).slice(0, 300));
  return { r, mediaKey };
}

async function main() {
  // Establish login first (some firmwares require an active session before TSK exchange)
  const sess = await v.keyExchange(IP, v.PORT, process.env.V380_LAN_PASS ?? 'origin');
  console.log('login sid', sess.sid, 'result', sess.result);
  await tryKE(crypto.randomUUID(), 'A random uuid       ');
  await tryKE('', 'B empty uuid        ');
  await tryKE(String(sess.sid), 'C uuid=sid          ');
}
main().catch(e => { console.error('ERROR', e.stack); process.exit(1); });
