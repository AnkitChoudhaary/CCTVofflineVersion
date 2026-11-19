// Discovery probe modelled on V380 Pro 2.2.92 DeviceLanUDPScanner (static finding,
// REA evidence ev_dd711ab9... sender / ev_d140e4a5... receiver):
//   - sender socket bound to UDP 10008, sends "NVDEVSEARCH^100" to <subnet broadcast>:10008
//     and 255.255.255.255:10008 every ~100 ms
//   - replies are received on a separate socket bound to UDP 10009
//   - "NVDEVRESULT^100/^200" = old platform, "NVDEVRESULT^300" = new (IoT) platform,
//     whose port defaults to Protocol.IOT_PLATFORM_DEVICE_DEFAULT_PORT = 8089 when 0.
// No login or configuration is sent. Raw replies (may contain device ID) are written
// only to camera-discovery-v2.local.json (git-ignored); console shows sizes/prefixes.
// Usage: node discover-camera-v2.mjs [cameraIp] [broadcastIp]
import dgram from 'node:dgram';
import net from 'node:net';
import { writeFile } from 'node:fs/promises';

const camera = process.argv[2] ?? '172.20.10.2';
const bcast = process.argv[3] ?? '172.20.10.15';
const payload = Buffer.from('NVDEVSEARCH^100', 'ascii');
const responses = [];
const errors = [];

function record(sock) {
  return (msg, remote) => {
    const nul = msg.indexOf(0);
    const text = msg.subarray(0, nul < 0 ? msg.length : nul).toString('latin1');
    if (text === 'NVDEVSEARCH^100') return; // our own broadcast echo
    responses.push({ socket: sock, from: `${remote.address}:${remote.port}`, bytes: msg.length,
      prefix: text.split('^').slice(0, 2).join('^'), text, hex: msg.toString('hex') });
  };
}

const rx = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const tx = dgram.createSocket({ type: 'udp4', reuseAddr: true });
rx.on('message', record('rx10009'));
tx.on('message', record('tx10008'));
for (const [n, s] of [['rx', rx], ['tx', tx]]) s.on('error', e => errors.push(`${n}:${e.code ?? e.message}`));
await new Promise(r => rx.bind(10009, '0.0.0.0', r));
await new Promise(r => tx.bind(10008, '0.0.0.0', r));
tx.setBroadcast(true);

const targets = [bcast, '255.255.255.255', camera];
for (let i = 0; i < 20; i++) {
  for (const t of targets) tx.send(payload, 10008, t, e => e && errors.push(`send ${t}:${e.code}`));
  await new Promise(r => setTimeout(r, 200));
}
await new Promise(r => setTimeout(r, 1000));
rx.close(); tx.close();

// TCP connect-and-close only (no payload) to the new-platform default port.
const tcp = await new Promise(resolve => {
  const t0 = Date.now();
  const s = net.connect({ host: camera, port: 8089, timeout: 3000 });
  s.on('connect', () => { s.destroy(); resolve({ port: 8089, result: 'connected', ms: Date.now() - t0 }); });
  s.on('timeout', () => { s.destroy(); resolve({ port: 8089, result: 'timeout' }); });
  s.on('error', e => resolve({ port: 8089, result: e.code ?? e.message }));
});

const out = { observedAt: new Date().toISOString(), camera, broadcast: bcast,
  method: 'NVDEVSEARCH^100 x20 to broadcast/limited-broadcast/unicast UDP 10008 from bound 10008; listen UDP 10009 + 10008',
  responses, errors, tcp };
await writeFile(new URL('./camera-discovery-v2.local.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
const uniq = new Map();
for (const r of responses) uniq.set(`${r.socket} ${r.from} ${r.prefix} ${r.bytes}`, (uniq.get(`${r.socket} ${r.from} ${r.prefix} ${r.bytes}`) ?? 0) + 1);
console.log(JSON.stringify({ responseKinds: [...uniq].map(([k, n]) => `${k} x${n}`), errors, tcp }, null, 2));
