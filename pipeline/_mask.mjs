import fs from 'node:fs';
import sharp from 'sharp';
const det=JSON.parse(fs.readFileSync('data/mapillary-detections.json','utf8'));
const fac=JSON.parse(fs.readFileSync('data/mapillary-facades.json','utf8'));
const SIZE=512;
const ROLE={ground:1,building:2,sign:3,occluder:4};
const COLOR={0:[40,40,40],1:[70,70,150],2:[60,200,80],3:[240,220,60],4:[220,60,60]};
function fill(mask,ring,v){
  const pts=ring.map(([u,x])=>[u*SIZE,x*SIZE]);
  let mn=1e9,mx=-1e9; for(const [,y] of pts){mn=Math.min(mn,y);mx=Math.max(mx,y)}
  for(let y=Math.max(0,Math.floor(mn));y<=Math.min(SIZE-1,Math.ceil(mx));y++){
    const cy=y+0.5,xs=[];
    for(let i=0;i<pts.length;i++){const [xa,ya]=pts[i],[xb,yb]=pts[(i+1)%pts.length];
      if((ya<=cy&&yb>cy)||(yb<=cy&&ya>cy)) xs.push(xa+((cy-ya)/(yb-ya))*(xb-xa));}
    xs.sort((a,b)=>a-b);
    for(let k=0;k+1<xs.length;k+=2)
      for(let x=Math.max(0,Math.ceil(xs[k]-0.5));x<=Math.min(SIZE-1,Math.floor(xs[k+1]-0.5));x++) mask[y*SIZE+x]=v;
  }
}
// pick a photo that fronts several buildings and has detections
const cand=fac.images.filter(i=>(det.byImage[i.image]||[]).length>50).slice(0,1)[0];
const list=det.byImage[cand.image];
console.log('photo',cand.image,'detections',list.length);
const counts={}; list.forEach(d=>counts[d.role]=(counts[d.role]||0)+1); console.log(counts);
const mask=new Uint8Array(SIZE*SIZE);
for(const role of ['ground','building','sign','occluder']) for(const d of list) if(d.role===role) fill(mask,d.ring,ROLE[role]);
const cov={}; for(const v of mask) cov[v]=(cov[v]||0)+1;
console.log('mask coverage %:',Object.entries(cov).map(([k,v])=>k+':'+(v/mask.length*100).toFixed(1)).join(' '));
const rgb=Buffer.alloc(SIZE*SIZE*3);
for(let i=0;i<mask.length;i++){const c=COLOR[mask[i]];rgb[i*3]=c[0];rgb[i*3+1]=c[1];rgb[i*3+2]=c[2];}
const S='/private/tmp/claude-501/-Users-bishashcosx-Documents-Codes-cosx-Skills/00928c18-013a-418f-82dd-e89daa6dfbca/scratchpad/';
await sharp(rgb,{raw:{width:SIZE,height:SIZE,channels:3}}).png().toFile(S+'mask.png');
await sharp('data/mly/jpg/'+cand.image+'.jpg').resize(SIZE,SIZE,{fit:'fill'}).png().toFile(S+'photo.png');
// side by side
await sharp({create:{width:SIZE*2,height:SIZE,channels:3,background:'#000'}})
  .composite([{input:S+'photo.png',left:0,top:0},{input:S+'mask.png',left:SIZE,top:0}])
  .png().toFile(S+'mask-check.png');
console.log('wrote mask-check.png  (left: photo, right: mask; green=building red=occluder blue=ground yellow=sign)');
