// LAN-password key-exchange probe for V380 Pro new-platform cameras.
// Reimplements the Java LANPASS key exchange (findings-v380pro-2.2.92.md section 7)
// from our own code. It performs ONE key-exchange attempt (act:1), reads the result
// code and the camera's `origin` flag, and does NOT change any password or setting.
//
// Password handling:
//   - Default password is the app's built-in factory value "origin" (not a secret).
//   - To use a real LAN password, set env V380_LAN_PASS; it is never printed or logged.
//
// Usage:
//   node lan-login-probe.mjs [cameraIp] [port]
//   V380_LAN_PASS=... node lan-login-probe.mjs 172.20.10.2 8089
//
// STATUS: the body cipher (cipherJsonData, native, secureType 2) is filled in by
// cipher-sectype2.mjs once recovered from libhsMediaLibrary.so via Ghidra. Until then
// this script refuses to send (so it cannot accidentally spray malformed frames).

import net from 'node:net';
import crypto from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const CAM_IP = process.argv[2] ?? '172.20.10.2';
const PORT = Number(process.argv[3] ?? 8089);
const LAN_PASS = process.env.V380_LAN_PASS ?? 'origin';

const CMD_COMMON_IOT = 0x38030818;            // 939722776
const METHOD_ID_IOTC_LANPASS_REQUEST = 196870;
const METHOD_ID_IOTC_LANPASS_RESPONSE = 196871;
const PRE_SESSION_KEY = Buffer.from('363ae5281638cf84969a634e9f966a98b573d1ffe937b277d1f1d62b38748ae5', 'hex'); // LoginHelper.i

// --- little-endian helpers (Functions.IntToBytes / BytesToInt) ---
const u32le = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const rd32le = (b, o) => b.readUInt32LE(o);

// --- X25519 (ED25519Utils: native standard curve25519) ---
// Build an X25519 private key from a raw 32-byte scalar via a PKCS8 DER wrapper.
const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519_PREFIX  = Buffer.from('302a300506032b656e032100', 'hex');
function x25519FromScalar(scalar32) {
  const der = Buffer.concat([PKCS8_X25519_PREFIX, scalar32]);
  const priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const pubRaw = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { priv, pubRaw };
}
function x25519Shared(priv, peerPubRaw) {
  const pub = crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, peerPubRaw]), format: 'der', type: 'spki' });
  return crypto.diffieHellman({ privateKey: priv, publicKey: pub });
}
// App seed = 32 random ASCII chars (Functions.getCharAndNumr). Matches donna clamping.
function appSeed() {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += alpha[crypto.randomInt(alpha.length)];
  return Buffer.from(s, 'latin1');
}

const sha256 = b => crypto.createHash('sha256').update(b).digest();
const b64 = b => b.toString('base64');
function xorRepeat(buf, keyByte) { const o = Buffer.alloc(buf.length); for (let i = 0; i < buf.length; i++) o[i] = buf[i] ^ keyByte; return o; }

// --- native body cipher (secureType 2), filled from Ghidra recovery ---
let cipherSecType2;
try { cipherSecType2 = await import('./cipher-sectype2.mjs'); } catch (e) { cipherSecType2 = null; console.error('cipher import failed:', e.message); }

function buildRequestFrame(jsonObj, magic, sessionByte = 0) {
  const bodyPlain = Buffer.from(JSON.stringify(jsonObj), 'latin1');
  if (!cipherSecType2) throw new Error('cipher-sectype2.mjs not available yet (recover cipherJsonData first)');
  const bodyEnc = cipherSecType2.encrypt(bodyPlain, PRE_SESSION_KEY);
  const header = Buffer.alloc(16);
  u32le(CMD_COMMON_IOT).copy(header, 0);
  header[4] = 1;            // version
  header[5] = 2;            // secureType
  header[6] = sessionByte;  // b2
  header[7] = magic;        // b3 (magicNum)
  u32le(bodyEnc.length).copy(header, 12);
  return Buffer.concat([header, bodyEnc]);
}

function nowS() { return Math.floor(Date.now() / 1000); }
function customTZ() { const off = -new Date().getTimezoneOffset(); const s = off >= 0 ? '+' : '-'; const a = Math.abs(off); return `${s}${String(Math.floor(a/60)).padStart(2,'0')}:${String(a%60).padStart(2,'0')}`; }

async function readExact(sock, n, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = []; let got = 0; let timer = setTimeout(() => { cleanup(); reject(new Error('read timeout')); }, timeoutMs);
    function onData(d) { chunks.push(d); got += d.length; if (got >= n) { cleanup(); resolve(Buffer.concat(chunks).subarray(0, n)); } }
    function onEnd() { cleanup(); reject(new Error('socket closed (' + got + '/' + n + ')')); }
    function cleanup() { clearTimeout(timer); sock.off('data', onData); sock.off('end', onEnd); sock.off('error', onErr); }
    function onErr(e) { cleanup(); reject(e); }
    sock.on('data', onData); sock.on('end', onEnd); sock.on('error', onErr);
  });
}

async function run() {
  const out = { observedAt: new Date().toISOString(), camera: `${CAM_IP}:${PORT}`, usedFactoryValue: LAN_PASS === 'origin', steps: [] };
  const seed = appSeed();
  const { priv, pubRaw } = x25519FromScalar(seed);
  const magic = crypto.randomInt(1, 128);
  const randId = crypto.randomInt(10, 1000010);

  const cKMbytes = xorRepeat(pubRaw, magic);               // appPub XOR magic
  const cKM = b64(cKMbytes);
  const cS = b64(sha256(Buffer.concat([cKMbytes, Buffer.from(LAN_PASS, 'latin1')])));
  const params = { act: 1, verify: { cKM, cS, tz: customTZ(), ts: nowS() } };
  const headerJson = { id: randId, method_id: METHOD_ID_IOTC_LANPASS_REQUEST, chn: 1, ts: nowS(), params };

  if (!cipherSecType2) {
    out.steps.push({ step: 'blocked', reason: 'cipher-sectype2.mjs not yet available; frame not sent' });
    console.log(JSON.stringify(out, null, 2));
    await writeFile(new URL('./lan-login-probe.local.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
    return;
  }

  const frame = buildRequestFrame(headerJson, magic, 0);
  const sock = net.connect({ host: CAM_IP, port: PORT, timeout: 8000 });
  try {
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('timeout', () => rej(new Error('connect timeout'))); sock.once('error', rej); });
    out.steps.push({ step: 'connected' });
    sock.write(frame);
    const rh = await readExact(sock, 16, 8000);
    const resp = { cmd: rd32le(rh, 0), version: rh[4], secureType: rh[5], dataSize: rd32le(rh, 12) };
    out.steps.push({ step: 'response-header', cmd: resp.cmd, cmdOk: resp.cmd === CMD_COMMON_IOT, secureType: resp.secureType, dataSize: resp.dataSize });
    if (resp.dataSize > 0 && resp.dataSize < 65536) {
      const bodyEnc = await readExact(sock, resp.dataSize, 8000);
      const plain = cipherSecType2.decrypt(bodyEnc, PRE_SESSION_KEY, resp.secureType);
      let parsed = null; try { parsed = JSON.parse(plain.toString('latin1')); } catch {}
      const code = parsed?.result?.code ?? parsed?.params?.result?.code ?? null;
      const origin = parsed?.data?.verify?.origin ?? parsed?.params?.data?.verify?.origin ?? null;
      const dK = parsed?.data?.verify?.dK ?? parsed?.params?.data?.verify?.dK ?? null;
      let sessionKeyLen = null;
      if (dK) { const sk = x25519Shared(priv, Buffer.from(dK, 'base64')); sessionKeyLen = sk.length; }
      out.steps.push({ step: 'decoded', resultCode: code, origin, gotDK: !!dK, sessionKeyLen,
        meaning: code === 1000 ? 'OK' : code === 1119 ? 'password mismatch' : 'see ResultCode' });
      // NOTE: dS = b64(sha256(decode(dK))) integrity check and session-key use happen here; not persisted.
    }
  } catch (e) {
    out.steps.push({ step: 'error', error: e.message });
  } finally { sock.destroy(); }

  console.log(JSON.stringify(out, null, 2));
  await writeFile(new URL('./lan-login-probe.local.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
}
run();
