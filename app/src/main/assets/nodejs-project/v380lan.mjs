// Shared V380 Pro new-platform LAN protocol (our own reimplementation).
// Primitives recovered statically from V380 Pro 2.2.92 + native libs (see findings md).
import net from 'node:net';
import crypto from 'node:crypto';
import * as cipher from './cipher-sectype2.mjs';

export const CMD_COMMON_IOT = 0x38030818;                 // 939722776
export const METHOD_ID_IOTC_LANPASS_REQUEST = 196870;
export const METHOD_ID_REC_FILE_LIST_REQUEST = 197152;
export const PORT = 8089;
export const PRE_SESSION_KEY = Buffer.from('363ae5281638cf84969a634e9f966a98b573d1ffe937b277d1f1d62b38748ae5', 'hex');

const u32le = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
export const sha256 = b => crypto.createHash('sha256').update(b).digest();

// --- X25519 (standard curve25519, matches native ED25519Utils) ---
const PK = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');
export function x25519FromScalar(scalar32) {
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PK, scalar32]), format: 'der', type: 'pkcs8' });
  const pubRaw = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { priv, pubRaw };
}
export function x25519Shared(priv, peerPubRaw) {
  const pub = crypto.createPublicKey({ key: Buffer.concat([SPKI, peerPubRaw]), format: 'der', type: 'spki' });
  return crypto.diffieHellman({ privateKey: priv, publicKey: pub });
}
export function appSeed() {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = ''; for (let i = 0; i < 32; i++) s += a[crypto.randomInt(a.length)];
  return Buffer.from(s, 'latin1');
}
const xorByte = (buf, b) => { const o = Buffer.alloc(buf.length); for (let i = 0; i < buf.length; i++) o[i] = buf[i] ^ b; return o; };
const nowS = () => Math.floor(Date.now() / 1000);
function customTZ() { const off = -new Date().getTimezoneOffset(); const s = off >= 0 ? '+' : '-'; const a = Math.abs(off); return `${s}${String(Math.floor(a/60)).padStart(2,'0')}:${String(a%60).padStart(2,'0')}`; }

// --- framing ---
export function buildRequest({ methodId, secureType = 2, sidByte = 0, magic = 0, params, key }) {
  const randId = crypto.randomInt(10, 1000010);
  const headerJson = { id: randId, method_id: methodId, chn: 1, ts: nowS(), params };
  const bodyEnc = cipher.encrypt(Buffer.from(JSON.stringify(headerJson), 'latin1'), key, secureType);
  const h = Buffer.alloc(16);
  u32le(CMD_COMMON_IOT).copy(h, 0);
  h[4] = 1; h[5] = secureType; h[6] = sidByte & 0xff; h[7] = magic & 0xff;
  u32le(bodyEnc.length).copy(h, 12);
  return { frame: Buffer.concat([h, bodyEnc]), randId };
}

function readExact(sock, n, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = []; let got = 0;
    const t = setTimeout(() => { cleanup(); reject(new Error('read timeout')); }, timeoutMs);
    function onData(d) { chunks.push(d); got += d.length; if (got >= n) { cleanup(); resolve(Buffer.concat(chunks).subarray(0, n)); } }
    function onEnd() { cleanup(); reject(new Error(`closed ${got}/${n}`)); }
    function onErr(e) { cleanup(); reject(e); }
    function cleanup() { clearTimeout(t); sock.off('data', onData); sock.off('end', onEnd); sock.off('error', onErr); }
    sock.on('data', onData); sock.on('end', onEnd); sock.on('error', onErr);
  });
}

// One request/response over a fresh TCP connection. Returns {header, json, raw}.
export async function request(ip, port, reqOpts, respKey) {
  const { frame } = buildRequest(reqOpts);
  const sock = net.connect({ host: ip, port, timeout: 8000 });
  try {
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('timeout', () => rej(new Error('connect timeout'))); sock.once('error', rej); });
    sock.write(frame);
    const rh = await readExact(sock, 16, 8000);
    const header = { cmd: rh.readUInt32LE(0), version: rh[4], secureType: rh[5], dataSize: rh.readUInt32LE(12) };
    let json = null, raw = null;
    if (header.cmd === CMD_COMMON_IOT && header.dataSize > 0 && header.dataSize < 1 << 20) {
      const enc = await readExact(sock, header.dataSize, 8000);
      raw = cipher.decrypt(enc, respKey, header.secureType).toString('latin1');
      try { json = JSON.parse(raw); } catch {}
    }
    return { header, json, raw };
  } finally { sock.destroy(); }
}

// LAN key exchange -> { result, origin, sid, sKey(32B) } using lanPass (default factory "origin").
export async function keyExchange(ip, port, lanPass = 'origin') {
  const seed = appSeed();
  const { priv, pubRaw } = x25519FromScalar(seed);
  const magic = crypto.randomInt(1, 128);
  const cKMbytes = xorByte(pubRaw, magic);
  const params = { act: 1, verify: {
    cKM: cKMbytes.toString('base64'),
    cS: sha256(Buffer.concat([cKMbytes, Buffer.from(lanPass, 'latin1')])).toString('base64'),
    tz: customTZ(), ts: nowS() } };
  const { json } = await request(ip, port,
    { methodId: METHOD_ID_IOTC_LANPASS_REQUEST, secureType: 2, sidByte: 0, magic, params, key: PRE_SESSION_KEY },
    PRE_SESSION_KEY);
  const result = json?.result?.code ?? json?.params?.result?.code ?? null;
  const verify = json?.data?.verify ?? json?.params?.data?.verify ?? null;
  let sid = null, sKey = null, origin = null;
  if (verify) {
    origin = verify.origin ?? null;
    if (verify.dK) sKey = x25519Shared(priv, Buffer.from(verify.dK, 'base64'));
    sid = verify.sid ?? null;
  }
  return { result, origin, sid, sKey, rawJson: json };
}

// SD recording list. mode: 1=brief,2=list,3=event. filter: 0=all. start/end epoch ms.
export async function recFileList(ip, port, session, { mode = 2, filter = 15, start, end }) {
  const params = { filter, mode, start, end };
  return request(ip, port,
    { methodId: METHOD_ID_REC_FILE_LIST_REQUEST, secureType: 2, sidByte: session.sid & 0xff, magic: 0, params, key: session.sKey },
    session.sKey);
}
