// Read-only cloud check: login + device list + bind status. NO binding, NO changes.
// Prints only safe status fields — never username/password/token/devId/p_key.
import { readFileSync } from 'node:fs';
import dgram from 'node:dgram';
import * as cloud from './v380cloud.mjs';

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
if (!creds.username || /YOUR_V380/.test(String(creds.username))) { console.log('ABORT: creds still placeholder.'); process.exit(1); }

const local = await discover();
console.log('local camera:', local?.devId ? 'found, bindState=' + local.bindState : 'NOT found on LAN');

let login;
try { login = await cloud.accountLogin(creds.username, creds.password); }
catch (e) { console.log('LOGIN network error:', e.message); process.exit(1); }
console.log('LOGIN: ok=' + login.ok, 'result=' + login.result, 'error_code=' + login.error_code, 'http=' + login.status);
if (!login.ok) { console.log('login failed:', summ(login.raw)); process.exit(1); }

try {
  const dl = await cloud.getDeviceList(login.token);
  console.log('DEVICE LIST: http=' + dl.status, 'count=' + dl.devices.length, 'raw=' + summ(dl.raw));
  let match = false;
  for (const d of dl.devices) {
    const idOnAcct = String(d.dev_id ?? d.deviceid ?? d.id ?? '');
    const isOurs = local?.devId && idOnAcct === String(local.devId);
    if (isOurs) match = true;
    console.log('  device: isOurCamera=' + isOurs + ' online_stat=' + (d.online_stat ?? d.online) + ' pver=' + d.pver + ' hasPkey=' + !!d.p_key);
  }
  console.log(match ? '>>> THIS camera IS bound to this account.' : '>>> id match inconclusive — inspecting record fields:');
  const d0 = dl.devices[0];
  if (d0) {
    console.log('  device[0] keys:', Object.keys(d0).join(','));
    if (local?.devId) console.log('  fields whose VALUE equals our local devId:', Object.entries(d0).filter(([k, v]) => String(v) === String(local.devId)).map(([k]) => k).join(',') || '(none)');
    for (const [k, v] of Object.entries(d0)) {
      const t = typeof v;
      if (t === 'number') console.log('    ' + k + ' = ' + (Math.abs(v) < 1000000 ? v : '<hidden ' + String(v).length + '-digit>'));
      else if (t === 'boolean') console.log('    ' + k + ' = ' + v);
      else if (t === 'string') console.log('    ' + k + ' : string(' + v.length + ')');
      else console.log('    ' + k + ' : ' + t);
    }
  }
} catch (e) { console.log('device list error:', e.message); }

if (local?.devId) {
  try { const st = await cloud.checkBindStatus(login.token, local.devId); console.log('checkBindStatus(device/info): http=' + st.status, 'raw=' + summ(st.raw)); } catch (e) { console.log('bind-status error:', e.message); }
}
process.exit(0);
