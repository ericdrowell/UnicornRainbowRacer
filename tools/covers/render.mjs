// Offline cover staging using the shipped geometry, shader programs and browser-font atlas.
// Does not change the playable game. Run after npm run build/prod.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
process.chdir(root);
const deps=process.env.COVER_DEPS || '/tmp/urr329-validation/node_modules';
const {create,globals}=await import(`${deps}/webgpu/index.js`);
const {createCanvas,ImageData}=await import(`${deps}/@napi-rs/canvas/index.js`);
Object.assign(globalThis,globals);
const gpu=create(['backend=metal']);
const adapter=await gpu.requestAdapter();
const device=await adapter.requestDevice();
device.addEventListener('uncapturederror',e=>{throw Error(e.error.message)});
const read=p=>fs.readFileSync(p,'utf8');
const game=read('src/game.js');
const prefix=game.slice(0,game.indexOf('lay();')+6).replace('const MUSIC_ENABLED = true','const MUSIC_ENABLED = false');
let ctx=vm.createContext({document:{querySelector:()=>({})},device,console});
const run=s=>vm.runInContext(s,ctx);
run(read('dist/brometal.js')+'\n'+read('dist/shaders.js')+'\n'+read('src/unicorns.js')+'\n'+read('src/unicorn.js')+'\n'+read('src/circuits.js')+'\n'+prefix+'\n'+read('src/text.js'));
run(game.slice(game.indexOf('function livery('),game.indexOf('\n/**',game.indexOf('function livery('))));
run(`bmDevice=device;bmFormat='rgba8unorm';
const coverProgram=(s,o={})=>bmProgram(s[0],{a:s[1],i:s[2],u:s[3],t:s[4],s:s[5],...o});
const coverState=bmStore(new Float32Array(748));
const coverTrack=bmStore(TRACK_DATA);
const racers=coverProgram(Unicorn,{cull:1});
[P,NR,RT,SK,CL].forEach((a,i)=>bmAttr(racers,i,new Float32Array(a)));
bmAttr(racers,5,Float32Array.from({length:FIELD},(_,i)=>i));bmIndex(racers,idx);bmStorages(racers,coverState);
const smallRingTrack=[...Track];smallRingTrack[0]=Track[0].replace('mix(0.6, 2.4, b)','mix(0.42, 2.4, b)').replace('mix(4.5, 17.9, b)','mix(3.15, 17.9, b)');
const road=coverProgram(smallRingTrack,{blend:1});
for(const [p,start,end]of [[road,0,TI.length]]){
 bmAttr(p,0,new Float32Array(TP));bmAttr(p,1,new Float32Array(TE));
 const indices=[];const onlyRing=TP[TE.findIndex(v=>v===9)/2*3];for(let j=start;j<end;j+=3){const id=TI[j],mark=TE[id*2];const farRoad=mark<4 && TI.slice(j,j+3).every(n=>Math.hypot(TP[n*3]-TRACK_DATA[0],TP[n*3+1]-TRACK_DATA[1],TP[n*3+2]-TRACK_DATA[2])>120);if(!farRoad && mark!==8 && (mark!==9 || TP[id*3]===onlyRing))indices.push(...TI.slice(j,j+3));}
 bmIndex(p,new Uint16Array(indices));bmStorages(p,coverState,coverTrack);
}
let sky=coverProgram(Sky,{zwrite:0});const warp=coverProgram(Sky,{zwrite:0,blend:1});
for(const p of [sky,warp]){bmAttr(p,0,new Float32Array([-1,-1,3,-1,-1,3]));bmIndex(p,new Uint16Array([0,1,2]));bmStorages(p,coverState);}
`);
const data=run('({TRACK_DATA,RINGS,PATTERN,PICK_BASE,STAR_SLOTS,FIELD,UNICORNS,PALETTE,TP,TE,P,RT,SK})');
const add=(a,b)=>a.map((v,i)=>v+b[i]),mul=(a,s)=>a.map(v=>v*s),dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],unit=a=>mul(a,1/Math.hypot(...a));
const rec=i=>Array.from(data.TRACK_DATA.slice(i*4,i*4+3));
const origin=rec(0),forward=unit(rec(1)),up=unit(rec(2)),side=cross(forward,up);
const point=(x,y,z)=>add(add(add(origin,mul(side,x)),mul(up,y)),mul(forward,z));
const output=path.resolve('artifacts/covers/current');fs.mkdirSync(output,{recursive:true});
const width=1600,height=1000;
const texture=device.createTexture({size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
const depth=device.createTexture({size:[width,height],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT});
const stride=Math.ceil(width*4/256)*256;
const staging=device.createBuffer({size:stride*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
const variants=[
 {name:'01-photo-finish',eye:[16,6,11],target:[1,3,-3],fov:44,roll:-.10,time:3.2},
 {name:'02-low-angle',eye:[13,4.5,9],target:[2,3,-2],fov:50,roll:-.16,time:4.1},
 {name:'03-wide-sweep',eye:[14,10,15],target:[1,3,-3],fov:44,roll:.12,time:5.3},
];
// A tightly grouped final sprint. The leader is less than a body length ahead.
const positions=[[5,1.2],[.2,-.3],[-6,-12],[9,-3.5],[2,-8],[-2,-17],[6,-13],[-7,-5.8],[0,-75],[8,-14]];
// Place a handful of existing pickup meshes on the final approach for cover staging.
const trackData=new Float32Array(data.TRACK_DATA);
const ringSlots=[...new Set(data.TP.filter((_,i)=>i%3===0 && data.TE[i/3*2]===9))];
const lightSlots=Array.from(data.STAR_SLOTS).filter((_,i)=>i%4===0);
for(const [slot,x,z]of [[ringSlots[0],-8,-65],[lightSlots[0],9,-150],[lightSlots[1],-8,-13],[lightSlots[2],1,-20]]){
 const ri=Math.floor((slot*16+8)/(data.PATTERN*.4456*2))*3;
 trackData.set(point(x,0,z),ri*4);trackData.set(forward,(ri+1)*4);trackData.set(up,(ri+2)*4);
 trackData[(data.PICK_BASE+slot)*4]=1;
}
// Align the smaller boost ring to the real road frame on the final approach.
{
 const wanted=point(0,0,-48);let nearest=0,best=Infinity;
 for(let r=0;r<data.RINGS;r++){const distance=Math.hypot(...add(rec(r*3),mul(wanted,-1)));if(distance<best){best=distance;nearest=r;}}
 const t=unit(rec(nearest*3+1)),n=unit(rec(nearest*3+2)),a=cross(t,n),slot=ringSlots[0],ri=Math.floor((slot*16+8)/(data.PATTERN*.4456*2))*3;
 const bob=4.5+Math.sin(5.3*1.2+slot)*1.2;
 trackData.set(add(add(rec(nearest*3),mul(a,-8)),mul(n,3.7-bob)),ri*4);trackData.set(t,(ri+1)*4);trackData.set(n,(ri+2)*4);
}
ctx.trackData=trackData;run('bmDevice.queue.writeBuffer(coverTrack,0,trackData)');
// Stage copies of the actual course's loop sections across the distant skyline.
const runs=[];for(let i=0;i<data.RINGS;i++){if(data.TRACK_DATA[(i*3+2)*4+1]<-.15){const a=i;while(i<data.RINGS && data.TRACK_DATA[(i*3+2)*4+1]<-.15)i++;runs.push([a,i]);}}
const backdropPositions=[],backdropEdges=[],backdropIndices=[];
for(let k=0;k<5;k++){
 const [a,b]=runs[k%runs.length],span=b-a,lo=Math.max(0,a-span),hi=Math.min(data.RINGS,b+span);
 const points=[];for(let i=lo*2;i<=(hi*2+1);i++)points.push(Array.from(data.TP.slice(i*3,i*3+3)));
 const centre=points.reduce((s,p)=>add(s,p),[0,0,0]).map(x=>x/points.length);
 const delta=add(rec(hi*3),mul(rec(lo*3),-1));delta[1]=0;const horizontal=unit(delta),across=cross(horizontal,[0,1,0]);
 const scale=.13,anchor=point(-32+k*16,13+(k%2)*7,-65-(k%2)*15),base=backdropPositions.length/3;
 for(let j=0;j<points.length;j++){
  const rel=add(points[j],mul(centre,-1));const pos=add(add(add(anchor,mul(side,dot(rel,horizontal)*scale)),mul(up,rel[1]*scale)),mul(forward,dot(rel,across)*scale));
  backdropPositions.push(...pos);backdropEdges.push(...data.TE.slice((lo*2+j)*2,(lo*2+j)*2+2));
 }
 // Pickups follow the centre of each staged loop, using the same transformed mesh.
 for(let n=0;n<6;n++){
  const slot=lightSlots[3+k*6+n],j=Math.min(points.length-2,Math.floor((n+.5)/6*(points.length/2))*2);
  const a0=backdropPositions.slice((base+j)*3,(base+j)*3+3),b0=backdropPositions.slice((base+j+1)*3,(base+j+1)*3+3);
  const hub=mul(add(a0,b0),.5),bob=2.7+Math.sin(5.3*1.2+slot)*.9;
  const ri=Math.floor((slot*16+8)/(data.PATTERN*.4456*2))*3;
  trackData.set(add(hub,mul(up,.35-bob)),ri*4);trackData.set(forward,(ri+1)*4);trackData.set(up,(ri+2)*4);trackData[(data.PICK_BASE+slot)*4]=1;
 }
 for(let j=0;j<points.length-2;j+=2)backdropIndices.push(base+j,base+j+1,base+j+2,base+j+1,base+j+3,base+j+2);
}
ctx.trackData=trackData;run('bmDevice.queue.writeBuffer(coverTrack,0,trackData)');
for(const slot of lightSlots.slice(0,3))trackData[(data.PICK_BASE+slot)*4+2]=1;
ctx.trackData=trackData;run('bmDevice.queue.writeBuffer(coverTrack,0,trackData)');
ctx.backdropPositions=backdropPositions;ctx.backdropEdges=backdropEdges;ctx.backdropIndices=backdropIndices;
run(`const backdrop=coverProgram(Track);bmAttr(backdrop,0,new Float32Array(backdropPositions));bmAttr(backdrop,1,new Float32Array(backdropEdges));bmIndex(backdrop,new Uint16Array(backdropIndices));bmStorages(backdrop,coverState,coverTrack);`);
for(const v of variants.filter(v=>v.name==='03-wide-sweep')){
 const eye=point(-v.eye[0],v.eye[1],v.eye[2]),target=point(-v.target[0],v.target[1],v.target[2]),viewDirection=unit(add(target,mul(eye,-1)));
 const camUp=unit(add(mul(up,Math.cos(v.roll)),mul(cross(viewDirection,up),Math.sin(v.roll))));
 ctx.eye=eye;ctx.target=target;ctx.camUp=camUp;ctx.fov=v.fov;
 const matrix=run('bmMul(bmPersp(fov*Math.PI/180,1.6,.1,5000),bmLook(eye,target,camUp))');
 const cameraRight=[matrix[0],matrix[4],matrix[8]],cameraUp=[matrix[1],matrix[5],matrix[9]],gaze=[matrix[3],matrix[7],matrix[11]];
 const moonRight=add(cameraRight,mul(gaze,-.25));
 const moonDir=unit(add(add(gaze,mul(moonRight,-.83/dot(moonRight,moonRight))),mul(cameraUp,.72/dot(cameraUp,cameraUp))));
 const shadowDir=unit(add(add(moonDir,mul(unit(cameraRight),.017)),mul(unit(cameraUp),.011)));
 ctx.moonDir=moonDir;ctx.shadowDir=shadowDir;
 run(`const moonShader=[...Sky];moonShader[0]=Sky[0].replace('vec3f(0.3444, 0.1241, 0.9306)','vec3f('+moonDir.join(',')+')').replace('vec3f(0.3292, 0.1358, 0.9344)','vec3f('+shadowDir.join(',')+')');sky=coverProgram(moonShader,{zwrite:0});bmAttr(sky,0,new Float32Array([-1,-1,3,-1,-1,3]));bmIndex(sky,new Uint16Array([0,1,2]));bmStorages(sky,coverState);`);
 // Shift the camera framing 100 pixels left without moving the title.
 for(let col=0;col<4;col++)matrix[col*4]-=.25*matrix[col*4+3];
 // Place the distant racer below the H, in the title's inter-word gap.
 let bestPlacement=null;
 for(let r=0;r<data.RINGS;r++){
  const centre=rec(r*3),normal=unit(rec(r*3+2)),tangent=unit(rec(r*3+1)),lateral=cross(tangent,normal);
  const fromOrigin=add(centre,mul(origin,-1));if(Math.hypot(...fromOrigin)>115 || dot(fromOrigin,forward)>-12)continue;
  for(let lane=-10;lane<=10;lane+=.5){
   const foot=add(centre,mul(lateral,lane)),head=add(foot,mul(normal,3.4)),h=[...head,1];
   const clip=Array.from({length:4},(_,row)=>h.reduce((sum,v,k)=>sum+matrix[k*4+row]*v,0));if(clip[3]<=0)continue;
   const sx=(clip[0]/clip[3]+1)*400,sy=(1-clip[1]/clip[3])*250,score=(sx-416)**2+(sy-158)**2;
   if(!bestPlacement || score<bestPlacement.score){const local=add(foot,mul(origin,-1));bestPlacement={score,x:-dot(local,side),z:dot(local,forward),sx,sy};}
  }
 }
 if(!bestPlacement)throw Error('No distant track position fits title gap');
 positions[7]=[1.3086259522258685,-16.04190679658235];positions[8]=[-7,-5.8];console.log('Koda placement',bestPlacement);
 const state=new Float32Array(748);state.set(matrix,16);state.set(eye,32);state.set(target,36);state.set(camUp,40);
 for(let i=0;i<data.FIELD;i++){
  const [x,z]=positions[i];const pos=point(-x,0,z);const base=(16+i*7)*4;
  let racerUp=up,racerForward=forward,trackAlong=0;
  {
   const hits=[];
   for(let r=0;r<data.RINGS;r++)for(const ids of [[r*2,r*2+1,r*2+2],[r*2+1,r*2+3,r*2+2]]){
    const ps=ids.map(n=>Array.from(data.TP.slice(n*3,n*3+3))),q=ps.map(p=>{const d=add(p,mul(origin,-1));return [dot(d,side),dot(d,forward)];});
    const [a,b,c]=q,den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);if(Math.abs(den)<1e-8)continue;
    const u=((b[1]-c[1])*(-x-c[0])+(c[0]-b[0])*(z-c[1]))/den,w=((c[1]-a[1])*(-x-c[0])+(a[0]-c[0])*(z-c[1]))/den;
    if(u>=0 && w>=0 && u+w<=1){const p=add(add(mul(ps[0],u),mul(ps[1],w)),mul(ps[2],1-u-w));let n=unit(cross(add(ps[1],mul(ps[0],-1)),add(ps[2],mul(ps[0],-1))));if(dot(n,up)<0)n=mul(n,-1);hits.push({p,n,along:ids.reduce((sum,id,k)=>sum+data.TE[id*2+1]*[u,w,1-u-w][k],0),height:dot(add(p,mul(pos,-1)),up)});}
   }
   hits.sort((a,b)=>Math.abs(a.height)-Math.abs(b.height));if(!hits.length)throw Error('Racer has no road under him');
   const h=hits[0];trackAlong=h.along;console.log(data.UNICORNS[i].name+' road height correction:',h.height.toFixed(3));pos.splice(0,3,...h.p);racerUp=h.n;racerForward=unit(add(forward,mul(h.n,-dot(forward,h.n))));
  }
  // Keep even the lowest corner of an animated hoof above the road plane.
  const phase=i===0?Math.PI/2:v.time*6+i*1.3;let lowest=Infinity;
  for(let j=0;j<data.P.length/3;j++){
   const root=data.RT.slice(j*3,j*3+3),gallop=(root[0]>=0?0:Math.PI)+Math.sign(root[2])*.2;
   const angle=data.SK[j*4+2]*1.45*Math.sin(phase+gallop)*data.SK[j*4];
   const y=data.P[j*3]*Math.sin(angle)+data.P[j*3+1]*Math.cos(angle)+root[1]+Math.sin(phase)*.07;
   lowest=Math.min(lowest,y);
  }
  const lift=Math.max(0,-lowest*1.6*(data.UNICORNS[i].size||1))+.08;
  pos.splice(0,3,...add(pos,mul(racerUp,lift)));
  state.set([...pos,0],base);state.set([...racerForward,120],base+4);state.set([...racerUp,i===0?Math.PI/2:v.time*6+i*1.3],base+8);
  state[base+15]=trackAlong;
  state[base+20]=i===0?2.45:0;
  ctx.racer=data.UNICORNS[i];state.set(run('livery(racer)'),(86+i*6)*4);
 }
 const stars=[];
 for(let i=0;i<data.STAR_SLOTS.length;i+=4){const slot=data.STAR_SLOTS[i],ri=Math.floor((slot*16+8)/(data.PATTERN*.4456*2))*3;const hub=Array.from(trackData.slice(ri*4,ri*4+3));stars.push({slot,depth:dot(add(hub,mul(eye,-1)),viewDirection)});}
 stars.sort((a,b)=>b.depth-a.depth).forEach((s,i)=>state[(146+i)*4]=s.slot);
 state[22*4+2]=6.35;
 ctx.state=state;ctx.time=v.time;
 run('bmDevice.queue.writeBuffer(coverState,0,state);const ru=new Float32Array(Unicorn[3]/4);ru.set([time,1,1.6,0]);bmUniforms(racers,ru);bmUniforms(road,new Float32Array([time,1/(PATTERN*.4456*2),PICK_BASE]));bmUniforms(backdrop,new Float32Array([time,1/(PATTERN*.4456*2),PICK_BASE]));bmUniforms(sky,new Float32Array([time,0,0]));bmUniforms(warp,new Float32Array([time,1,0]));');
 const enc=device.createCommandEncoder();ctx.pass=enc.beginRenderPass({colorAttachments:[{view:texture.createView(),clearValue:{r:0,g:0,b:0,a:1},loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:depth.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}});
 run('bmPass=pass;bmDraw(sky);bmDraw(backdrop);bmDraw(road);bmDraw(warp);bmDraw(racers,FIELD);');ctx.pass.end();
 enc.copyTextureToBuffer({texture},{buffer:staging,bytesPerRow:stride},[width,height]);device.queue.submit([enc.finish()]);await staging.mapAsync(GPUMapMode.READ);
 const raw=new Uint8ClampedArray(width*height*4),mapped=new Uint8Array(staging.getMappedRange());for(let y=0;y<height;y++)raw.set(mapped.subarray(y*stride,y*stride+width*4),y*width*4);staging.unmap();for(let i=3;i<raw.length;i+=4)raw[i]=255;
 const large=createCanvas(width,height);large.getContext('2d').putImageData(new ImageData(raw,width,height),0,0);
 const canvas=createCanvas(800,500),c=canvas.getContext('2d');c.drawImage(large,0,0,800,500);
 fs.writeFileSync(path.join(output,v.name+'-scene.png'),canvas.toBuffer('image/png'));
 console.log(v.name);
}
fs.writeFileSync(path.join(output,'staging.json'),JSON.stringify({width:800,height:500,variants,positions},null,2));
await device.queue.onSubmittedWorkDone();
run(`for(const p of [racers,road,sky,warp]){for(const b of p.b)b.destroy();p.ix.destroy();p.ub?.destroy();}coverState.destroy();coverTrack.destroy();bmDevice=null;bmPass=null;`);
texture.destroy();depth.destroy();staging.destroy();ctx=null;
if(global.gc)global.gc();
await new Promise(resolve=>setTimeout(resolve,100));
device.destroy();
