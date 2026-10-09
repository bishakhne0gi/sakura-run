// Kicks off a Mapflow "Buildings" run over HSR and reports the processing id.
//
//   node pipeline/mapflow-buildings.mjs
//
// The model's block chain is Segmentation > Postprocessing > OSM > Classification
// > Heights > Postprocessing, and it is the Heights block that matters here:
// only 114 of this world's 9,763 buildings have a surveyed height, so every
// other one is currently inferred from storey guesses. Costs 10 credits/km^2.
import fs from 'node:fs';
fs.readFileSync('.env','utf8').split(/\n/).forEach(l=>{const i=l.indexOf('=');if(i>0)process.env[l.slice(0,i).trim()]=l.slice(i+1).trim().replace(/^["']|["']$/g,'')});
const T=process.env.MAPFLOW_API;
const B='https://api.mapflow.ai/rest';
const H={Authorization:'Basic '+T,'Content-Type':'application/json',Accept:'application/json'};

const world=JSON.parse(fs.readFileSync('public/world.json','utf8'));
const O=world.origin, MPLAT=110574, mplon=111320*Math.cos(O.lat*Math.PI/180);
const [minX,minZ,maxX,maxZ]=world.bounds;
const lon=x=>O.lon+x/mplon, lat=z=>O.lat-z/MPLAT;
const ring=[[lon(minX),lat(maxZ)],[lon(maxX),lat(maxZ)],[lon(maxX),lat(minZ)],[lon(minX),lat(minZ)],[lon(minX),lat(maxZ)]];
const areaKm2=((maxX-minX)/1000)*((maxZ-minZ)/1000);

const projects=await (await fetch(B+'/projects',{headers:H})).json();
const proj=projects.find(p=>p.isDefault)||projects[0];
const wd=proj.workflowDefs.find(w=>/^🏠 Buildings$/.test(w.name)||/^Buildings$/i.test(w.name));
console.log('workflow:', wd.name, wd.id, 'price/km2', wd.pricePerSqKm);
console.log('area km2:', areaKm2.toFixed(2), '=> approx credits:', Math.ceil(areaKm2*wd.pricePerSqKm));

const r=await fetch(B+'/processings',{method:'POST',headers:H,body:JSON.stringify({
  name:'HSR buildings + heights',
  projectId:proj.id,
  wdId:wd.id,
  geometry:{type:'Polygon',coordinates:[ring]},
  params:{},
})});
const t=await r.text();
console.log('HTTP',r.status);
let j; try{ j=JSON.parse(t) }catch{ console.log(t.slice(0,400)); process.exit(1) }
if(j.error||r.status>=400){ console.log(t.slice(0,500)); process.exit(1) }
fs.writeFileSync('data/mapflow-processing.json', JSON.stringify(j));
console.log('processing id:', j.id);
console.log('vector tiles:', j.vectorLayer?.tileUrl);
