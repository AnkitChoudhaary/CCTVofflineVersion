// Validate a captured H.264 Annex-B stream: split NAL units, keep only valid video NALs
// (drops interleaved audio/junk), parse the SPS for the real coded resolution, and write a
// clean .h264 that standard players (VLC, ffmpeg) open directly.
// Usage: node h264-check.mjs <in.h264> <out.h264>
import { readFileSync, writeFileSync } from 'node:fs';

const IN = process.argv[2] ?? 'clip.local.h264';
const OUT = process.argv[3] ?? 'clip-clean.local.h264';
const b = readFileSync(new URL('./' + IN, import.meta.url));

// Split Annex-B into NAL payloads (without start codes).
const units = [];
let i = 0;
function scLen(p) { if (b[p] === 0 && b[p + 1] === 0) { if (b[p + 2] === 1) return 3; if (b[p + 2] === 0 && b[p + 3] === 1) return 4; } return 0; }
let p = 0; let cur = -1, curLen = 0;
const starts = [];
for (p = 0; p + 3 < b.length; p++) { const n = scLen(p); if (n) { starts.push([p, n]); p += n - 1; } }
for (let k = 0; k < starts.length; k++) {
  const [sp, sn] = starts[k];
  const endp = k + 1 < starts.length ? starts[k + 1][0] : b.length;
  units.push(b.subarray(sp + sn, endp));
}

const VIDEO = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]); // valid H.264 NAL types we keep
const kept = [];
const typeCount = {};
let sps = null;
for (const u of units) {
  if (u.length === 0) continue;
  const t = u[0] & 0x1f;
  typeCount[t] = (typeCount[t] || 0) + 1;
  if (!VIDEO.has(t)) continue;
  if (t === 7 && !sps) sps = u;
  kept.push(u);
}

// --- minimal Exp-Golomb SPS parser for coded width/height ---
class BR { constructor(d){ this.d=d; this.p=0; } bit(){ const byte=this.d[this.p>>3]; const b=(byte>>(7-(this.p&7)))&1; this.p++; return b; }
  u(n){ let v=0; for(let i=0;i<n;i++) v=(v<<1)|this.bit(); return v>>>0; }
  ue(){ let z=0; while(this.bit()===0 && z<32) z++; return z===0?0:((1<<z)-1)+this.u(z); }
  se(){ const k=this.ue(); return (k&1)?((k+1)>>1):-(k>>1); } }
function rbsp(nal){ const o=[]; for(let i=1;i<nal.length;i++){ if(i>2 && nal[i]===3 && nal[i-1]===0 && nal[i-2]===0){ continue; } o.push(nal[i]); } return Buffer.from(o); }
function parseSPS(nal){
  const r=new BR(rbsp(nal));
  const profile=r.u(8); r.u(8); const level=r.u(8); r.ue(); // sps_id
  if([100,110,122,244,44,83,86,118,128,138,139,134,135].includes(profile)){
    const chroma=r.ue(); if(chroma===3) r.u(1); r.ue(); r.ue(); r.u(1);
    const sl=r.u(1); if(sl){ /* scaling lists not handled */ }
  }
  r.ue(); // log2_max_frame_num
  const poc=r.ue(); if(poc===0) r.ue(); else if(poc===1){ r.u(1); r.se(); r.se(); const n=r.ue(); for(let i=0;i<n;i++) r.se(); }
  r.ue(); r.u(1); // max_num_ref_frames, gaps
  const wMb=r.ue()+1, hMap=r.ue()+1;
  const frameMbsOnly=r.u(1);
  if(!frameMbsOnly) r.u(1);
  r.u(1); // direct_8x8
  let cl=0,cr=0,ct=0,cb=0; const crop=r.u(1);
  if(crop){ cl=r.ue(); cr=r.ue(); ct=r.ue(); cb=r.ue(); }
  const width=wMb*16-(cl+cr)*2;
  const height=(2-frameMbsOnly)*hMap*16-(ct+cb)*2;
  return { profile, level, width, height };
}

writeFileSync(new URL('./' + OUT, import.meta.url), Buffer.concat(kept.flatMap(u => [Buffer.from([0,0,0,1]), u])));
console.log('NAL types in capture:', JSON.stringify(typeCount));
console.log('kept video NALs:', kept.length, '-> wrote', OUT);
if (sps) { try { console.log('SPS parsed:', JSON.stringify(parseSPS(sps))); } catch (e) { console.log('SPS parse err', e.message); } }
