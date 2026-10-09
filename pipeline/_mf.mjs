import fs from 'node:fs';
fs.readFileSync('.env','utf8').split(/\n/).forEach(l=>{const i=l.indexOf('=');if(i>0)process.env[l.slice(0,i).trim()]=l.slice(i+1).trim().replace(/^["']|["']$/g,'')});
const T=process.env.MAPFLOW_API;
const H={Authorization:'Basic '+T,Accept:'application/json'};
const r=await fetch('https://api.mapflow.ai/rest/processings',{headers:H});
const list=await r.json();
console.log('processings:', list.length);
for(const p of list.slice(0,3)){
  console.log(JSON.stringify(p).slice(0,700));
}
