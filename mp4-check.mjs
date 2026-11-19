import { readFileSync } from 'node:fs';
const b = readFileSync(new URL('./' + (process.argv[2] ?? 'clip.local.mp4'), import.meta.url));
function walk(off, end, depth, path) {
  const out = [];
  let p = off;
  while (p + 8 <= end) {
    let size = b.readUInt32BE(p); const type = b.toString('latin1', p + 4, p + 8);
    let hs = 8; if (size === 1) { size = Number(b.readBigUInt64BE(p + 8)); hs = 16; }
    if (size < hs || p + size > end) { out.push(`${'  '.repeat(depth)}${type} BAD size=${size}`); break; }
    out.push(`${'  '.repeat(depth)}${type} @${p} size=${size}`);
    const container = ['moov','trak','mdia','minf','stbl','dinf','edts','udta'].includes(type);
    if (container) out.push(...walk(p + hs, p + size, depth + 1, path + '/' + type));
    results[path + '/' + type] = { p, size, hs };
    p += size;
  }
  return out;
}
const results = {};
console.log(walk(0, b.length, 0, '').join('\n'));
// validate sample tables
function parseStbl(prefix) {
  const get = n => results[prefix + n];
  const stsz = get('/stsz'); const stco = get('/stco'); const stts = get('/stts');
  const r = {};
  if (stsz) { const base = stsz.p + stsz.hs; const count = b.readUInt32BE(base + 8); let tot = 0; const sz = b.readUInt32BE(base + 4); for (let i = 0; i < count; i++) tot += b.readUInt32BE(base + 12 + i * 4); r.samples = count; r.bytes = tot; }
  if (stco) { const base = stco.p + stco.hs; r.chunkOff = b.readUInt32BE(base + 4); }
  if (stts) { const base = stts.p + stts.hs; const n = b.readUInt32BE(base); let dur = 0; for (let i = 0; i < n; i++) dur += b.readUInt32BE(base + 4 + i * 8) * b.readUInt32BE(base + 8 + i * 8); r.totalDur = dur; }
  return r;
}
const traks = Object.keys(results).filter(k => k.endsWith('/trak'));
for (const tk of traks) {
  const hasAvc1 = results[tk + '/mdia/minf/stbl/stsd'];
  const r = parseStbl(tk + '/mdia/minf/stbl');
  const mdat = results['/mdat'];
  const inMdat = r.chunkOff >= mdat.p && r.chunkOff + r.bytes <= mdat.p + mdat.size;
  console.log(tk, JSON.stringify(r), 'chunk-in-mdat:', inMdat);
}
