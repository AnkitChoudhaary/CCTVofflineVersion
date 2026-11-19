// One-shot cloud login + bind runner. Reads creds from the git-ignored cloud-creds.local.json.
// Prints ONLY status/result codes — never the username, password, token, device id, or p_key.
import { readFileSync } from 'node:fs';
import dgram from 'node:dgram';
import * as cloud from './v380cloud.mjs';

// redact raw server JSON to just the safe status fields for logging
const summ = raw => raw == null ? 'null' : JSON.stringify({ result: raw.result, error_code: raw.error_code, message: raw.message ?? raw.msg ?? raw.error ?? raw.data?.message });

function discover(ip = '172.20.10.2', ms = 3000) {
  return new Promise(res => {
    const rx = dgram.createSocket({ type: 'udp4', reuseAddr: true }), tx = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false, iv = null, to = null;
    const fin = v => { if (done) return; done = true; if (iv) clearInterval(iv); if (to) clearTimeout(to); try { rx.close(); } catch {} try { tx.close(); } catch {} res(v); };
    rx.on('message', msg => { const nul = msg.indexOf(0); const t = msg.subarray(0, nul < 0 ? msg.length : nul).toString('latin1'); if (t.startsWith('NVDEVRESULT^300')) { const f = t.split('^'); fin({ devId: f[12], bindState: f[15] }); } });
    rx.bind(10009, '0.0.0.0', () => tx.bind(10008, '0.0.0.0', () => { tx.setBroadcast(true); const p = Buffer.from('NVDEVSEARCH^100', 'ascii'); iv = setInterval(() => { try { tx.send(p, 10008, ip); } catch {} }, 200); to = setTimeout(() => fin(null), ms); }));
  });
}

const creds = JSON.parse(readFileSync(new URL('./cloud-creds.local.json', import.meta.url), 'utf8').replace(/^﻿/, ''));
if (!creds.username || /YOUR_V380/.test(String(creds.username)) || !creds.password || /YOUR_V380/.test(String(creds.password))) { console.log('ABORT: cloud-creds.local.json still has placeholder values.'); process.exit(1); }

// 0) local camera + current bind state
const before = await discover();
if (!before?.devId) { console.log('ABORT: could not find the camera on the LAN (is the laptop on the hotspot?).'); process.exit(1); }
console.log('camera found locally. bindState BEFORE =', before.bindState, '(2 = unbound)');

// 1) account login (ONE attempt)
let login;
try { login = await cloud.accountLogin(creds.username, creds.password); }
catch (e) { console.log('LOGIN network error:', e.message, '\n(the laptop needs internet via the hotspot to reach mapi.av380.net)'); process.exit(1); }
console.log('LOGIN: ok=' + login.ok, 'result=' + login.result, 'error_code=' + login.error_code, 'http=' + login.status, 'raw=' + summ(login.raw));
if (!login.ok) { console.log('Login did not succeed — stopping before any bind. (No retry, to avoid lockout.)'); process.exit(1); }
console.log('  -> got access token (hidden); userId present:', login.userId != null);

// 2) bind this camera to the account (adminPassword defaults to the LAN factory pass)
const adminPw = process.env.V380_LAN_PASS ?? 'origin';
let bind;
try { bind = await cloud.bindDevice(login.token, before.devId, adminPw, { nickname: 'DrVision' }); }
catch (e) { console.log('BIND network error:', e.message); process.exit(1); }
console.log('BIND: ok=' + bind.ok, 'result=' + bind.result, 'error_code=' + bind.error_code, 'alreadyBound=' + bind.alreadyBound, 'http=' + bind.status, 'raw=' + summ(bind.raw));

// 3) re-check local bind state (may lag until the camera syncs with cloud, which needs camera internet)
await new Promise(r => setTimeout(r, 2000));
const after = await discover();
console.log('bindState AFTER =', after?.bindState, '(flips to non-2 once the camera syncs with cloud; needs camera internet)');

// 4) device list — confirm the camera now appears for the account
try {
  const dl = await cloud.getDeviceList(login.token);
  console.log('DEVICE LIST: http=' + dl.status, 'count=' + dl.devices.length);
  for (const d of dl.devices) console.log('  device: online_stat=' + (d.online_stat ?? d.online) + ' pver=' + d.pver + ' hasPkey=' + !!d.p_key);
} catch (e) { console.log('device list error:', e.message); }
process.exit(0);
