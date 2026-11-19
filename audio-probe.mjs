import net from 'node:net'; import crypto from 'node:crypto';
import * as v from './v380lan.mjs'; import * as cipher from './cipher-sectype2.mjs';
const IP=process.argv[2]??'172.20.10.2', DAY=process.argv[3]??'2026-11-19', IDX=Number(process.argv[4]??0);
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n>>>0,0);return b;};
const MEDIA=0x38030820, INFO=0x38030822;
function req(s,m,p){const hj={id:crypto.randomInt(10,1e6),chn:1,method_id:m,ts:(Date.now()/1000|0),params:p};const body=cipher.encrypt(Buffer.from(JSON.stringify(hj),'latin1'),s.sKey,2);const h=Buffer.alloc(16);u32(v.CMD_COMMON_IOT).copy(h,0);h[4]=1;h[5]=2;h[6]=s.sid&0xff;h[7]=0;u32(body.length).copy(h,12);return Buffer.concat([h,body]);}
function dec(body,k,iv){const n=body.length&~15;const d=crypto.createDecipheriv('aes-128-cbc',k,iv);d.setAutoPadding(false);return Buffer.concat([d.update(body.subarray(0,n)),d.final(),body.subarray(n)]);}
const s=await v.keyExchange(IP,v.PORT,process.env.V380_LAN_PASS??'origin');
const key=s.sKey.subarray(0,16),iv=s.sKey.subarray(16,32);
const [Y,M,D]=DAY.split('-').map(Number); const st=Date.UTC(Y,M-1,D),en=Date.UTC(Y,M-1,D,23,59,59,999);
const {json}=await v.recFileList(IP,v.PORT,s,{mode:2,filter:15,start:st,end:en});
const list=(json?.data?.list||[]).sort((a,b)=>a.s-b.s); const seg=list[IDX]; const lStart=st+seg.s;
const sock=net.connect({host:IP,port:v.PORT}); let buf=Buffer.alloc(0); const aud=[]; let info=null;
await new Promise(res=>{ sock.on('connect',()=>sock.write(req(s,197154,{sts:lStart,pts:lStart+1,time_id:0,frames:200,speed:10,mode:2,video:1,audio:1,rtype:seg.t})));
 sock.on('data',d=>{buf=Buffer.concat([buf,d]);while(buf.length>=16){const cmd=buf.readUInt32LE(0),sz=buf.readUInt32LE(12);if(buf.length<16+sz)break;const b=buf.subarray(16,16+sz);buf=buf.subarray(16+sz);if(cmd===INFO){try{info=JSON.parse(cipher.decrypt(b,s.sKey,2).toString('latin1'))?.params?.info;}catch{}}else if(cmd===MEDIA){const f=dec(b,key,iv);if(f[1]===4)aud.push(f);}}});
 setTimeout(()=>{sock.destroy();res();},4000);});
console.log('audio codec', JSON.stringify(info?.aattr), 'frames', aud.length);
for(const f of aud.slice(0,5)){const sz=f.readUInt16LE(6);const pl=f.subarray(32,32+sz);console.log('size',sz,'hdr',f.subarray(0,32).toString('hex'),'pl0',pl.subarray(0,16).toString('hex'));}
