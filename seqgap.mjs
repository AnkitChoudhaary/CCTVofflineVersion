import net from 'node:net'; import crypto from 'node:crypto';
import * as v from './v380lan.mjs'; import * as cipher from './cipher-sectype2.mjs';
const IP='172.20.10.2'; const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n>>>0,0);return b;};
function req(s,m,p){const hj={id:crypto.randomInt(10,1e6),chn:1,method_id:m,ts:(Date.now()/1000|0),params:p};const body=cipher.encrypt(Buffer.from(JSON.stringify(hj),'latin1'),s.sKey,2);const h=Buffer.alloc(16);u32(v.CMD_COMMON_IOT).copy(h,0);h[4]=1;h[5]=2;h[6]=s.sid&0xff;h[7]=0;u32(body.length).copy(h,12);return Buffer.concat([h,body]);}
function dec(b,k,iv){const n=b.length&~15;const d=crypto.createDecipheriv('aes-128-cbc',k,iv);d.setAutoPadding(false);return Buffer.concat([d.update(b.subarray(0,n)),d.final(),b.subarray(n)]);}
const s=await v.keyExchange(IP,v.PORT,'origin'); const key=s.sKey.subarray(0,16),iv=s.sKey.subarray(16,32);
const st=Date.UTC(2026,10,19),en=Date.UTC(2026,10,19,23,59,59,999);
const {json}=await v.recFileList(IP,v.PORT,s,{mode:2,filter:15,start:st,end:en}); const seg=json.data.list.sort((a,b)=>a.s-b.s)[0];
const sock=net.connect({host:IP,port:v.PORT}); let buf=Buffer.alloc(0); const vseq=[],aseq=[]; let order=[];
await new Promise(res=>{sock.on('connect',()=>sock.write(req(s,197154,{sts:st+seg.s,pts:st+seg.s+1,time_id:0,frames:400,speed:10,mode:2,video:1,audio:1,rtype:seg.t})));
 sock.on('data',d=>{buf=Buffer.concat([buf,d]);while(buf.length>=16){const cmd=buf.readUInt32LE(0),sz=buf.readUInt32LE(12);if(buf.length<16+sz)break;const b=buf.subarray(16,16+sz);buf=buf.subarray(16+sz);if(cmd===0x38030820){const f=dec(b,key,iv);const ty=f[1],sq=f.readUInt16LE(2);if(ty===1||ty===2){vseq.push(sq);order.push(ty===1?'I':'P');}else if(ty===4)aseq.push(sq);if(vseq.length>=250){sock.destroy();res();}}}});setTimeout(()=>{sock.destroy();res();},8000);});
// check contiguity
let gaps=[];for(let i=1;i<vseq.length;i++)if(vseq[i]!==vseq[i-1]+1)gaps.push(`${vseq[i-1]}->${vseq[i]}`);
console.log('video frames',vseq.length,'first',vseq[0],'last',vseq[vseq.length-1],'order[0..20]',order.slice(0,20).join(''));
console.log('gaps',gaps.length, gaps.slice(0,10).join(' '));
console.log('first I at index', order.indexOf('I'));
