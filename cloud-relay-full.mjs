// Full relay attempt: login -> device list -> openRemoteSession (dispatch, create, MQTT wake,
// forward-attach, TSK key-exchange). Prints only step status — never creds/token/rk/sKey/devId.
import { readFileSync } from 'node:fs';
import dgram from 'node:dgram';
import * as cloud from './v380cloud.mjs';

function discover(ip = '172.20.10.2', ms = 3000) {
  return new Promise(res => {
    const rx = dgram.createSocket({ type: 'udp4', reuseAddr: true }), tx = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false, iv = null, to = null;
    const fin = v => { if (done) return; done = true; if (iv) clearInterval(iv); if (to) clearTimeout(to); try { rx.close(); } catch {} try { tx.close(); } catch {} res(v); };
    rx.on('message', msg => { const nul = msg.indexOf(0); const t = msg.subarray(0, nul < 0 ? msg.length : nul).toString('latin1'); if (t.startsWith('NVDEVRESULT^300')) { const f = t.split('^'); fin({ devId: f[12] }); } });
    rx.bind(10009, '0.0.0.0', () => tx.bind(10008, '0.0.0.0', () => { tx.setBroadcast(true); const p = Buffer.from('NVDEVSEARCH^100', 'ascii'); iv = setInterval(() => { try { tx.send(p, 10008, ip); } catch {} }, 200); to = setTimeout(() => fin(null), ms); }));
  });
}

const creds = JSON.parse(readFileSync(new URL('./cloud-creds.local.json', import.meta.url), 'utf8').replace(/^﻿/, ''));
const local = await discover().catch(() => null); // optional — the relay devId comes from the cloud list

const login = await cloud.accountLogin(creds.username, creds.password);
console.log('LOGIN ok=' + login.ok);
if (!login.ok) { console.log('  (no internet via hotspot? result=' + login.result + ')'); process.exit(1); }

const dl = await cloud.getDeviceList(login.token);
const dev = (local?.devId && dl.devices.find(d => String(d.device_id ?? d.dev_id) === String(local.devId))) || dl.devices[0];
if (!dev) { console.log('device not in account list'); process.exit(1); }
const n = cloud.normalizeDevice(dev);
const devId = dev.device_id ?? dev.dev_id;
console.log('DEVICE pver=' + n.pver + ' hasRk=' + !!dev.rk + ' onLAN=' + !!local?.devId);

console.log('Opening relay session (dispatch -> create -> MQTT wake -> forward-attach -> TSK)...');
try {
  const t0 = Date.now();
  const sess = await cloud.openRemoteSession({ token: login.token, userId: login.userId, devId, rk: dev.rk, pver: n.pver });
  console.log('>>> RELAY SESSION ESTABLISHED in ' + (Date.now() - t0) + 'ms: sKey=' + (sess.sKey ? sess.sKey.length + ' bytes' : 'none') + ' sid=' + (sess.sid != null));
  console.log('    This means the full remote tunnel works: dispatch+create+wake+attach+keyexchange all succeeded.');
  try { sess.sock.destroy(); } catch {}
} catch (e) {
  console.log('xxx relay failed at: ' + e.message);
}
process.exit(0);
