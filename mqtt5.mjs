// Minimal MQTT v5 client (TLS/TCP) — just enough for the V380 device "wake": CONNECT, SUBSCRIBE,
// PUBLISH(qos1, responseTopic), and receive the response PUBLISH. No external dependency.
import tls from 'node:tls';
import net from 'node:net';

const vbi = n => { const out = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 0x80; out.push(d); } while (n > 0); return Buffer.from(out); };
function readVbi(buf, off) { let mult = 1, val = 0, len = 0, b; do { b = buf[off + len]; val += (b & 0x7f) * mult; mult *= 128; len++; } while ((b & 0x80) && len < 4); return { value: val, len }; }
const u16 = n => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const str = s => { const b = Buffer.from(String(s), 'utf8'); return Buffer.concat([u16(b.length), b]); };
const bin = b => Buffer.concat([u16(b.length), b]);
const packet = (type, flags, body) => Buffer.concat([Buffer.from([(type << 4) | flags]), vbi(body.length), body]);

const connectPkt = (cid, user, pass) => packet(1, 0, Buffer.concat([
  str('MQTT'), Buffer.from([0x05, 0xC2]), u16(30), vbi(0),                 // name, level5, flags(user+pass+cleanstart), keepalive30, props(0)
  str(cid), str(user), bin(Buffer.from(String(pass), 'utf8')),            // payload: clientId, username, password
]));
const subscribePkt = (pid, topic) => packet(8, 0x02, Buffer.concat([u16(pid), vbi(0), str(topic), Buffer.from([0x01])])); // qos1
const publishPkt = (pid, topic, responseTopic, payload) => {
  const props = Buffer.concat([Buffer.from([0x08]), str(responseTopic)]);  // 0x08 = Response Topic
  return packet(3, 0x02, Buffer.concat([str(topic), u16(pid), vbi(props.length), props, payload])); // flags 0x02 = qos1
};
const pubackPkt = pid => packet(4, 0, u16(pid));

// Connect, subscribe to responseTopic, publish the wake, resolve when the device replies on responseTopic.
export function mqttWake({ brokerUrl, cid, user, pass, wakeTopic, responseTopic, payload, timeoutMs = 12000 }) {
  return new Promise((resolve, reject) => {
    const mm = /^([a-z]+):\/\/([^:/]+):(\d+)/.exec(brokerUrl);
    if (!mm) return reject(new Error('bad broker url'));
    const scheme = mm[1], host = mm[2], port = +mm[3], useTls = scheme === 'mqtts' || scheme === 'ssl';
    const sock = useTls ? tls.connect({ host, port, servername: host, rejectUnauthorized: false }) : net.connect({ host, port });
    let buf = Buffer.alloc(0), pid = 1, done = false, log = [];
    const t = setTimeout(() => finish(new Error('wake timeout (no device response on ' + responseTopic + '); steps: ' + log.join('>'))), timeoutMs);
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(t); try { sock.destroy(); } catch {} err ? reject(err) : resolve(val); };
    sock.on('error', e => finish(e));
    sock.on('close', () => finish(new Error('broker closed; steps: ' + log.join('>'))));
    const onReady = () => { log.push('tcp'); sock.write(connectPkt(cid, user, pass)); };
    useTls ? sock.on('secureConnect', onReady) : sock.on('connect', onReady);
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        const type = buf[0] >> 4, flags = buf[0] & 0x0f;
        const { value: rem, len: rlen } = readVbi(buf, 1);
        if (buf.length < 1 + rlen + rem) break;
        const body = buf.subarray(1 + rlen, 1 + rlen + rem); buf = buf.subarray(1 + rlen + rem);
        if (type === 2) { // CONNACK
          const rc = body[1]; log.push('connack' + rc);
          if (rc !== 0) return finish(new Error('CONNACK reason ' + rc));
          sock.write(subscribePkt(pid++, responseTopic));
        } else if (type === 9) { // SUBACK -> publish the wake
          log.push('suback'); sock.write(publishPkt(pid++, wakeTopic, responseTopic, payload));
        } else if (type === 4) { log.push('puback'); // wake delivered (qos1 ack)
        } else if (type === 3) { // incoming PUBLISH
          let p = 0; const tl = body.readUInt16BE(0); const topic = body.subarray(2, 2 + tl).toString('utf8'); p = 2 + tl;
          if (flags & 0x06) { const mpid = body.readUInt16BE(p); p += 2; sock.write(pubackPkt(mpid)); }
          const pl = readVbi(body, p); p += pl.len + pl.value; // skip properties
          const data = body.subarray(p);
          log.push('msg:' + topic);
          if (topic === responseTopic) finish(null, { topic, data, log });
        }
      }
    });
  });
}
