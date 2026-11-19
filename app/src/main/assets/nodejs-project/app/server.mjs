// Prototype backend: local HTTP API over the V380 protocol library + static UI host.
// Endpoints: /api/discover, /api/days, /api/segments, /api/clip (MP4, cached, range-enabled).
import http from 'node:http';
import os from 'node:os';
import { readFile, writeFile, mkdir, stat, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lib from './lib.mjs';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const CACHE = process.env.V380_CACHE ?? join(DIR, 'clipcache'); // Android: app cacheDir via env
const PORT = 8777;
const LAN_PASS = process.env.V380_LAN_PASS ?? 'origin';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.ico': 'image/x-icon' };
await mkdir(CACHE, { recursive: true });

// Candidate camera-setting catalog. The /api/settings endpoint probes these and returns only the ones
// THIS camera reports as supported (code 1000), with current values. Enum labels are best-effort; the
// shown current value reflects the device. dpids reverse-engineered from V380 Pro 2.2.92.
const CATALOG = [
  { sect: 'Image', key: 'flip', dpid: 0x80100, kind: 'enum', label: 'Image flip / mirror', options: { 0: 'Normal', 1: 'Flip vertical', 2: 'Mirror horizontal', 3: 'Rotate 180°' } },
  { sect: 'Image', key: 'night', dpid: 0x80105, kind: 'enum', label: 'Night vision', options: { 0: 'Auto', 1: 'Day / colour', 2: 'Night / IR', 3: 'Smart' } },
  { sect: 'Image', key: 'antiflicker', dpid: 0x80106, kind: 'enum', label: 'Anti-flicker', options: { 0: '50 Hz', 1: '60 Hz', 2: 'Outdoor' } },
  { sect: 'Image', key: 'sharp', dpid: 0x80101, kind: 'int', label: 'Sharpness', min: 0, max: 100 },
  { sect: 'Image', key: 'bright', dpid: 0x80102, kind: 'int', label: 'Brightness', min: 0, max: 100 },
  { sect: 'Image', key: 'contrast', dpid: 0x80103, kind: 'int', label: 'Contrast', min: 0, max: 100 },
  { sect: 'Image', key: 'sat', dpid: 0x80104, kind: 'int', label: 'Saturation', min: 0, max: 100 },
  { sect: 'Light', key: 'flood', dpid: 0x50100, kind: 'enum', label: 'Floodlight (white light)', options: { 0: 'Off', 1: 'On', 2: 'Auto' } },
  { sect: 'Light', key: 'floodsens', dpid: 0x50103, kind: 'int', label: 'Floodlight sensitivity', min: 1, max: 3 },
  { sect: 'Audio & mic', key: 'micvol', dpid: 0x70100, kind: 'int', label: 'Mic volume', min: 0, max: 100 },
  { sect: 'Audio & mic', key: 'spkvol', dpid: 0x70101, kind: 'int', label: 'Speaker volume', min: 0, max: 100 },
  { sect: 'Audio & mic', key: 'prompt', dpid: 0x70103, kind: 'bool', label: 'Voice prompt tones' },
  { sect: 'Audio & mic', key: 'promptlang', dpid: 0x70102, kind: 'int', label: 'Prompt language (id)', min: 0, max: 20 },
  { sect: 'Motion & alarm', key: 'detsens', dpid: 0xe0103, kind: 'objset', label: 'Detection sensitivity', min: 1, max: 3 },
  { sect: 'Motion & alarm', key: 'track', dpid: 0x60105, kind: 'bool', label: 'Auto-tracking (follow motion)' },
  { sect: 'Recording', key: 'recq', dpid: 0x20104, kind: 'enum', label: 'Record quality', options: { 0: 'Low', 1: 'SD', 2: 'HD' } },
  { sect: 'Recording', key: 'recmode', dpid: 0x20103, kind: 'enum', label: 'Record mode', options: { 0: 'Off', 1: 'Alarm only', 2: 'Manual', 3: 'Continuous' } },
  { sect: 'Recording', key: 'recaudio', dpid: 0x20105, kind: 'bool', label: 'Record audio' },
  { sect: 'Recording', key: 'recloop', dpid: 0x20106, kind: 'bool', label: 'Loop (overwrite when full)' },
  { sect: 'PTZ', key: 'panspeed', dpid: 0x60103, kind: 'int', label: 'Pan speed', min: 1, max: 8 },
  { sect: 'PTZ', key: 'tiltspeed', dpid: 0x60104, kind: 'int', label: 'Tilt speed', min: 1, max: 8 },
];
const byKey = Object.fromEntries(CATALOG.map(c => [c.key, c]));

const json = (res, obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

async function serveStatic(req, res, p) {
  try { const f = join(DIR, p === '/' ? 'index.html' : p.replace(/^\//, '')); const data = await readFile(f); res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' }); res.end(data); }
  catch { res.writeHead(404); res.end('not found'); }
}

async function serveFileRange(req, res, file) {
  const st = await stat(file); const total = st.size; const range = req.headers.range;
  if (!range) { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': total, 'Accept-Ranges': 'bytes' }); createReadStream(file).pipe(res); return; }
  const m = /bytes=(\d*)-(\d*)/.exec(range); let s = m[1] ? +m[1] : 0, e = m[2] ? +m[2] : total - 1; if (e >= total) e = total - 1;
  res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${s}-${e}/${total}`, 'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1 });
  createReadStream(file, { start: s, end: e }).pipe(res);
}

const sessionCache = new Map();   // ip -> {sess, at}
const sessionPending = new Map();  // ip -> Promise (dedupe concurrent logins; camera rejects parallel auths)
async function getSession(ip) {
  const c = sessionCache.get(ip); if (c && Date.now() - c.at < 60000) return c.sess;
  let p = sessionPending.get(ip);
  if (!p) {
    p = (async () => {
      const sess = await lib.openSession(ip, LAN_PASS);
      if (sess.result !== 1000 || !sess.sKey) throw new Error('auth failed code ' + sess.result);
      sessionCache.set(ip, { sess, at: Date.now() }); return sess;
    })().finally(() => sessionPending.delete(ip));
    sessionPending.set(ip, p);
  }
  return p;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'); const q = url.searchParams;
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    if (url.pathname === '/api/serverinfo') { return json(res, { port: PORT, urls: lanIps().map(ip => `http://${ip}:${PORT}`) }); }
    if (url.pathname === '/api/discover') { const cams = await lib.discover(); return json(res, { cameras: cams }); }
    const ip = q.get('ip'); if (!ip) return json(res, { error: 'ip required' }, 400);
    if (url.pathname === '/api/days') { const sess = await getSession(ip); const days = await lib.listDays(ip, sess); return json(res, { ip, origin: sess.origin, days }); }
    if (url.pathname === '/api/segments') { const sess = await getSession(ip); const segs = await lib.listSegments(ip, sess, q.get('day')); return json(res, { day: q.get('day'), segments: segs }); }
    if (url.pathname === '/api/live') {
      const quality = q.get('hd') === '1' ? 2 : 1;            // HD main stream (2) vs SD sub-stream (1)
      const sess = await getSession(ip);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
      let sps = null, pps = null, asc = null, rate = 8000, sentInit = false, vseq = 1, aseq = 1;
      let vdts = 0, adts = 0, lastV = 0;                       // per-track decode times, accumulate from 0
      const stop = lib.openLive(ip, sess, {
        quality,
        onVideo: (payload, isKey) => {
          if (isKey && (!sps || !pps)) { const S = lib.findNal(payload, 7), P = lib.findNal(payload, 8); if (S) sps = S; if (P) pps = P; }
          if (!sentInit) { if (!(sps && pps)) return; const d = lib.parseSPS(sps); try { res.write(lib.initSegment({ video: { sps, pps, width: d.width, height: d.height }, audio: { asc: asc ?? Buffer.from([0x15, 0x88]), rate, channels: 1 } })); sentInit = true; lastV = Date.now(); } catch { return; } }
          const now = Date.now(); let dur = Math.round((now - lastV) * 90); if (dur < 1500 || dur > 30000) dur = 6000; lastV = now;  // measured frame duration, clamped
          try { res.write(lib.videoFragment({ seq: vseq++, baseMediaDecodeTime: vdts, samples: [{ data: payload, duration: dur, isKey }] })); } catch {}
          vdts += dur;
        },
        onAudio: (aac, gotAsc) => { if (!asc) asc = gotAsc; if (!sentInit) return; try { res.write(lib.audioFragment({ seq: aseq++, baseMediaDecodeTime: adts, samples: [{ data: aac, duration: 1024 }] })); } catch {} adts += 1024; },
        onClose: () => { try { res.end(); } catch {} },
      });
      res.on('close', () => stop()); req.on('aborted', () => stop());
      return;
    }
    if (url.pathname === '/api/settings') {
      const sess = await getSession(ip);
      const ids = [...new Set(CATALOG.map(c => c.dpid))];
      const got = {};
      for (let i = 0; i < ids.length; i += 10) { const r = await lib.getProps(ip, sess, ids.slice(i, i + 10)); Object.assign(got, r.props); }
      const items = CATALOG.filter(c => got[c.dpid] && got[c.dpid].code === 1000).map(c => {
        const g = got[c.dpid]; let value = g.value, max = c.max;
        if (c.kind === 'objset' && value && typeof value === 'object') { max = value.max ?? c.max; value = value.set; }
        return { sect: c.sect, key: c.key, label: c.label, kind: c.kind, options: c.options || null, min: c.min, max, value };
      });
      return json(res, { items });
    }
    if (url.pathname === '/api/setprop') {
      const c = byKey[q.get('key')]; if (!c) return json(res, { error: 'unknown setting' }, 400);
      const sess = await getSession(ip); const raw = q.get('value');
      let value; if (c.kind === 'bool') value = raw === '1' || raw === 'true'; else if (c.kind === 'objset') value = { set: +raw }; else value = +raw;
      const r = await lib.setProps(ip, sess, [{ dpid: c.dpid, value }]);
      return json(res, { ok: r.result === 1000, result: r.result });
    }
    if (url.pathname === '/api/ptz') {
      const sess = await getSession(ip); const cmd = q.get('cmd');
      if (cmd === 'home') return json(res, await lib.ptzHome(ip, sess));
      if (cmd === 'recal') return json(res, await lib.ptzRecal(ip, sess));
      if (cmd === 'preset_goto') return json(res, await lib.ptzPreset(ip, sess, +q.get('id') || 1, 1));
      if (cmd === 'move') return json(res, await lib.ptzMove(ip, sess, q.get('dir'), +(q.get('step') || 4)));
      if (cmd === 'zoom') return json(res, await lib.ptzZoom(ip, sess, +(q.get('action') || 0), +(q.get('step') || 1)));
      return json(res, { error: 'unknown ptz cmd' }, 400);
    }
    if (url.pathname === '/api/clip') {
      const day = q.get('day'), idx = +q.get('idx'), max = +(q.get('max') || 0);
      const cacheFile = join(CACHE, `${ip}_${day}_${idx}_${max || 'full'}.mp4`);
      try { await stat(cacheFile); return serveFileRange(req, res, cacheFile); } catch {}
      const sess = await getSession(ip);
      const segs = await lib.listSegments(ip, sess, day); const seg = segs[idx];
      if (!seg) return json(res, { error: 'segment not found' }, 404);
      const { mp4 } = await lib.fetchSegmentMp4(ip, sess, seg, { maxFrames: max });
      await writeFile(cacheFile, mp4);
      return serveFileRange(req, res, cacheFile);
    }
    json(res, { error: 'unknown endpoint' }, 404);
  } catch (e) { json(res, { error: String(e.message || e) }, 500); }
});
// Bind all interfaces so any device on the same Wi-Fi/hotspot can open the page (server is the only camera client; browsers just consume HTTP).
const HOST = process.env.V380_HOST ?? '0.0.0.0';
const lanIps = () => Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
server.listen(PORT, HOST, () => {
  console.log(`v380 prototype listening on ${HOST}:${PORT}  (LAN pass: ${LAN_PASS === 'origin' ? 'factory' : 'custom'})`);
  console.log(`  this device:  http://localhost:${PORT}`);
  for (const ip of lanIps()) console.log(`  same network: http://${ip}:${PORT}   (open on any phone/PC on the same Wi-Fi or hotspot)`);
});
