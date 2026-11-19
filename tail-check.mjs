import net from 'node:net'; import crypto from 'node:crypto';
import * as v from './v380lan.mjs'; import * as cipher from './cipher-sectype2.mjs';
const IP='172.20.10.2'; const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n>>>0,0);return b;};
const MEDIA=0x38030820;
function req(s,m,p){const hj={id:crypto.randomInt(10,1e6),chn:1,method_id:m,ts:(Date.now()/1000|0),params:p};const body=cipher.encrypt(Buffer.from(JSON.stringify(hj),'latin1'),s.sKey,2);const h=Buffer.alloc(16);u32(v.CMD_COMMON_IOT).copy(h,0);h[4]=1;h[5]=2;h[6]=s.sid&0xff;h[7]=0;u32(body.length).copy(h,12);return Buffer.concat([h,body]);}
function dec(body,k,iv){const n=body.length&~15;const d=crypto.createDecipheriv('aes-128-cbc',k,iv);d.setAutoPadding(false);return Buffer.concat([d.update(body.subarray(0,n)),d.final(),body.subarray(n)]);}
const s=await v.keyExchange(IP,v.PORT,'origin'); const key=s.sKey.subarray(0,16),iv=s.sKey.subarray(16,32);
const st=Date.UTC(2026,10,19),en=Date.UTC(2026,10,19,23,59,59,999);
const {json}=await v.recFileList(IP,v.PORT,s,{mode:2,filter:15,start:st,end:en});
const seg=(json.data.list).sort((a,b)=>a.s-b.s)[0]; const lStart=st+seg.s;
const sock=net.connect({host:IP,port:v.PORT}); let buf=Buffer.alloc(0); let kf=null; let rawBody=null;
await new Promise(res=>{sock.on('connect',()=>sock.write(req(s,197154,{sts:lStart,pts:lStart+1,time_id:0,frames:50,speed:10,mode:2,video:1,audio:1,rtype:seg.t})));
 sock.on('data',d=>{buf=Buffer.concat([buf,d]);while(buf.length>=16){const cmd=buf.readUInt32LE(0),sz=buf.readUInt32LE(12);if(buf.length<16+sz)break;const b=buf.subarray(16,16+sz);buf=buf.subarray(16+sz);if(cmd===MEDIA){const f=dec(b,key,iv);if(f[1]===1&&!kf){kf=f;rawBody=Buffer.from(b);sock.destroy();res();}}}});setTimeout(()=>{sock.destroy();res();},5000);});
if(!kf){console.log('no keyframe');process.exit();}
const sz=kf.readUInt16LE(6); const total=kf.length; const tail=total%16;
console.log('keyframe total',total,'payloadSize@6',sz,'hdr',total-sz,'tail(total%16)',tail);
console.log('VIDEO start (offset 32..64):', kf.subarray(32,64).toString('hex'));
console.log('LAST 32 bytes (incl tail, decrypted):', kf.subarray(total-32).toString('hex'));
console.log('LAST 32 bytes (RAW ciphertext):', rawBody.subarray(total-32).toString('hex'));
// valid H.264 slice RBSP usually ends with a stop bit 0x80 or small trailing; random => encrypted
const last=kf.subarray(total-tail); console.log('tail bytes (plaintext as kept):', last.toString('hex'), 'entropy~', new Set(last).size+'/'+tail);
