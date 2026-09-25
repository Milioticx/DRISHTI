/* DRISHTI shared core — frame decode (21B TelemetryFrame_t), state, backend link, draw helpers */
const HAZ=[{n:'NORMAL',c:'#22c55e',a:'All parameters nominal. Continue monitoring.'},
{n:'FLASH FLOOD',c:'#38bdf8',a:'Rapid water rise detected. Warn downstream villages, begin pre-evacuation, close low-lying roads.'},
{n:'WILDFIRE',c:'#f97316',a:'Heat and gas surge detected. Alert forest dept and fire services, evacuate leeward zones.'},
{n:'GAS LEAK',c:'#a855f7',a:'Rapid gas rise detected. Ventilate, remove ignition sources, restrict access, dispatch HAZMAT.'}];
const METRICS=[{k:'water',l:'Water level',u:'mm',c:'#38bdf8'},{k:'surge',l:'Surge rate',u:'mm/s',c:'#38bdf8'},
{k:'gas',l:'Gas',u:'ppm',c:'#a855f7'},{k:'grate',l:'Gas rate',u:'ppm/s',c:'#a855f7'},
{k:'temp',l:'Temperature',u:'°C',c:'#f97316'},{k:'vib',l:'Vibration',u:'rms',c:'#facc15'}];
const $=i=>document.getElementById(i);
const D={N:{},sel:null,buf:[],port:null,demo:null,scen:0,good:0,bad:0,raws:[],logs:[],be:false,onSrv:/^https?:/.test(location.protocol),API:location.origin};
const pad=i=>'N-'+String(i).padStart(2,'0');
window.D=D;window.HAZ=HAZ;window.METRICS=METRICS;window.$=$;window.pad=pad;

// ---- 21-byte TelemetryFrame_t decoder: sync 0xAA, LE fields, sum16 checksum over first 19 bytes ----
function feed(u){D.buf.push(...u);for(;;){const i=D.buf.indexOf(0xAA);if(i<0){D.buf=[];return}if(i)D.buf.splice(0,i);if(D.buf.length<21)return;
const f=Uint8Array.from(D.buf.slice(0,21)),dv=new DataView(f.buffer);let s=0;for(let k=0;k<19;k++)s+=f[k];
if((s&0xFFFF)===dv.getUint16(19,true)){D.buf.splice(0,21);D.raws.unshift([...f].map(b=>b.toString(16).padStart(2,'0')).join(' '));D.raws.length=Math.min(D.raws.length,8);
const o={id:f[1],seq:dv.getUint32(2,true),water:dv.getInt16(6,true),surge:dv.getInt16(8,true),gas:dv.getInt16(10,true),grate:dv.getInt16(12,true),temp:dv.getInt16(14,true),vib:dv.getInt16(16,true),cls:Math.min(f[18],3)};
ingest(o);post(o)}else{D.buf.shift();D.bad++}}}
function ingest(o){D.good++;const n=D.N[o.id]||(D.N[o.id]={id:o.id,h:[],lost:0,n:0,cls:-1,seq:null,first:Date.now()});
if(n.seq!=null&&o.seq!=null&&o.seq>n.seq+1)n.lost+=o.seq-n.seq-1;n.seq=o.seq??n.seq;n.n++;n.t=Date.now();
if(o.cls!==n.cls){D.logs.unshift({t:new Date().toLocaleTimeString(),id:o.id,c:o.cls,from:n.cls});D.logs.length=Math.min(D.logs.length,80)}
n.cls=o.cls;n.h.push(o);if(n.h.length>300)n.h.shift();n.last=o;if(D.sel===null)D.sel=o.id;
document.dispatchEvent(new CustomEvent('drishti:data',{detail:o}));}
window.feed=feed;window.ingest=ingest;

// ---- Backend integration ----
const fromRow=r=>({id:parseInt(String(r.node_id).replace(/\D/g,''))||0,seq:r.seq_num??null,water:Math.round(r.water_height_m*1000),surge:Math.round(r.water_rate_cm_min/6),gas:Math.round(r.gas_ppm),grate:Math.round(r.gas_rate_ppm_s),temp:Math.round(r.fire_temp_c),vib:Math.round(r.vibration_rms),cls:Math.min(r.ai_class|0,3),ts:r.timestamp});
function post(o){if(!D.onSrv)return;fetch(D.API+'/api/telemetry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({node_id:pad(o.id),gas_ppm:o.gas,gas_rate_ppm_s:o.grate,water_height_m:o.water/1000,water_rate_cm_min:o.surge*6,fire_temp_c:o.temp,vibration_rms:o.vib,ai_class:o.cls})}).catch(()=>{})}
async function seed(){if(!D.onSrv)return;try{const L=await(await fetch(D.API+'/api/telemetry/latest')).json();for(const r of L){const h=await(await fetch(`${D.API}/api/telemetry/history?node_id=${r.node_id}&limit=300`)).json();h.forEach(x=>ingest(fromRow(x)))}D.good=0;document.dispatchEvent(new CustomEvent('drishti:seeded'))}catch{}}
async function historyFor(id,limit=300){
// Prefer the live in-memory buffer (works for Demo mode and USB, neither of which
// necessarily has every packet saved server-side). Only hit the DB when we don't
// have a decent local buffer yet, e.g. right after opening the page.
const local=D.N[id]?D.N[id].h:[];
if(local.length>=Math.min(20,limit))return local.slice(-limit);
if(!D.onSrv)return local;
try{const rows=(await(await fetch(`${D.API}/api/telemetry/history?node_id=${pad(id)}&limit=${limit}`)).json()).map(fromRow);
return rows.length>local.length?rows:local;}catch{return local}}
function connectWS(){if(!D.onSrv)return;const s=new WebSocket((location.protocol=='https:'?'wss':'ws')+'://'+location.host+'/ws');
s.onopen=()=>{D.be=true;document.dispatchEvent(new Event('drishti:status'))};
s.onmessage=e=>{try{const m=JSON.parse(e.data);if(m.type=='telemetry'&&!D.port&&!D.demo)ingest(fromRow(m.data))}catch{}};
s.onclose=()=>{D.be=false;document.dispatchEvent(new Event('drishti:status'));setTimeout(connectWS,2500)}}
window.seed=seed;window.historyFor=historyFor;window.connectWS=connectWS;

// ---- Web Serial (USB gateway) ----
async function toggleSerial(btn){if(!('serial'in navigator))return alert('Web Serial needs Chrome or Edge (desktop).');
if(D.port){try{await D.port.close()}catch{}D.port=null;if(btn)btn.textContent='⚡ Connect Gateway (USB)';document.dispatchEvent(new Event('drishti:status'));return}
try{D.port=await navigator.serial.requestPort();await D.port.open({baudRate:115200});stopDemo();if(btn)btn.textContent='⏏ Disconnect';document.dispatchEvent(new Event('drishti:status'));
const r=D.port.readable.getReader();for(;;){const{value,done}=await r.read();if(done)break;feed(value)}}catch(e){console.warn(e)}D.port=null;document.dispatchEvent(new Event('drishti:status'))}
function startDemo(){if(D.demo)return;let q=[0,0,0],T=0;
D.demo=setInterval(()=>{T++;[1,2,3].forEach((id,k)=>{q[k]++;const on=(D.scen&&id===2),w=on&&D.scen===1,g=on&&D.scen===3,f=on&&D.scen===2,x=Math.sin(T/9+k)*8;
ingest({id,seq:q[k],water:Math.round(150+x+k*20+(w?(T%60)*9:0)),surge:w?14:Math.round(x/4),gas:Math.round(120+x*2+(g||f?(T%40)*9:0)),grate:g||f?18:Math.round(x/3),temp:Math.round(29+k+(f?22:0)+x/8),vib:Math.round(2+Math.random()*3),cls:on?D.scen:0})})},900);document.dispatchEvent(new Event('drishti:status'))}
function stopDemo(){clearInterval(D.demo);D.demo=null;document.dispatchEvent(new Event('drishti:status'))}
window.toggleSerial=toggleSerial;window.startDemo=startDemo;window.stopDemo=stopDemo;

// ---- draw helpers ----
function line(cv,series,opt={}){if(!cv)return;const r=devicePixelRatio||1,w=cv.clientWidth||100,h=cv.clientHeight||40;cv.width=w*r;cv.height=h*r;const g=cv.getContext('2d');g.scale(r,r);g.clearRect(0,0,w,h);
series.forEach(([d,c])=>{if(!d||d.length<2)return;const mn=Math.min(...d),mx=Math.max(...d),sp=(mx-mn)||1;g.beginPath();d.forEach((v,i)=>{const x=i/(d.length-1)*w,y=h-4-(v-mn)/sp*(h-8);i?g.lineTo(x,y):g.moveTo(x,y)});g.strokeStyle=c;g.lineWidth=opt.lw||1.6;g.stroke();
if(opt.fill){g.lineTo(w,h);g.lineTo(0,h);g.fillStyle=c+'22';g.fill()}})}
function gauge(cv,pct,color,size){if(!cv)return;const r=devicePixelRatio||1,w=size||74,h=size||74;
// fixed logical size on purpose: reading cv.clientWidth after cv.width has already
// been scaled by dpr causes runaway growth on high-DPI/scaled displays (each
// redraw would measure the already-enlarged canvas and enlarge it again).
if(cv.width!==w*r||cv.height!==h*r){cv.width=w*r;cv.height=h*r}
const g=cv.getContext('2d');g.setTransform(r,0,0,r,0,0);g.clearRect(0,0,w,h);
const cx=w/2,cy=h/2,rad=Math.min(w,h)/2-6,s=-Math.PI*0.75,e=Math.PI*0.75;
g.beginPath();g.arc(cx,cy,rad,s,e);g.strokeStyle='#1e2d33';g.lineWidth=7;g.lineCap='round';g.stroke();
g.beginPath();g.arc(cx,cy,rad,s,s+(e-s)*Math.max(0,Math.min(1,pct)));g.strokeStyle=color;g.lineWidth=7;g.lineCap='round';g.stroke()}
window.line=line;window.gauge=gauge;

function status(){const l=D.port||D.demo;return{live:!!l,label:D.port?'USB GATEWAY LIVE':D.demo?'DEMO MODE':D.be?'BACKEND LIVE':'OFFLINE',be:D.be}}
window.statusInfo=status;
setInterval(()=>document.dispatchEvent(new Event('drishti:tick')),1000);
