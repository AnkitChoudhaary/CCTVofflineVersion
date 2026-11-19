import dgram from 'node:dgram';
import { writeFile } from 'node:fs/promises';

const host = '172.20.10.2';
const socket = dgram.createSocket('udp4');
const responses = [];
const errors = [];
socket.on('message', (message, remote) => {
  if (remote.address !== host) return;
  responses.push({ remotePort: remote.port, bytes: message.length,
    // Discovery can contain the device ID. Retain locally; don't print it.
    hex: message.toString('hex'), text: message.toString('utf8') });
});
socket.on('error', error => errors.push(error.code ?? error.message));
await new Promise(resolve => socket.bind(0, '0.0.0.0', resolve));
socket.send(Buffer.from('NVDEVSEARCH^100', 'ascii'), 10008, host,
  error => { if (error) errors.push(error.code ?? error.message); });
await new Promise(resolve => setTimeout(resolve, 3500));
socket.close();
await writeFile(new URL('./camera-discovery.local.json', import.meta.url), JSON.stringify({
  observedAt: new Date().toISOString(), host,
  method: 'One unicast NVDEVSEARCH^100 discovery packet to UDP 10008',
  responses, errors,
}, null, 2) + '\n');
console.log(JSON.stringify({ host, responseCount: responses.length,
  responses: responses.map(({remotePort, bytes}) => ({remotePort, bytes})), errors }, null, 2));
