// Test the (pinned) dispatch step: get transmit/relay servers for our device. Read-only, no login.
// Prints only server addresses (vendor infra) + counts — never the device id.
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

const local = await discover();
if (!local?.devId) { console.log('camera not found on LAN'); process.exit(1); }
try {
  const d = await cloud.dispatchRelay(local.devId);
  console.log('DISPATCH: http=' + d.status + ' serverCount=' + (d.servers?.length ?? 0));
  console.log('raw top-level keys:', d.raw ? Object.keys(d.raw).join(',') : 'null');
  const arr = Array.isArray(d.servers) ? d.servers : [];
  for (const s of arr.slice(0, 6)) console.log('  server keys:', Object.keys(s).join(','), '| host=' + (s.host ?? s.ip) + ' port=' + (s.callPort ?? s.port));
  if (!arr.length && d.raw) console.log('raw (first 400 chars):', JSON.stringify(d.raw).slice(0, 400));
} catch (e) { console.log('dispatch error:', e.message); }
process.exit(0);
