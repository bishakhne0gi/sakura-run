// Stage: pull the finished Mapflow "Buildings" result and keep the heights.
//
//   node pipeline/fetch-mapflow.mjs
//
// The free tier reports allowDownload:false, so there is no GeoJSON export. The
// result is served as vector tiles though — the same thing the web viewer reads
// — and those decode with the pbf reader this project already uses for the
// Mapillary coverage tiles.
import fs from 'node:fs';
import path from 'node:path';
import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

const ROOT = path.resolve(import.meta.dirname, '..');
fs.readFileSync(path.join(ROOT,'.env'),'utf8').split(/\r?\n/).forEach(l=>{const i=l.indexOf('=');if(i>0)process.env[l.slice(0,i).trim()]=l.slice(i+1).trim().replace(/^["']|["']$/g,'')});
const T=process.env.MAPFLOW_API;

const proc=JSON.parse(fs.readFileSync(path.join(ROOT,'data','mapflow-processing.json'),'utf8'));
const tileUrl=proc.vectorLayer?.tileUrl;
if(!tileUrl){ console.log('no tile url on processing'); process.exit(1); }
console.log('layer:', tileUrl);

const world=JSON.parse(fs.readFileSync(path.join(ROOT,'public','world.json'),'utf8'));
const O=world.origin, MPLAT=110574, mplon=111320*Math.cos(O.lat*Math.PI/180);
const [minX,minZ,maxX,maxZ]=world.bounds;
const toLon=x=>O.lon+x/mplon, toLat=z=>O.lat-z/MPLAT;
const lon2t=(lon,z)=>Math.floor((lon+180)/360*2**z);
const lat2t=(lat,z)=>{const r=lat*Math.PI/180;return Math.floor((1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*2**z)};

const Z=16;
const x0=lon2t(toLon(minX),Z), x1=lon2t(toLon(maxX),Z);
const y0=lat2t(toLat(minZ),Z), y1=lat2t(toLat(maxZ),Z);
console.log(`tiles z${Z}: x ${x0}..${x1} y ${y0}..${y1}`);

const feats=[];
const props=new Set();
let ok=0, empty=0, failed=0;
for(let x=x0;x<=x1;x++) for(let y=y0;y<=y1;y++){
  const url=tileUrl.replace('{z}',Z).replace('{x}',x).replace('{y}',y);
  try{
    const r=await fetch(url,{headers:{Authorization:'Basic '+T}});
    if(r.status!==200){ failed++; continue; }
    const buf=Buffer.from(await r.arrayBuffer());
    if(!buf.length){ empty++; continue; }
    const tile=new VectorTile(new PbfReader(buf));
    for(const name of Object.keys(tile.layers)){
      const L=tile.layers[name];
      for(let i=0;i<L.length;i++){
        const f=L.feature(i);
        Object.keys(f.properties).forEach(k=>props.add(k));
        const g=f.toGeoJSON(x,y,Z);
        feats.push({ p:f.properties, geometry:g.geometry });
      }
    }
    ok++;
  }catch(e){ failed++; }
}
console.log(`tiles ok ${ok}, empty ${empty}, failed ${failed}`);
console.log('features:', feats.length);
console.log('property keys:', [...props].join(', '));
const withH = feats.filter(f=>f.p.height!=null||f.p.Height!=null||f.p.building_height!=null);
console.log('features carrying a height:', withH.length);
if(feats.length) console.log('sample props:', JSON.stringify(feats[0].p).slice(0,300));
fs.writeFileSync(path.join(ROOT,'data','mapflow-buildings.json'), JSON.stringify({count:feats.length, features:feats}));
console.log('wrote data/mapflow-buildings.json');
