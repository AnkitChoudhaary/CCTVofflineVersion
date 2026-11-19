// Minimal MP4 (ISO-BMFF) muxer: H.264 video (avc1) + AAC-LC audio (mp4a). Pure JS, no deps.
// Inputs: video frames as Annex-B NAL buffers; audio frames as raw AAC (ADTS stripped).
// Non-fragmented, non-interleaved (all video samples then all audio). Plays in VLC/QuickTime/browsers.
const u8 = n => Buffer.from([n & 255]);
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff, 0); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
const s = t => Buffer.from(t, 'latin1');
const box = (type, ...p) => { const b = Buffer.concat(p); return Buffer.concat([u32(b.length + 8), s(type), b]); };
const fbox = (type, ver, flags, ...p) => box(type, Buffer.from([ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...p);
const UNITY = Buffer.from([0,1,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,1,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0x40,0,0,0]);

function splitNals(b) {
  const starts = [];
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0) {
      if (b[i + 2] === 1) { starts.push([i, 3]); i += 2; }
      else if (b[i + 2] === 0 && b[i + 3] === 1) { starts.push([i, 4]); i += 3; }
    }
  }
  return starts.map(([p, n], k) => b.subarray(p + n, k + 1 < starts.length ? starts[k + 1][0] : b.length));
}
function avcSample(frame) {
  const parts = [];
  for (const nal of splitNals(frame)) {
    const t = nal[0] & 0x1f;
    if (t === 7 || t === 8 || t === 9) continue; // SPS/PPS/AUD go in avcC
    parts.push(u32(nal.length), nal);
  }
  return Buffer.concat(parts);
}
const avcC = (sps, pps) => box('avcC', u8(1), u8(sps[1]), u8(sps[2]), u8(sps[3]), u8(0xff),
  u8(0xe1), u16(sps.length), sps, u8(1), u16(pps.length), pps);

function sttsBox(entries) {
  const runs = [];
  for (const e of entries) { const last = runs[runs.length - 1]; if (last && last.d === e.dur) last.c++; else runs.push({ c: 1, d: e.dur }); }
  return fbox('stts', 0, 0, u32(runs.length), ...runs.flatMap(r => [u32(r.c), u32(r.d)]));
}
const stszBox = entries => fbox('stsz', 0, 0, u32(0), u32(entries.length), ...entries.map(e => u32(e.size)));
const stscBox = n => fbox('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1));
const stcoBox = off => fbox('stco', 0, 0, u32(1), u32(off));

const stssBox = idx => fbox('stss', 0, 0, u32(idx.length), ...idx.map(u32));
function trak(id, isAudio, timescale, entries, mediaDur, movieDurMs, stsd, chunkOff, width, height, keyframes) {
  const tkhd = fbox('tkhd', 0, 7, u32(0), u32(0), u32(id), u32(0), u32(movieDurMs),
    Buffer.alloc(8), u16(0), u16(0), u16(isAudio ? 0x0100 : 0), u16(0), UNITY,
    u32(isAudio ? 0 : (width << 16)), u32(isAudio ? 0 : (height << 16)));
  const mdhd = fbox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(mediaDur), u16(0x55c4), u16(0));
  const hdlr = fbox('hdlr', 0, 0, u32(0), s(isAudio ? 'soun' : 'vide'), Buffer.alloc(12), s((isAudio ? 'SoundHandler' : 'VideoHandler') + '\0'));
  const mh = isAudio ? fbox('smhd', 0, 0, u16(0), u16(0)) : fbox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0));
  const dinf = box('dinf', fbox('dref', 0, 0, u32(1), fbox('url ', 0, 1)));
  const stblParts = [stsd, sttsBox(entries), stscBox(entries.length), stszBox(entries), stcoBox(chunkOff)];
  if (keyframes && keyframes.length) stblParts.splice(2, 0, stssBox(keyframes)); // stss after stts
  const stbl = box('stbl', ...stblParts);
  return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', mh, dinf, stbl)));
}

export function mux({ videoFrames, audioFrames, width, height, videoTimescale, videoFrameDur, audioRate, sps, pps, asc, keyframes }) {
  const vSamples = videoFrames.map(avcSample);
  const aSamples = audioFrames;
  const vDur = vSamples.length * videoFrameDur, aDur = aSamples.length * 1024;
  const movieDurMs = Math.round(Math.max(vDur / videoTimescale, aDur / audioRate) * 1000);

  const vStsd = fbox('stsd', 0, 0, u32(1), box('avc1',
    Buffer.alloc(6), u16(1), Buffer.alloc(16), u16(width), u16(height),
    u32(0x00480000), u32(0x00480000), u32(0), u16(1), Buffer.alloc(32), u16(0x18), u16(0xffff), avcC(sps, pps)));
  const esds = fbox('esds', 0, 0,
    u8(0x03), u8(0x19 + asc.length), u16(1), u8(0),
    u8(0x04), u8(0x11 + asc.length), u8(0x40), u8(0x15), Buffer.alloc(3), u32(0), u32(0),
    u8(0x05), u8(asc.length), asc, u8(0x06), u8(1), u8(2));
  const aStsd = fbox('stsd', 0, 0, u32(1), box('mp4a',
    Buffer.alloc(6), u16(1), Buffer.alloc(8), u16(1), u16(16), u32(0), u16(audioRate), u16(0), esds));

  const vEntries = vSamples.map(x => ({ size: x.length, dur: videoFrameDur }));
  const aEntries = aSamples.map(x => ({ size: x.length, dur: 1024 }));
  const ftyp = box('ftyp', s('isom'), u32(0x200), s('isomiso2avc1mp41'));

  const build = (vOff, aOff) => {
    const mvhd = fbox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(movieDurMs),
      u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), UNITY, Buffer.alloc(24), u32(3));
    const vtrak = trak(1, false, videoTimescale, vEntries, vDur, movieDurMs, vStsd, vOff, width, height, keyframes);
    const atrak = trak(2, true, audioRate, aEntries, aDur, movieDurMs, aStsd, aOff, 0, 0, null);
    return box('moov', mvhd, vtrak, atrak);
  };
  let moov = build(0, 0);
  const head = ftyp.length + moov.length + 8; // +8 mdat header
  const vOff = head, aOff = head + vSamples.reduce((t, x) => t + x.length, 0);
  moov = build(vOff, aOff);
  const mdat = box('mdat', ...vSamples, ...aSamples);
  return Buffer.concat([ftyp, moov, mdat]);
}
