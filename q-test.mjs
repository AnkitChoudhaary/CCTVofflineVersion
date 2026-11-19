import net from 'node:net'; import crypto from 'node:crypto';
import * as v from './v380lan.mjs'; import * as cipher from './cipher-sectype2.mjs';
import { parseSPS } from './app/lib.mjs';
const IP='172.20.10.2'; const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n>>>0,0);return b;};
function req(s,m,p){const hj={id:crypto.randomInt(10,1e6),chn:1,method_id:m,ts:(Date.now()/1000|0),params:p};const body=cipher.encrypt(Buffer.from(JSON.stringify(hj),'latin1'),s.sKey,2);const h=Buffer.alloc(16);u32(v.CMD_COMMON_IOT).copy(h,0);h[4]=1;h[5]=2;h[6]=s.sid&0xff;h[7]=0;u32(body.length).copy(h,12);return Buffer.concat([h,body]);}
function dec(body,k,iv){const d=crypto.createDecipheriv('aes-128-cbc',k,iv);d.setAutoPadding(false);const hdr=d.update(body.subarray(0,32));let e=Math.min(hdr.readUInt32LE(22)>>>0,body.length-32)&~15;const ed=e>0?d.update(body.subarray(32,32+e)):Buffer.alloc(0);d.final();return Buffer.concat([hdr,ed,body.subarray(32+e)]);}
async function test(quality){
  const s=await v.keyExchange(IP,v.PORT,'origin'); const key=s.sKey.subarray(0,16),iv=s.sKey.subarray(16,32);
  const sock=net.connect({host:IP,port:v.PORT}); let buf=Buffer.alloc(0); let done=false;
  return await new Promise(res=>{
   sock.on('connect',()=>sock.write(req(s,197122,{up:{quality,video:1,audio:1,IDRreq:1}})));
   const ka=setInterval(()=>{if(!sock.destroyed)sock.write(req(s,0x30200,{flag:2,tms1:0,decode_tms:0}));},1500);
   sock.on('data',d=>{buf=Buffer.concat([buf,d]);while(buf.length>=16){const cmd=buf.readUInt32LE(0),sz=buf.readUInt32LE(12);if(buf.length<16+sz)break;const b=buf.subarray(16,16+sz);buf=buf.subarray(16+sz);
    if(cmd===0x38030820&&!done){const f=dec(b,key,iv);if(f[1]===1){const pl=f.subarray(b.length-f.readUInt16LE(6));const sps=(()=>{let o=0;for(let i=0;i+4<pl.length;i++)if(pl[i]===0&&pl[i+1]===0&&(pl[i+2]===1||(pl[i+2]===0&&pl[i+3]===1))){const st=pl[i+2]===1?i+3:i+4;if((pl[st]&0x1f)===7){let e=st+1;for(;e+3<pl.length;e++)if(pl[e]===0&&pl[e+1]===0&&(pl[e+2]===1))break;return pl.subarray(st,e);}}return null;})();if(sps){const dim=parseSPS(sps);done=true;clearInterval(ka);sock.destroy();res({quality,...dim});}}}}});
   setTimeout(()=>{clearInterval(ka);sock.destroy();if(!done)res({quality,timeout:true});},5000);
  });
}
for(const q of [0,1,2]) console.log(JSON.stringify(await test(q)));
