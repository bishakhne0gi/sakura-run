import fs from 'node:fs';
import {makeCamera} from './project.mjs';
const poses=JSON.parse(fs.readFileSync('data/mapillary-poses.json','utf8'));
const fac=JSON.parse(fs.readFileSync('data/mapillary-facades.json','utf8'));
const origin=fac.origin;
const byId=new Map(poses.poses.map(p=>[p.id,p]));

// Sanity 1: does the camera's stated bearing agree with the pose matrix?
// Project a point 20 m along the reported compass bearing; it must land near
// the horizontal centre of a perspective frame.
let bearingOk=0, bearingTested=0, bearingErr=[];
for(const p of poses.poses.slice(0,400)){
  if(p.pano||p.bearing==null) continue;
  const cam=makeCamera(p,origin); if(!cam) continue;
  const r=p.bearing*Math.PI/180;
  const [cx,cy,cz]=cam.origin;
  const tx=cx+Math.sin(r)*20, tz=cz-Math.cos(r)*20;
  const q=cam.project(tx,cy,tz);
  bearingTested++;
  if(q){ bearingErr.push(Math.abs(q.u-0.5)); if(Math.abs(q.u-0.5)<0.12) bearingOk++; }
}
bearingErr.sort((a,b)=>a-b);
console.log('bearing check (perspective): '+bearingOk+'/'+bearingTested+' project near frame centre');
console.log('  |u-0.5| median '+(bearingErr[bearingErr.length>>1]||0).toFixed(3)+'  p90 '+(bearingErr[Math.floor(bearingErr.length*0.9)]||0).toFixed(3));

// Sanity 2: do matched wall quads land inside the frame?
let tested=0, allIn=0, partIn=0, none=0, behind=0;
const heightFrac=[];
for(const m of fac.matches){
  const p=byId.get(m.image); if(!p) continue;
  const cam=makeCamera(p,origin); if(!cam) continue;
  tested++;
  const [ax,az,bx,bz]=m.wall;
  const h=Math.min(m.height??9, 14);
  const corners=[[ax,0,az],[bx,0,bz],[bx,h,bz],[ax,h,az]].map(([x,y,z])=>cam.project(x,y,z));
  if(corners.some(c=>!c)){behind++;continue}
  const inside=corners.filter(c=>c.u>=-0.02&&c.u<=1.02&&c.v>=-0.02&&c.v<=1.02).length;
  if(inside===4) allIn++; else if(inside>0) partIn++; else none++;
  if(inside===4){
    const vs=corners.map(c=>c.v);
    heightFrac.push(Math.max(...vs)-Math.min(...vs));
  }
}
console.log('\nwall quads: tested '+tested);
console.log('  fully in frame   '+allIn+'  ('+(allIn/tested*100).toFixed(1)+'%)');
console.log('  partly in frame  '+partIn+'  ('+(partIn/tested*100).toFixed(1)+'%)');
console.log('  outside frame    '+none+'  ('+(none/tested*100).toFixed(1)+'%)');
console.log('  behind camera    '+behind);
heightFrac.sort((a,b)=>a-b);
console.log('  facade height as fraction of frame: median '+(heightFrac[heightFrac.length>>1]||0).toFixed(3)+'  p10 '+(heightFrac[Math.floor(heightFrac.length*0.1)]||0).toFixed(3));
