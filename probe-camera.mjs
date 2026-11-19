import net from 'node:net';
import os from 'node:os';
import { writeFile } from 'node:fs/promises';

// Only connect to the camera identified by the owner. No login attempts,
// media requests, network-wide discovery, or camera configuration changes.
const host = '172.20.10.2';
const ports = [8800, 554, 80, 443, 8899, 5050];
const results = await Promise.all(ports.map(port => new Promise(resolve => {
  const started = Date.now();
  const socket = new net.Socket();
  let finished = false;
  function finish(state, error) {
    if (finished) return;
    finished = true;
    socket.destroy();
    resolve({ port, state, elapsedMs: Date.now() - started, ...(error ? { error } : {}) });
  }
  socket.setTimeout(3000);
  socket.once('connect', () => finish('open'));
  socket.once('timeout', () => finish('timeout'));
  socket.once('error', error => finish('error', error.code));
  socket.connect(port, host);
})));
const report = {
  observedAt: new Date().toISOString(),
  cameraIp: host,
  userReportedSoftware: 'HsAwSMCD_V2.0.2.3(s:c59f9943)',
  localAddresses: Object.values(os.networkInterfaces()).flat()
    .filter(address => address && !address.internal && address.family === 'IPv4')
    .map(address => ({ address: address.address, netmask: address.netmask })),
  method: 'TCP connect and close only; no application payload sent',
  results,
};
await writeFile(new URL('./camera-port-observations.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
