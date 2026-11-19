// v380cloud.mjs — V380 Pro CLOUD / remote-access ("MR" relay) path, our own reimplementation.
// Reaches a camera that is NOT on our LAN, through the vendor's relay ("transmit") servers, then
// speaks the SAME IoT protocol we already use locally (CMD_COMMON_IOT 0x38030818 + session-key
// AES-128-CBC). Only two things differ from LAN: (a) the session key is obtained via a tunnel /
// HTTP key-exchange instead of the LAN X25519 login, and (b) each OUTBOUND frame is wrapped in a
// 64-byte relay-forward header (cmd 1200). Reverse-engineered from V380 Pro 2.2.92 (see findings §24).
//
// Requires: a V380 account (creds supplied by the caller from env — NEVER hardcode/log them) and the
// camera BOUND to that account. LAN-pass mode keeps working unbound; this remote path does not.
//
// STATUS: transport primitives (forward-attach, 1200 wrapper, TSK key-exchange, dispatch signature)
// are reverse-engineered and solid. The account-login signature and the relay create-session request
// shape still need to be finalised against the live server (see the GAP notes) — do that with real
// credentials and few attempts (avoid account lockout).
import net from 'node:net';
import crypto from 'node:crypto';
import * as v from './v380lan.mjs';
import * as cipher from './cipher-sectype2.mjs';

// --- hardcoded vendor hosts (verbatim from HttpUtils / HttpUrlDefines <clinit>) ---
export const HOSTS = {
  api: 'https://mapi.av380.net',          // account + device-list REST (fallback http://mapi.av380.net:8002)
  dispatch: 'http://dispatch.av380.net:8001', // relay-server allocation
  secret: 'http://secret.av380.net',      // HTTP key exchange (/v1/app/exch)
  bind: 'http://tmpalive.av380.net',      // device bind / online status
};
const CMD_FORWARD_ATTACH = 1100, CMD_FORWARD_ATTACH_RESP = 1101, CMD_DATA_FORWARD = 1200;
const METHOD_TSK_EXCHANGE = 196872; // 0x30108, plaintext (secureType 0)

const u32le = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const sha1hex = s => crypto.createHash('sha1').update(s).digest('hex');
const md5hex = s => crypto.createHash('md5').update(s, 'utf8').digest('hex');
// AES-128-ECB/PKCS5 (= PKCS7) with an ASCII key; hex (for password) or base64 (for device password).
const aesEcbHex = (plain, keyStr) => { const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(keyStr, 'utf8'), null); return Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()]).toString('hex'); };
const aesEcbB64 = (plain, keyStr) => { const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(keyStr, 'utf8'), null); return Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()]).toString('base64'); };
const randKey8 = () => { const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; let s = ''; for (let i = 0; i < 8; i++) s += a[crypto.randomInt(a.length)]; return s; };
// md5 "sign" field used by all mapi.av380.net calls: md5(alphabetical "k=v&k=v..." + "hsshop2016").
const mapiSign = fields => md5hex(Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('&') + 'hsshop2016');

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// ---- 1) account login -> access token (RECIPE PINNED from OkHttpUtil.accountLogin) -----------------
// password = lowerhex(AES-128-ECB/PKCS5(password, "1234567890123456")); token at data.access_token;
// success = result===0 && error_code===0. No headers/app_key; sign is the md5 body field.
export async function accountLogin(username, password) {
  const enc = aesEcbHex(password, '1234567890123456');
  const fields = { password: enc, phonetoken: '100', timestamp: Math.floor(Date.now() / 1000), username };
  const body = { ...fields, sign: mapiSign(fields) };
  const r = await postJson(`${HOSTS.api}/user/login`, body);
  const d = r.json || {};
  return { ok: d.result === 0 && d.error_code === 0 && !!d.data?.access_token, token: d.data?.access_token ?? null, userId: d.data?.user_id ?? null, result: d.result, error_code: d.error_code, status: r.status, raw: r.json };
}

// ---- 2) bind (claim) this NEW-platform camera to the account: POST device/update-info -------------
// devicepassword = base64(AES-128-ECB/PKCS5(adminPassword, randkey+"hongshi1")); deviceaccount "admin".
// success = (result===0 && error_code===0) || error_code===10004 (already bound).
export async function bindDevice(token, devId, adminPassword, { nickname = 'Camera', deviceaccount = 'admin', devicemodel = 0, groupid = 0 } = {}) {
  const randkey = randKey8();
  const devpw = aesEcbB64(adminPassword, randkey + 'hongshi1');
  const fields = { accesstoken: token, deviceaccount, deviceid: +devId, devicemodel, devicepassword: devpw, groupid, nickname, randkey, timestamp: String(Math.floor(Date.now() / 1000)), ver: 2 };
  const body = { ...fields, sign: mapiSign(fields) };
  const r = await postJson(`${HOSTS.api}/device/update-info`, body);
  const d = r.json || {};
  return { ok: (d.error_code === 0 && d.result === 0) || d.error_code === 10004, alreadyBound: d.error_code === 10004, result: d.result, error_code: d.error_code, status: r.status, raw: r.json };
}

// ---- 3) bound device list (POST device/list) -> each entry has p_key, online_stat, pver, etc. -----
export async function getDeviceList(token) {
  const fields = { accesstoken: token, get_sub_server: 1, language: 'en', registrationid: '', timestamp: Math.floor(Date.now() / 1000), type: 'all', ver: 1008 };
  const body = { ...fields, sign: mapiSign(fields) };
  const r = await postJson(`${HOSTS.api}/device/list`, body);
  const list = r.json?.data?.list ?? r.json?.data ?? r.json?.list ?? [];
  return { devices: Array.isArray(list) ? list : [], status: r.status, raw: r.json };
}

// normalize a device/list entry to the fields we use (actual JSON field names confirmed live).
export const normalizeDevice = d => ({
  devId: d.device_id ?? d.dev_id, pKey: d.public_key ?? d.p_key, pver: d.pver,
  ip: d.ip, nickname: d.nickname, model: d.model, permission: d.permission, mqsl: d.mqsl, type: d.type,
});

// ---- check whether/by-whom a device is bound: POST device/info ------------------------------------
export async function checkBindStatus(token, devId) {
  const fields = { accesstoken: token, deviceid: +devId, timestamp: Math.floor(Date.now() / 1000) };
  const body = { ...fields, sign: mapiSign(fields) };
  const r = await postJson(`${HOSTS.api}/device/info`, body);
  return { status: r.status, raw: r.json };
}

// ---- 3) dispatch: relay (transmit) server list ----------------------------------------------------
// Signature is SOLID: sha1("dev_id=<id>&platform=<p>&timestamp=<ts>hsdata2022").
export async function dispatchRelay(devId, platform = 20001) {
  const ts = Math.floor(Date.now() / 1000);
  const sign = sha1hex(`dev_id=${devId}&platform=${platform}&timestamp=${ts}hsdata2022`);
  const r = await postJson(`${HOSTS.dispatch}/api/v1/get_stream_server`, { dev_id: devId, platform, timestamp: ts, sign });
  const servers = r.json?.data ?? r.json?.list ?? [];
  return { servers, status: r.status, raw: r.json };
}

// ---- 4) create a relay session on a transmit server ----------------------------------------------
// GAP: exact request path/shape of callMqService is not pinned. Authorized by access_token+device_id;
// response: { code, mr:{ result:{ trs_ip, trs_port, app_trs_ip, app_trs_port, channel_handle, channel_token, uuid } } }.
export async function createRelaySession(host, port, token, devId, deviceIp = '', path = '/v1/app/call') {
  const r = await postJson(`http://${host}:${port}${path}`, { access_token: token, device_id: devId, deviceIp });
  const mr = r.json?.mr?.result ?? r.json?.data?.mr?.result ?? null;
  return { code: r.json?.code, session: mr, status: r.status, raw: r.json };
}

// ---- transport primitives (SOLID) ----------------------------------------------------------------
// forward-attach: 1500-byte buffer [int32 1100][int32 devId][int32 channel_handle][token ascii <=36].
export function forwardAttachBuffer(devId, channelHandle, channelToken) {
  const b = Buffer.alloc(1500);
  u32le(CMD_FORWARD_ATTACH).copy(b, 0); u32le(devId).copy(b, 4); u32le(channelHandle).copy(b, 8);
  Buffer.from(String(channelToken), 'ascii').copy(b, 12, 0, 36);
  return b;
}
// wrap an IoT frame for relay OUTBOUND: 64-byte header [int32 1200][int32 innerLen=frameLen][56 zero] + frame.
export const wrapMR = iotFrame => Buffer.concat([u32le(CMD_DATA_FORWARD), u32le(iotFrame.length), Buffer.alloc(56), iotFrame]);
// strip a leading 1200 forward header on INBOUND if present (relay delivery is asymmetric; be tolerant).
export function stripMR(buf) {
  if (buf.length >= 64 && buf.readUInt32LE(0) === CMD_DATA_FORWARD) return buf.subarray(64);
  return buf;
}

// plaintext IoT frame (secureType 0) — used by the tunnel TSK key-exchange.
function plainIotFrame(methodId, params, sidByte = 0) {
  const body = Buffer.from(JSON.stringify({ id: crypto.randomInt(10, 1e6), method_id: methodId, chn: 1, ts: Math.floor(Date.now() / 1000), params }), 'latin1');
  const h = Buffer.alloc(16); u32le(v.CMD_COMMON_IOT).copy(h, 0); h[4] = 1; h[5] = 0; h[6] = sidByte & 0xff; h[7] = 0; u32le(body.length).copy(h, 12);
  return Buffer.concat([h, body]);
}

// ---- 5) key exchange over the tunnel (method 196872) -> { sKey, sid } -----------------------------
// Sends {uuid, cS: base64(sha256(appPub))}; response data.pubKC -> sKey = X25519(appSeed, pubKC).
// Reuses our LAN X25519 + yields the same AES-128-CBC session key our whole lib already uses.
export async function tskExchangeOverTunnel(sock, uuid, { timeoutMs = 8000 } = {}) {
  const seed = v.appSeed();
  const { priv, pubRaw } = v.x25519FromScalar(seed);
  const cS = v.sha256(pubRaw).toString('base64');
  sock.write(wrapMR(plainIotFrame(METHOD_TSK_EXCHANGE, { uuid, cS })));
  const resp = await readFrame(sock, timeoutMs);               // 16-byte IoT header + (plaintext) body
  const json = JSON.parse(resp.body.toString('latin1'));
  const pubKC = json?.data?.pubKC ?? json?.params?.data?.pubKC;
  const sid = json?.data?.sid ?? json?.params?.data?.sid ?? 0;
  if (!pubKC) throw new Error('tsk exchange: no pubKC');
  const sKey = v.x25519Shared(priv, Buffer.from(pubKC, 'base64'));
  return { sKey, sid };
}

// read one IoT frame (16-byte LE header + body), tolerating a leading 1200 forward header.
function readFrame(sock, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => { cleanup(); reject(new Error('read timeout')); }, timeoutMs);
    const onData = d => {
      buf = stripMR(Buffer.concat([buf, d]));
      if (buf.length < 16) return;
      const size = buf.readUInt32LE(12);
      if (buf.length < 16 + size) return;
      cleanup(); resolve({ header: buf.subarray(0, 16), body: buf.subarray(16, 16 + size) });
    };
    const onErr = e => { cleanup(); reject(e); };
    function cleanup() { clearTimeout(t); sock.off('data', onData); sock.off('error', onErr); }
    sock.on('data', onData); sock.on('error', onErr);
  });
}

// ---- high-level: open a remote (relay) session, returning a {sKey, sid, socket}-like object that
// the existing LAN lib can drive once outbound frames are wrapped with wrapMR(). TODO: wire MQTT wake
// for pver>=5 devices (broker URL is fetched dynamically — the main remaining unknown).
export async function openRemoteSession({ token, devId, deviceIp = '' } = {}) {
  const { servers } = await dispatchRelay(devId);
  if (!servers?.length) throw new Error('no relay servers from dispatch');
  for (const s of servers) {
    const { session, code } = await createRelaySession(s.host ?? s.ip, s.callPort ?? s.port, token, devId, deviceIp);
    if (code === 1012) throw new Error('device offline (1012)');
    if (!session) continue;
    const host = session.app_trs_ip || session.trs_ip, port = session.app_trs_port || session.trs_port;
    const sock = net.connect({ host, port });
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    sock.write(forwardAttachBuffer(+devId, session.channel_handle, session.channel_token));
    const attach = await readFrame(sock, 8000);
    if (attach.header.readUInt32LE(0) !== CMD_FORWARD_ATTACH_RESP) { sock.destroy(); continue; }
    // TODO(pver>=5): MQTT wake (MqttHelper.mqExchangePublish) before the tunnel will carry the device.
    const { sKey, sid } = await tskExchangeOverTunnel(sock, session.uuid);
    return { sock, sKey, sid, mr: true, host, port };
  }
  throw new Error('could not establish a relay session');
}
