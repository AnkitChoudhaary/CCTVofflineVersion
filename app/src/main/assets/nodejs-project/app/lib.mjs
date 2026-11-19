// V380 local protocol library for the prototype app. Wraps the reverse-engineered pieces:
// discovery, LAN-pass login, SD recording list, and full-segment retrieval -> playable MP4.
// All local, no vendor cloud. (Imports the verified modules from the parent folder.)
import net from 'node:net';
import dgram from 'node:dgram';
import os from 'node:os';
import crypto from 'node:crypto';
import * as v from '../v380lan.mjs';
import * as cipher from '../cipher-sectype2.mjs';
import { mux } from '../mp4mux.mjs';
export { initSegment, videoFragment, audioFragment, codecString } from './fmp4.mjs';

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const MEDIA = 0x38030820, INFO = 0x38030822;
const pad = n => String(n).padStart(2, '0');

// subnet broadcast addresses of all active IPv4 interfaces, plus limited broadcast
function broadcastTargets() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) {
    if (i.family !== 'IPv4' || i.internal) continue;
    const ip = i.address.split('.').map(Number), mask = (i.netmask || '255.255.255.0').split('.').map(Number);
    const bc = ip.map((o, k) => (o & mask[k]) | (~mask[k] & 255));
    out.add(bc.join('.'));
  }
  return [...out];
}

// --- discovery: find a V380 new-platform camera on the local subnet ---
export async function discover({ timeoutMs = 2500 } = {}) {
  const targets = broadcastTargets();
  const rx = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const tx = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const found = new Map();
  rx.on('message', (msg, rem) => {
    const nul = msg.indexOf(0); const text = msg.subarray(0, nul < 0 ? msg.length : nul).toString('latin1');
    if (text.startsWith('NVDEVRESULT^300')) {
      const f = text.split('^'); // [NVDEVRESULT,300,MAC,IP,mask,gw,...,devid,...]
      found.set(rem.address, { ip: rem.address, mac: f[2], mask: f[4], gateway: f[5], raw: text.length });
    }
  });
  await new Promise(r => rx.bind(10009, '0.0.0.0', r));
  await new Promise(r => tx.bind(10008, '0.0.0.0', r));
  tx.setBroadcast(true);
  const payload = Buffer.from('NVDEVSEARCH^100', 'ascii');
  for (let i = 0; i < 10; i++) { for (const t of targets) tx.send(payload, 10008, t); await new Promise(r => setTimeout(r, 150)); }
  await new Promise(r => setTimeout(r, timeoutMs));
  rx.close(); tx.close();
  return [...found.values()];
}

export async function openSession(ip, lanPass = 'origin') {
  return v.keyExchange(ip, v.PORT, lanPass);
}

// BRIEF bitmask -> list of days that have recordings. entry "YYYYMM-<mask>", bit i => day i+1.
function daysFromBrief(entry) {
  const [ym, maskStr] = entry.split('-');
  const year = +ym.slice(0, 4), month = +ym.slice(4, 6), mask = +maskStr, out = [];
  for (let i = 0; i < 31; i++) if (mask & (1 << i)) out.push(`${year}-${pad(month)}-${pad(i + 1)}`);
  return out;
}
export async function listDays(ip, sess, yearsBack = 3) {
  const now = Date.now();
  const r = await v.recFileList(ip, v.PORT, sess, { mode: 1, filter: 15, start: now - yearsBack * 365 * 86400_000, end: now + 86400_000 });
  return (r.json?.data?.brief ?? []).flatMap(daysFromBrief);
}
const TYPE = { 1: 'continuous', 2: 'motion', 4: 'alarm', 8: 'event' };
export async function listSegments(ip, sess, day) {
  const [Y, M, D] = day.split('-').map(Number);
  const start = Date.UTC(Y, M - 1, D), end = Date.UTC(Y, M - 1, D, 23, 59, 59, 999);
  const { json } = await v.recFileList(ip, v.PORT, sess, { mode: 2, filter: 15, start, end });
  const list = (json?.data?.list ?? []).sort((a, b) => a.s - b.s);
  return list.map((x, i) => ({ idx: i, startUTC: new Date(start + x.s).toISOString(), startMs: start + x.s,
    durationS: Math.round(x.d / 1000), type: TYPE[x.t] ?? `t${x.t}`, s: x.s, t: x.t, dayStart: start }));
}

// --- media frame decryption (partial-encryption, the verified fix) ---
function decFrame(body, key, iv) {
  if (body.length < 32) { const n = body.length & ~15; const d = crypto.createDecipheriv('aes-128-cbc', key, iv); d.setAutoPadding(false); return Buffer.concat([d.update(body.subarray(0, n)), d.final(), body.subarray(n)]); }
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv); d.setAutoPadding(false);
  const hdr = d.update(body.subarray(0, 32));
  let enc = Math.min(hdr.readUInt32LE(22) >>> 0, body.length - 32) & ~15;
  const encDec = enc > 0 ? d.update(body.subarray(32, 32 + enc)) : Buffer.alloc(0);
  d.final();
  return Buffer.concat([hdr, encDec, body.subarray(32 + enc)]);
}
function req(sess, m, p) {
  const hj = { id: crypto.randomInt(10, 1e6), chn: 1, method_id: m, ts: Math.floor(Date.now() / 1000), params: p };
  const body = cipher.encrypt(Buffer.from(JSON.stringify(hj), 'latin1'), sess.sKey, 2);
  const h = Buffer.alloc(16); u32(v.CMD_COMMON_IOT).copy(h, 0); h[4] = 1; h[5] = 2; h[6] = sess.sid & 0xff; h[7] = 0; u32(body.length).copy(h, 12);
  return Buffer.concat([h, body]);
}
export const splitNals = b => { const st = []; for (let i = 0; i + 3 < b.length; i++){ if (b[i]===0&&b[i+1]===0){ if(b[i+2]===1){st.push([i,3]);i+=2;}else if(b[i+2]===0&&b[i+3]===1){st.push([i,4]);i+=3;} } } return st.map(([p,n],k)=>b.subarray(p+n,k+1<st.length?st[k+1][0]:b.length)); };
export const findNal = (f, t) => { for (const n of splitNals(f)) if ((n[0] & 0x1f) === t) return n; return null; };

// --- live view: open the live stream; onVideo(frameAnnexB, isKey), onAudio(aac), onInfo(info) ---
// Returns a stop() function. Reuses the LAN session key (no separate data-channel key exchange).
export function openLive(ip, sess, { quality = 2, onVideo, onAudio, onInfo, onClose } = {}) {
  const key = sess.sKey.subarray(0, 16), iv = sess.sKey.subarray(16, 32);
  const sock = net.connect({ host: ip, port: v.PORT });
  let buf = Buffer.alloc(0), asc = null;
  sock.on('connect', () => sock.write(req(sess, 197122, { up: { quality, video: 1, audio: 1, IDRreq: 1 } })));
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 16) {
      const cmd = buf.readUInt32LE(0), size = buf.readUInt32LE(12), sec = buf[5];
      if (buf.length < 16 + size) break;
      const b = buf.subarray(16, 16 + size); buf = buf.subarray(16 + size);
      if (cmd === INFO) { try { const j = JSON.parse((sec === 0 ? b : cipher.decrypt(b, sess.sKey, 2)).toString('latin1')); if (j.params?.info && onInfo) onInfo(j.params.info); } catch {} continue; }
      if (cmd !== MEDIA) continue;
      const f = decFrame(b, key, iv); const type = f[1], payload = f.subarray(b.length - f.readUInt16LE(6));
      if (type === 1 || type === 2) { onVideo && onVideo(payload, type === 1); }
      else if (type === 4 && payload[0] === 0xff && (payload[1] & 0xf0) === 0xf0 && onAudio) {
        if (!asc) { const aot = ((payload[2] >> 6) & 3) + 1, sf = (payload[2] >> 2) & 0xf, ch = ((payload[2] & 1) << 2) | ((payload[3] >> 6) & 3); const vv = (aot << 11) | (sf << 7) | (ch << 3); asc = Buffer.from([(vv >> 8) & 255, vv & 255]); }
        onAudio(payload.subarray((payload[1] & 1) ? 7 : 9), asc);
      }
    }
  });
  const ka = setInterval(() => { if (!sock.destroyed) sock.write(req(sess, 0x30200, { flag: 2, tms1: 0, decode_tms: 0 })); }, 2000);
  sock.on('close', () => { clearInterval(ka); onClose && onClose(); });
  sock.on('error', () => { clearInterval(ka); onClose && onClose(); });
  return () => { clearInterval(ka); try { sock.destroy(); } catch {} };
}

// parse SPS -> {width,height,profile,level} (exp-golomb, High profile aware)
export function parseSPS(nal) {
  const rb = []; for (let i = 1; i < nal.length; i++) { if (i > 2 && nal[i] === 3 && nal[i-1] === 0 && nal[i-2] === 0) continue; rb.push(nal[i]); }
  const d = Buffer.from(rb); let p = 0;
  const bit = () => { const x = (d[p >> 3] >> (7 - (p & 7))) & 1; p++; return x; };
  const u = n => { let x = 0; for (let i = 0; i < n; i++) x = (x << 1) | bit(); return x >>> 0; };
  const ue = () => { let z = 0; while (bit() === 0 && z < 32) z++; return z === 0 ? 0 : ((1 << z) - 1) + u(z); };
  const se = () => { const k = ue(); return (k & 1) ? (k + 1) >> 1 : -(k >> 1); };
  const profile = u(8); u(8); const level = u(8); ue();
  if ([100,110,122,244,44,83,86,118,128,138,139,134,135].includes(profile)) { const c = ue(); if (c === 3) u(1); ue(); ue(); u(1); if (u(1)) {} }
  ue(); const poc = ue(); if (poc === 0) ue(); else if (poc === 1) { u(1); se(); se(); const n = ue(); for (let i = 0; i < n; i++) se(); }
  ue(); u(1); const wMb = ue() + 1, hMap = ue() + 1; const fmo = u(1); if (!fmo) u(1); u(1);
  let cl = 0, cr = 0, ct = 0, cb = 0; if (u(1)) { cl = ue(); cr = ue(); ct = ue(); cb = ue(); }
  return { profile, level, width: wMb * 16 - (cl + cr) * 2, height: (2 - fmo) * hMap * 16 - (ct + cb) * 2 };
}

// Retrieve a full segment -> { mp4: Buffer, info }. onProgress(framesSoFar).
export async function fetchSegmentMp4(ip, sess, seg, { maxFrames = 0, maxSeconds = 180, onProgress } = {}) {
  const key = sess.sKey.subarray(0, 16), iv = sess.sKey.subarray(16, 32);
  const sock = net.connect({ host: ip, port: v.PORT });
  const vByseq = new Map(), aByseq = new Map();
  let buf = Buffer.alloc(0), info = null, sps = null, pps = null, asc = null;
  let maxV = -1, lastNewAt = Date.now(); const t0 = Date.now();
  await new Promise(resolve => {
    const fin = () => { clearInterval(pump); clearInterval(ka); clearInterval(watch); try { sock.destroy(); } catch {}; resolve(); };
    sock.on('connect', () => sock.write(req(sess, 197154, { sts: seg.startMs, pts: seg.startMs + 1, time_id: 0, frames: 400, speed: 10, mode: 2, video: 1, audio: 1, rtype: seg.t })));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 16) {
        const cmd = buf.readUInt32LE(0), size = buf.readUInt32LE(12);
        if (buf.length < 16 + size) break;
        const b = buf.subarray(16, 16 + size); buf = buf.subarray(16 + size);
        if (cmd === INFO) { try { info = JSON.parse(cipher.decrypt(b, sess.sKey, 2).toString('latin1'))?.params?.info; } catch {} continue; }
        if (cmd !== MEDIA) continue;
        const f = decFrame(b, key, iv); const type = f[1], seq = f.readUInt16LE(2), payload = f.subarray(b.length - f.readUInt16LE(6));
        if (type === 1 || type === 2) {
          if (!vByseq.has(seq)) { vByseq.set(seq, { payload, key: type === 1 }); if (!sps) sps = findNal(payload, 7); if (!pps) pps = findNal(payload, 8); if (seq > maxV) { maxV = seq; lastNewAt = Date.now(); if (onProgress) onProgress(vByseq.size); } }
        } else if (type === 4 && payload[0] === 0xff && (payload[1] & 0xf0) === 0xf0) {
          if (!aByseq.has(seq)) { aByseq.set(seq, payload.subarray((payload[1] & 1) ? 7 : 9)); if (!asc) { const aot = ((payload[2] >> 6) & 3) + 1, sf = (payload[2] >> 2) & 0xf, ch = ((payload[2] & 1) << 2) | ((payload[3] >> 6) & 3); const vv = (aot << 11) | (sf << 7) | (ch << 3); asc = Buffer.from([(vv >> 8) & 255, vv & 255]); } }
        }
      }
    });
    sock.on('error', fin); sock.on('close', fin);
    const pump = setInterval(() => { if (!sock.destroyed) sock.write(req(sess, 197154, { frames: 400 })); }, 500);
    const ka = setInterval(() => { if (!sock.destroyed) sock.write(req(sess, 0x30200, { flag: 2, tms1: 0, decode_tms: 0 })); }, 2000);
    const watch = setInterval(() => { if (maxFrames && vByseq.size >= maxFrames) fin(); else if (Date.now() - t0 > maxSeconds * 1000) fin(); else if (Date.now() - lastNewAt > 4000 && maxV >= 0) fin(); }, 300);
  });
  const vSeqs = [...vByseq.keys()].sort((a, b) => a - b), aSeqs = [...aByseq.keys()].sort((a, b) => a - b);
  const videoFrames = vSeqs.map(k => vByseq.get(k).payload);
  const keyframes = vSeqs.map((k, i) => vByseq.get(k).key ? i + 1 : 0).filter(Boolean);
  const audioFrames = aSeqs.map(k => aByseq.get(k));
  if (!sps || !pps) throw new Error('no video decoded');
  const W = info?.vattr?.width ?? 2304, H = info?.vattr?.height ?? 2592, RATE = info?.aattr?.samplerate ?? 8000;
  const mp4 = mux({ videoFrames, audioFrames, width: W, height: H, videoTimescale: 90000, videoFrameDur: 6000, audioRate: RATE, sps, pps, asc: asc ?? Buffer.from([0x15, 0x88]), keyframes });
  return { mp4, info: { width: W, height: H, lenses: 2, lensHeight: H / 2, videoFrames: videoFrames.length, audioFrames: audioFrames.length } };
}

// ================= device control (new-platform IoT): GET/SET properties + ACTION =================
// Method ids (reverse-engineered from V380 Pro 2.2.92). Same session-keyed 8089 path as listing/replay.
const M_GET = 197376, M_SET = 197378, M_ACTION = 197384, M_ABILITY = 197386;
// DPID = property id, DAID = action id : (group<<16)|0x100|idx  /  (group<<16)|0x200|idx
export const DP = {
  // image (group 8 VIDEO)
  FLIP: 0x80100, SHARPNESS: 0x80101, BRIGHTNESS: 0x80102, CONTRAST: 0x80103, SATURATION: 0x80104,
  NIGHTVISION: 0x80105, ANTIFLICKER: 0x80106, ENCODING: 0x80107,
  // OSD (9), LIGHT (5)
  OSD_CLOCK: 0x90100, LED: 0x50105, FLOOD_SW: 0x50100, FLOOD_LVL: 0x50102, FLOOD_SENS: 0x50103,
  // audio (7)
  MIC_VOL: 0x70100, SPK_VOL: 0x70101, PROMPT_LANG: 0x70102, PROMPT_SW: 0x70103, AUDIO_ENC: 0x70104,
  // alarm legacy (10)
  AL_MAIN: 0xa0100, AL_SOUND_SW: 0xa0101, AL_SOUND_TYPE: 0xa0102, AL_MT_SENS: 0xa0103, AL_MT_SW: 0xa0104,
  // detect v3 (14 = 0xe) — values are objects keyed by object/sensor id (HUMAN="1")
  DET_OBJ_SW: 0xe0100, DET_MOV_SENS: 0xe0103,
  // ptz settings (6)
  PT_SPEED_H: 0x60103, PT_SPEED_V: 0x60104, PT_TRACK: 0x60105,
};
export const DA = { PT_PRESET: 0x60201, PT_HOME: 0x60202, PT_RECAL: 0x60204, PT_STEP: 0x60200, ZOOM: 0x60203, SIREN: 0xa0100, SIREN_V2: 0xe0200 };

const resultCode = j => j?.result?.code ?? j?.params?.result?.code ?? null;
async function control(ip, sess, methodId, params) {
  const { json } = await v.request(ip, v.PORT,
    { methodId, secureType: 2, sidByte: sess.sid & 0xff, magic: 0, params, key: sess.sKey }, sess.sKey);
  return json;
}
// Read properties. dpids: array of ints. Returns { result, props: {dpid: {value, vs, code}} }.
export async function getProps(ip, sess, dpids) {
  const j = await control(ip, sess, M_GET, { dplist: dpids });
  const arr = j?.data?.dplist_result ?? j?.params?.data?.dplist_result ?? [];
  const props = {}; for (const r of arr) props[r.dpid] = { value: r.value, vs: r.vs, code: r.code };
  return { result: resultCode(j), props, raw: j };
}
// Write properties. values: [{dpid, value, vs?}]. Returns { result }.
export async function setProps(ip, sess, values) {
  const dplist = values.map(x => { const o = { dpid: x.dpid, value: x.value }; if (x.vs != null && x.vs >= 0) o.vs = x.vs; return o; });
  const j = await control(ip, sess, M_SET, { dplist });
  return { result: resultCode(j), raw: j };
}
// Invoke an action. Returns { result, out }.
export async function invokeAction(ip, sess, daid, inObj = null, vsbmp = 0, noRsp = false) {
  const params = { daid };
  if (vsbmp) params.vsbmp = vsbmp;
  if (noRsp) params.no_rsp = true;
  if (inObj != null) params.in = inObj;
  const j = await control(ip, sess, M_ACTION, params);
  return { result: resultCode(j), out: j?.data?.out ?? j?.params?.data?.out ?? null, raw: j };
}
export async function getAbility(ip, sess, params = {}) { return control(ip, sess, M_ABILITY, params); }

// PTZ helpers (preset/home/recal are confirmed over this JSON channel; live directional move is native — pending).
export const ptzPreset = (ip, sess, presetId, ctrlFlag = 1, channel = 0) =>
  invokeAction(ip, sess, DA.PT_PRESET, { ctrl_flag: ctrlFlag, pos_mark_id_cnt: 1, pos_mark_id: [presetId] }, 1 << channel);
export const ptzHome = (ip, sess, channel = 0) => invokeAction(ip, sess, DA.PT_HOME, null, 1 << channel);
export const ptzRecal = (ip, sess) => invokeAction(ip, sess, DA.PT_RECAL);
// Live directional pan/tilt move (native app emits this same ACTION: daid 0x60200, in:{op,cnt}).
// cnt = step (min 1). no_rsp omitted so we get an ACK.
// Camera op meanings (confirmed on-device, 2026-11-19): 1=down, 2=up, 3=left, 4=right.
// (The native RE's op labels were rotated 90°; this maps the UI direction to the op that actually moves that way.)
export const PTZ_OP = { stop: 0, up: 2, down: 1, left: 3, right: 4 };
export const ptzMove = (ip, sess, dir, step = 4, channel = 0) =>
  invokeAction(ip, sess, DA.PT_STEP, { op: PTZ_OP[dir] ?? 0, cnt: Math.max(+step || 1, 1) }, 1 << channel);
export const ptzZoom = (ip, sess, action, step = 1, channel = 0) =>
  invokeAction(ip, sess, DA.ZOOM, { ctrl: +action || 0, val: +step || 1 }, 1 << channel);
// Person (humanoid) detection toggle on modern firmware: DET_OBJ_SW value {"1": bool}
export const setPersonDetect = (ip, sess, on) => setProps(ip, sess, [{ dpid: DP.DET_OBJ_SW, value: { '1': !!on } }]);
