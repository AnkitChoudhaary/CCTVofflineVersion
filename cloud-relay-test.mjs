// Test the relay-allocation HTTP chain: login -> dispatch -> create-session. No MQTT, no tunnel yet.
// Prints only codes / booleans / vendor server addresses — never creds, token, devId, channel_token, uuid.
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
const local = await discover();
if (!local?.devId) { console.log('camera not found on LAN'); process.exit(1); }

const login = await cloud.accountLogin(creds.username, creds.password);
console.log('LOGIN ok=' + login.ok, 'result=' + login.result);
if (!login.ok) process.exit(1);

const disp = await cloud.dispatchRelay(local.devId);
console.log('DISPATCH http=' + disp.status, 'code=' + disp.code, 'serverCount=' + disp.servers.length, 'rawKeys=' + (disp.raw ? Object.keys(disp.raw).join(',') : 'null'));
for (const s of disp.servers.slice(0, 4)) console.log('  server:', Object.keys(s).join(','), '->', (s.host ?? s.ip) + ':' + (s.callPort ?? s.port));
if (!disp.servers.length) { console.log('  no servers; raw:', JSON.stringify(disp.raw).slice(0, 300)); process.exit(1); }

const s0 = disp.servers[0];
const host = s0.host ?? s0.ip, port = s0.callPort ?? s0.port ?? 0;
const sess = await cloud.createRelaySession(host, port, login.token, local.devId);
console.log('CREATE http=' + sess.status, 'code=' + sess.code, '(1000=ok,1012=offline)');
const r = sess.session || {};
console.log('  tunnel fields present:', JSON.stringify({ trs_ip: !!r.trs_ip, trs_port: !!r.trs_port, channel_handle: r.channel_handle != null, channel_token: !!r.channel_token, uuid: !!r.uuid }));
if (!sess.session) console.log('  no session; raw:', JSON.stringify(sess.raw).slice(0, 300));
process.exit(0);
