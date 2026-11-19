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
import { mqttWake } from './mqtt5.mjs';

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

// ---- 5) MQTT wake auth (PART E1): get EMQX broker url + credentials ------------------------------
// POST https://gmdev.av380.net:8443/v1/app/login?signature=<sig>&timestamp=<ms> ;
// sig = md5(md5(bodyStr + "oplatformV1") + ms). body {UID,atoken,pver:3,client:{AV,SV,BR}}.
// response {code:5600, data:{url,cid,user,pass,expired}}.
export const MQTT_LOGIN_HOST = 'gmdev.av380.net:8443';
export async function mqttAuth(userId, token, { appVer = '7.4.5', sysVer = '13', brand = 'Android' } = {}) {
  const ms = Date.now();
  const bodyStr = JSON.stringify({ UID: +userId, atoken: token, pver: 3, client: { AV: appVer, SV: sysVer, BR: brand } });
  const sig = md5hex(md5hex(bodyStr + 'oplatformV1') + ms);
  const res = await fetch(`https://${MQTT_LOGIN_HOST}/v1/app/login?signature=${sig}&timestamp=${ms}`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: bodyStr });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  const d = json?.data || {};
  return { ok: json?.code === 5600 && !!d.url, code: json?.code, broker: d.url, cid: d.cid, user: d.user, pass: d.pass, expired: d.expired, status: res.status, raw: json };
}

// ---- 6) wake envelope (PART E2): RFC6238 TOTP + MessagePayloadTools.newMessageLoad --------------
// envelope = [0x02][0x00][int32LE totp][int16LE seq=0][ AES-128-CBC/PKCS7( json, key=iv=md5(rk+"D"+devId+"U"+uid+totp) ) ]
function totp6(keyBytes, timeSec, step = 30) {
  const T = Math.floor(timeSec / step);
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(T));
  const h = crypto.createHmac('sha1', keyBytes).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const bin = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return String(bin % 1000000).padStart(6, '0');
}
export function wakeEnvelope(rk, devId, uid, jsonStr) {
  const totpKey = crypto.createHash('sha1').update(Buffer.from(rk + '2025&N+E+W' + devId + '&' + uid, 'utf8')).digest(); // 20B
  const totp = parseInt(totp6(totpKey, Math.floor(Date.now() / 1000)), 10);
  const aesKey = crypto.createHash('md5').update(rk + 'D' + devId + 'U' + uid + totp, 'utf8').digest(); // 16B key=iv
  const c = crypto.createCipheriv('aes-128-cbc', aesKey, aesKey);
  const cipher = Buffer.concat([c.update(Buffer.from(jsonStr, 'utf8')), c.final()]);
  const hdr = Buffer.alloc(8); hdr[0] = 2; hdr[1] = 0; hdr.writeInt32LE(totp, 2); hdr.writeInt16LE(0, 6);
  return Buffer.concat([hdr, cipher]);
}
// Build the pver>=5 wake publish. Generates the app X25519 keypair used for BOTH the wake pubKC and
// the later TSK key-exchange (pass appPriv/appPubRaw into tskExchangeOverTunnel so sKey matches).
export function buildWake({ rk, devId, uid, mid, trsIp, trsPort, channelHandle, uuid }) {
  const { priv, pubRaw } = v.x25519FromScalar(v.appSeed());
  const jsonStr = JSON.stringify({ call: 1, mid, ctx: { turn: { host: trsIp, port: trsPort, hdl: channelHandle }, auth: { uuid, pubKC: pubRaw.toString('base64') } } });
  return { topic: `CID/CID${devId}/UID/UID${uid}/call`, responseTopic: `WakeUp/${mid}`, payload: wakeEnvelope(rk, devId, uid, jsonStr), appPriv: priv, appPubRaw: pubRaw };
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
// POST dispatch/api/v1/get_stream_server {dev_id:<int>, platform, timestamp:<sec>, sign} ;
// sign = sha1("dev_id=<id>&platform=<p>&timestamp=<ts>hsdata2022"). dev_id MUST be a JSON number.
export async function dispatchRelay(devId, platform = 20001) {
  const ts = Math.floor(Date.now() / 1000);
  const sign = sha1hex(`dev_id=${devId}&platform=${platform}&timestamp=${ts}hsdata2022`);
  const r = await postJson(`${HOSTS.dispatch}/api/v1/get_stream_server`, { dev_id: +devId, platform, timestamp: ts, sign });
  const servers = r.json?.data ?? r.json?.list ?? r.json?.servers ?? r.json?.mr?.result ?? [];
  return { code: r.json?.code, servers: Array.isArray(servers) ? servers : [servers].filter(Boolean), status: r.status, raw: r.json };
}

// ---- 4) create a relay session on a transmit server (PINNED, PART A) ------------------------------
// POST http://<host>[:<callPort>]/v1/app/create ; header Signature = md5(md5(bodyStr+ts)+"2021Mr").
// body {"mr":{"params":{"access_token","device_id":<int>}},"timestamp":<sec>}.
// response {code:1000, mr:{result:{trs_ip,trs_port,channel_handle,channel_token,uuid}}} (1012=offline).
export async function createRelaySession(host, port, token, devId) {
  const ts = Math.floor(Date.now() / 1000);
  const body = { mr: { params: { access_token: token, device_id: +devId } }, timestamp: ts };
  const bodyStr = JSON.stringify(body);
  const sig = md5hex(md5hex(bodyStr + ts) + '2021Mr');
  const url = `http://${host}${port > 0 ? ':' + port : ''}/v1/app/create`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', 'Signature': sig }, body: bodyStr });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { code: json?.code, session: json?.mr?.result ?? null, status: res.status, raw: json };
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

// ---- tunnel reader: one data handler + sequential reads (raw bytes OR one IoT frame) --------------
function makeReader(sock) {
  let buf = Buffer.alloc(0);
  sock.on('data', d => { if (process.env.RELAY_DEBUG) console.error('RX ' + d.length + 'B: ' + d.subarray(0, 120).toString('hex')); buf = Buffer.concat([buf, d]); });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  return {
    async readBytes(n, timeoutMs = 8000) {
      const end = Date.now() + timeoutMs;
      while (buf.length < n) { if (sock.destroyed) throw new Error('socket closed'); if (Date.now() > end) throw new Error('relay read timeout'); await sleep(40); }
      const out = buf.subarray(0, n); buf = buf.subarray(n); return out;
    },
    async readIotFrame(timeoutMs = 18000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const off = (buf.length >= 64 && buf.readUInt32LE(0) === CMD_DATA_FORWARD) ? 64 : 0;
        if (buf.length >= off + 16) { const size = buf.readUInt32LE(off + 12); if (buf.length >= off + 16 + size) { const h = buf.subarray(off, off + 16); const b = buf.subarray(off + 16, off + 16 + size); buf = buf.subarray(off + 16 + size); return { header: h, body: b }; } }
        if (sock.destroyed) throw new Error('socket closed'); if (Date.now() > end) throw new Error('relay iot read timeout'); await sleep(40);
      if (process.env.RELAY_DEBUG && buf.length >= 48 && !globalThis.__dumped) { globalThis.__dumped = 1; console.error('RAW INBOUND (' + buf.length + 'B):', buf.subarray(0, Math.min(buf.length, 160)).toString('hex')); }
      }
    },
  };
}

// ---- 6) key exchange over the tunnel (method 196872, plaintext) -> { sKey, sid } -----------------
// Uses the SAME app X25519 keypair as the wake (so the device derives the matching sKey).
export async function tskExchangeOverTunnel(reader, sock, uuid, { priv, pubRaw, timeoutMs = 28000 } = {}) {
  if (!priv || !pubRaw) { const kp = v.x25519FromScalar(v.appSeed()); priv = kp.priv; pubRaw = kp.pubRaw; }
  const cS = v.sha256(pubRaw).toString('base64');
  const frame = wrapMR(plainIotFrame(METHOD_TSK_EXCHANGE, { uuid, cS }));
  // The device dials the relay a variable moment after the MQTT wake, so (re)send the TSK request
  // periodically and skip the tunnel's control/ready frames (e.g. cmd 0x30990, body len 0) until the
  // real CMD_COMMON_IOT reply arrives.
  let resp = null, lastSend = 0; const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (Date.now() - lastSend > 2500) { try { sock.write(frame); } catch {} lastSend = Date.now(); }
    let fr;
    try { fr = await reader.readIotFrame(Math.min(2600, Math.max(300, deadline - Date.now()))); }
    catch (e) { if (sock.destroyed) throw e; continue; } // this-read timeout -> loop and resend
    const cmd = fr.header.readUInt32LE(0);
    if (cmd === v.CMD_COMMON_IOT) { resp = fr; break; }
    if (process.env.RELAY_DEBUG) console.error('skip tunnel ctrl frame cmd ' + cmd + ' bodyLen ' + fr.body.length);
  }
  if (!resp) throw new Error('tsk: no CMD_COMMON_IOT reply within ' + timeoutMs + 'ms');
  const sec = resp.header[5];
  const bodyStr = (sec === 0 ? resp.body : cipher.decrypt(resp.body, v.PRE_SESSION_KEY, sec)).toString('latin1');
  const json = JSON.parse(bodyStr);
  const pubKC = json?.data?.pubKC ?? json?.params?.data?.pubKC;
  const sid = json?.data?.sid ?? json?.params?.data?.sid ?? 0;
  if (!pubKC) throw new Error('tsk exchange: no pubKC (resp ' + bodyStr.slice(0, 120) + ')');
  return { sKey: v.x25519Shared(priv, Buffer.from(pubKC, 'base64')), sid };
}

// ---- high-level: open a remote (relay) session -> { sock, reader, sKey, sid } --------------------
// Full pver>=5 flow: dispatch -> create -> MQTT wake -> forward-attach -> TSK key-exchange. Once this
// returns, drive the existing IoT lib over sock, wrapping each outbound frame with wrapMR().
export async function openRemoteSession({ token, userId, devId, rk, pver = 5 } = {}) {
  const disp = await dispatchRelay(devId);
  if (!disp.servers?.length) throw new Error('dispatch: no servers (code ' + disp.code + ')');
  let session = null, lastCode;
  for (const s of disp.servers) {
    const r = await createRelaySession(s.ip ?? s.host, 0, token, devId); lastCode = r.code;
    if (r.code === 1012) throw new Error('device offline (1012)');
    if (r.session) { session = r.session; break; }
  }
  if (!session) throw new Error('create relay session failed (code ' + lastCode + ')');
  const { trs_ip, trs_port, channel_handle, channel_token, uuid } = session;

  // fire the MQTT wake (pver>=5) so the device dials the allocated relay
  const mid = crypto.randomInt(1, 1e9);
  const wake = buildWake({ rk, devId, uid: userId, mid, trsIp: trs_ip, trsPort: trs_port, channelHandle: channel_handle, uuid });
  let wakePromise = Promise.resolve({ skipped: true });
  if (pver >= 5) {
    const auth = await mqttAuth(userId, token);
    if (!auth.ok) throw new Error('mqtt auth failed (code ' + auth.code + ')');
    wakePromise = mqttWake({ brokerUrl: auth.broker, cid: auth.cid, user: auth.user, pass: auth.pass, wakeTopic: wake.topic, responseTopic: wake.responseTopic, payload: wake.payload, timeoutMs: 8000 }).catch(e => ({ error: e.message }));
  }

  // connect the relay + forward-attach (1500B -> 64B [1101][1000])
  const sock = net.connect({ host: trs_ip, port: trs_port });
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); setTimeout(() => rej(new Error('relay connect timeout')), 8000); });
  const reader = makeReader(sock);
  sock.write(forwardAttachBuffer(+devId, channel_handle, channel_token));
  const fr = await reader.readBytes(64, 8000);
  if (fr.readUInt32LE(0) !== CMD_FORWARD_ATTACH_RESP || fr.readUInt32LE(4) !== 1000) { sock.destroy(); throw new Error('forward-attach rejected (cmd ' + fr.readUInt32LE(0) + ' result ' + fr.readUInt32LE(4) + ')'); }

  // the wake reply is advisory (device may dial the relay regardless) — note it but don't fail on it;
  // the TSK key-exchange is the real proof the device connected through the tunnel.
  const wr = await wakePromise;
  if (process.env.RELAY_DEBUG) console.error('WAKE: ' + (wr?.error ? 'ERROR ' + wr.error : (wr?.skipped ? 'skipped' : 'ok steps=' + (wr?.log || []).join('>') + (wr?.data ? ' respLen=' + wr.data.length : ''))));
  const { sKey, sid } = await tskExchangeOverTunnel(reader, sock, uuid, { priv: wake.appPriv, pubRaw: wake.appPubRaw });
  return { sock, reader, sKey, sid, mr: true, host: trs_ip, port: trs_port, wake: wr };
}
