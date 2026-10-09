import fs from 'node:fs';
fs.readFileSync('.env','utf8').split(/\n/).forEach(l=>{const i=l.indexOf('=');if(i>0)process.env[l.slice(0,i).trim()]=l.slice(i+1).trim().replace(/^["']|["']$/g,'')});
const T=process.env.MAPFLOW_API;
const H={Authorization:'Basic '+T,Accept:'application/json'};
const id=JSON.parse(fs.readFileSync('data/mapflow-processing.json','utf8')).id;
for(let i=0;i<180;i++){
  const r=await fetch('https://api.mapflow.ai/rest/processings',{headers:H});
  const list=await r.json();
  const p=list.find(x=>x.id===id);
  if(!p){ console.log('gone'); break; }
  const st=p.status||p.percentCompleted||JSON.stringify(p).match(/"status":"([^"]+)"/)?.[1];
  console.log(new Date().toISOString().slice(11,19), 'status:', st, 'pct:', p.percentCompleted ?? '');
  if(String(st).match(/OK|FAILED|COMPLETED/i)){ fs.writeFileSync('data/mapflow-processing.json', JSON.stringify(p)); console.log('FINAL', st); break; }
  await new Promise(r2=>setTimeout(r2,20000));
}
