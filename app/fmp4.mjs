// Fragmented-MP4 (fMP4) muxer for low-latency live via MSE. Video (avc1) + optional AAC audio (mp4a),
// in one MediaSource SourceBuffer. Video track=1 (timescale 90000), audio track=2 (timescale = sample rate).
const u8 = n => Buffer.from([n & 255]);
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff, 0); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(Math.max(0, Math.round(n)))); return b; };
const s = t => Buffer.from(t, 'latin1');
const box = (type, ...p) => { const b = Buffer.concat(p); return Buffer.concat([u32(b.length + 8), s(type), b]); };
const fbox = (type, ver, flags, ...p) => box(type, Buffer.from([ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...p);
const UNITY = Buffer.from([0,1,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,1,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0x40,0,0,0]);
export const VTRACK = 1, ATRACK = 2, VTS = 90000;

function splitNals(b) { const st = []; for (let i = 0; i + 3 < b.length; i++) if (b[i] === 0 && b[i + 1] === 0) { if (b[i + 2] === 1) { st.push([i, 3]); i += 2; } else if (b[i + 2] === 0 && b[i + 3] === 1) { st.push([i, 4]); i += 3; } } return st.map(([p, n], k) => b.subarray(p + n, k + 1 < st.length ? st[k + 1][0] : b.length)); }
function avccSample(frame) { const parts = []; for (const nal of splitNals(frame)) { const t = nal[0] & 0x1f; if (t === 7 || t === 8 || t === 9) continue; parts.push(u32(nal.length), nal); } return Buffer.concat(parts); }
const avcC = (sps, pps) => box('avcC', u8(1), u8(sps[1]), u8(sps[2]), u8(sps[3]), u8(0xff), u8(0xe1), u16(sps.length), sps, u8(1), u16(pps.length), pps);

function vtrak(v) {
  const stsd = fbox('stsd', 0, 0, u32(1), box('avc1', Buffer.alloc(6), u16(1), Buffer.alloc(16), u16(v.width), u16(v.height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), Buffer.alloc(32), u16(0x18), u16(0xffff), avcC(v.sps, v.pps)));
  const stbl = box('stbl', stsd, fbox('stts', 0, 0, u32(0)), fbox('stsc', 0, 0, u32(0)), fbox('stsz', 0, 0, u32(0), u32(0)), fbox('stco', 0, 0, u32(0)));
  const minf = box('minf', fbox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)), box('dinf', fbox('dref', 0, 0, u32(1), fbox('url ', 0, 1))), stbl);
  const mdia = box('mdia', fbox('mdhd', 0, 0, u32(0), u32(0), u32(VTS), u32(0), u16(0x55c4), u16(0)), fbox('hdlr', 0, 0, u32(0), s('vide'), Buffer.alloc(12), s('VideoHandler\0')), minf);
  const tkhd = fbox('tkhd', 0, 7, u32(0), u32(0), u32(VTRACK), u32(0), u32(0), Buffer.alloc(8), u16(0), u16(0), u16(0), u16(0), UNITY, u32(v.width << 16), u32(v.height << 16));
  return box('trak', tkhd, mdia);
}
function atrak(a) {
  // ES_Descriptor(3) len = 23+asc ; DecoderConfig(4) len = 15+asc ; DecoderSpecificInfo(5) len = asc
  const esds = fbox('esds', 0, 0, u8(3), u8(23 + a.asc.length), u16(2), u8(0), u8(4), u8(15 + a.asc.length), u8(0x40), u8(0x15), Buffer.alloc(3), u32(0), u32(0), u8(5), u8(a.asc.length), a.asc, u8(6), u8(1), u8(2));
  const stsd = fbox('stsd', 0, 0, u32(1), box('mp4a', Buffer.alloc(6), u16(1), Buffer.alloc(8), u16(a.channels || 1), u16(16), u32(0), u16(a.rate), u16(0), esds));
  const stbl = box('stbl', stsd, fbox('stts', 0, 0, u32(0)), fbox('stsc', 0, 0, u32(0)), fbox('stsz', 0, 0, u32(0), u32(0)), fbox('stco', 0, 0, u32(0)));
  const minf = box('minf', fbox('smhd', 0, 0, u16(0), u16(0)), box('dinf', fbox('dref', 0, 0, u32(1), fbox('url ', 0, 1))), stbl);
  const mdia = box('mdia', fbox('mdhd', 0, 0, u32(0), u32(0), u32(a.rate), u32(0), u16(0x55c4), u16(0)), fbox('hdlr', 0, 0, u32(0), s('soun'), Buffer.alloc(12), s('SoundHandler\0')), minf);
  const tkhd = fbox('tkhd', 0, 7, u32(0), u32(0), u32(ATRACK), u32(0), u32(0), Buffer.alloc(8), u16(0), u16(0), u16(0x0100), u16(0), UNITY, u32(0), u32(0));
  return box('trak', tkhd, mdia);
}
export function initSegment({ video, audio }) {
  const ftyp = box('ftyp', s('isom'), u32(1), s('isomiso5avc1dash'));
  const traks = [vtrak(video)];
  const trexBoxes = [fbox('trex', 0, 0, u32(VTRACK), u32(1), u32(0), u32(0), u32(0))];
  if (audio) { traks.push(atrak(audio)); trexBoxes.push(fbox('trex', 0, 0, u32(ATRACK), u32(1), u32(0), u32(0), u32(0))); }
  const mvhd = fbox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(0), u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), UNITY, Buffer.alloc(24), u32(0xffffffff));
  const moov = box('moov', mvhd, ...traks, box('mvex', ...trexBoxes));
  return Buffer.concat([ftyp, moov]);
}

// one track fragment. kind: 'video' (samples=AnnexB frames) | 'audio' (samples=raw AAC buffers)
function trackFragment(kind, trackId, seq, baseDTS, samples) {
  const data = samples.map(sm => kind === 'video' ? avccSample(sm.data) : sm.data);
  const mdatBody = Buffer.concat(data);
  const trunFlags = 0x000701; // data-offset + sample-duration + sample-size + sample-flags
  const entries = Buffer.concat(data.map((d, i) => Buffer.concat([u32(samples[i].duration), u32(d.length),
    u32(kind === 'video' ? (samples[i].isKey ? 0x02000000 : 0x01010000) : 0x02000000)])));
  const tfhd = fbox('tfhd', 0, 0x020000, u32(trackId)); // default-base-is-moof
  const tfdt = fbox('tfdt', 1, 0, u64(baseDTS));
  const mfhd = fbox('mfhd', 0, 0, u32(seq));
  let trun = fbox('trun', 0, trunFlags, u32(samples.length), u32(0), entries);
  let moof = box('moof', mfhd, box('traf', tfhd, tfdt, trun));
  const dataOffset = moof.length + 8;
  const trunStart = moof.indexOf(Buffer.from('trun'));
  moof.writeUInt32BE(dataOffset, trunStart + 4 + 4 + 4);
  return Buffer.concat([moof, box('mdat', mdatBody)]);
}
export const videoFragment = ({ seq, baseMediaDecodeTime, samples }) => trackFragment('video', VTRACK, seq, baseMediaDecodeTime, samples);
export const audioFragment = ({ seq, baseMediaDecodeTime, samples }) => trackFragment('audio', ATRACK, seq, baseMediaDecodeTime, samples);
export const codecString = sps => 'avc1.' + [sps[1], sps[2], sps[3]].map(b => b.toString(16).padStart(2, '0')).join('');
