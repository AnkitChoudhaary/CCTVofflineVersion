import net from 'node:net'; import crypto from 'node:crypto';
import * as v from './v380lan.mjs'; import * as cipher from './cipher-sectype2.mjs';
const IP='172.20.10.2'; const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n>>>0,0);return b;};
function req(s,m,p){const hj={id:crypto.randomInt(10,1e6),chn:1,method_id:m,ts:(Date.now()/1000|0),params:p};const body=cipher.encrypt(Buffer.from(JSON.stringify(hj),'latin1'),s.sKey,2);const h=Buffer.alloc(16);u32(v.CMD_COMMON_IOT).copy(h,0);h[4]=1;h[5]=2;h[6]=s.sid&0xff;h[7]=0;u32(body.length).copy(h,12);return Buffer.concat([h,body]);}
function dec(body,k,iv){if(body.length<32){const n=body.length&~15;const d=crypto.createDecipheriv('aes-128-cbc',k,iv);d.setAutoPadding(false);return Buffer.concat([d.update(body.subarray(0,n)),d.final(),body.subarray(n)]);}const d=crypto.createDecipheriv('aes-128-cbc',k,iv);d.setAutoPadding(false);const hdr=d.update(body.subarray(0,32));let e=Math.min(hdr.readUInt32LE(22)>>>0,body.length-32)&~15;const ed=e>0?d.update(body.subarray(32,32+e)):Buffer.alloc(0);d.final();return Buffer.concat([hdr,ed,body.subarray(32+e)]);}
const s=await v.keyExchange(IP,v.PORT,'origin'); const key=s.sKey.subarray(0,16),iv=s.sKey.subarray(16,32);
console.log('auth',s.result,'sid',s.sid);
const sock=net.connect({host:IP,port:v.PORT}); let buf=Buffer.alloc(0); const kinds={}; let vid=0,aud=0,info=null; const t0=Date.now();
sock.on('connect',()=>sock.write(req(s,197122,{up:{quality:1,video:1,audio:1,IDRreq:1}})));
sock.on('data',d=>{buf=Buffer.concat([buf,d]);while(buf.length>=16){const cmd=buf.readUInt32LE(0),sz=buf.readUInt32LE(12),sec=buf[5];if(buf.length<16+sz)break;const b=buf.subarray(16,16+sz);buf=buf.subarray(16+sz);const k='0x'+cmd.toString(16)+' sec'+sec;kinds[k]=(kinds[k]||0)+1;
 if(cmd===0x38030818||cmd===0x38030822){try{const j=JSON.parse((sec===0?b:cipher.decrypt(b,s.sKey,2)).toString('latin1'));if(j.method_id===197124)info=j.params?.info;if(j.result)console.log('ctrl resp',JSON.stringify(j).slice(0,120));}catch{}}
 else if(cmd===0x38030820){const f=dec(b,key,iv);if(f[1]===4)aud++;else{vid++;if(vid<=2){const p=f.subarray(b.length-f.readUInt16LE(6));console.log('vframe type',f[1],'nal',p.subarray(0,8).toString('hex'));}}}}});
const ka=setInterval(()=>{if(!sock.destroyed)sock.write(req(s,0x30200,{flag:2,tms1:0,decode_tms:0}));},2000);
setTimeout(()=>{clearInterval(ka);sock.destroy();console.log('frames in',((Date.now()-t0)/1000).toFixed(1)+'s: video',vid,'audio',aud);console.log('kinds',kinds);console.log('info',JSON.stringify(info));},6000);
