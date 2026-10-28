import {start,setup,seed,sleep,until,frame,snapshots,first,last,now,dir,base,assert} from './common.mjs';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
const run=await start();const out={package:'dev-c16a553',head:'c16a55383c4bc6a219c270aa4f7cf9b55c97e45a',workflow:'40505148793',environment:{collector:'downloaded static EL9 binary on host (Docker socket denied)',browser:await run.browser.version(),viewport:[1440,1000],timezone:'UTC',clock:{browser:'real wall clock; no overrides',now,first,last}},scenarios:[]};
let h,caseId;
async function check(name,fn){if(process.env.ONLY&&!name.includes(process.env.ONLY))return;console.log('START '+name);const item={caseId,name,start:new Date().toISOString()};try{seed();h=await setup(run.browser);await h.goto();await until(async()=>(await h.text('history-status')).startsWith('Checked'),'scan');item.observations=await fn(h);item.status='PASSED';}catch(e){item.status='ERROR';item.error=e.stack;console.log(e.stack);if(e.name==='AssertionError')item.status='NEEDS_REVIEW';item.visible=await h.facts().catch(()=>({}));}finally{item.end=new Date().toISOString();if(h){item.requestLog=h.state.log;item.cancelled=h.state.cancelled;item.browserErrors=h.state.errors;await h.context.close();}out.scenarios.push(item);writeFileSync(dir+'/observations-'+(process.env.ONLY||'memory-final')+'.json',JSON.stringify(out,null,2));console.log(item.status+' '+name);}}
const selected=h=>h.page.evaluate(()=>({at:document.querySelector('#timeline-range').value,name:document.querySelector('#target-name').textContent,cpu:document.querySelector('#hero-cpu').textContent,findings:document.querySelector('#findings').textContent,note:document.querySelector('#replay-note').textContent,help:document.querySelector('.help-card')?.textContent,focus:document.activeElement?.id}));
const openDetails=async(h,sel)=>{if(!await h.page.locator(sel).getAttribute('open').then(x=>x!==null))await h.click(sel+' > summary');};
caseId='QA-081';
await check('recorded-PID-range-counts-future-cutoff',async h=>{
 const observations=[];
 for(const boundary of [false,true]){
 const inputs=seed(boundary?'boundary':'growth');inputs.snapshots[0].resources.network={tcp_retrans_segs:{total:1000,delta:0,per_s:0}};
 for(const row of inputs.resources)row.tcp_retrans_segs_delta=row.pid===7?1:100000;
 writeFileSync(dir+'/pid-range-'+boundary+'-seed.json',JSON.stringify(inputs));
 const {execFileSync}=await import('node:child_process');execFileSync('python3',[dir+'/seed.py',dir+'/fixture/data',dir+'/pid-range-'+boundary+'-seed.json']);
 await h.page.goto(base+'/?target=');await h.mode('Live');await until(async()=>(await h.text('history-status')).startsWith('Checked 1 recording'),'PID scan');await openDetails(h,'details[data-fold="past"]');await h.page.locator('#history-type').selectOption({label:'Memory'});const rows=await h.page.locator('#history-list .t').allTextContents();assert.deepEqual(rows,boundary?[]:['Resident memory grows without a plateau']);assert.equal(await h.page.locator('#timeline-marks').evaluate(e=>e.children.length),boundary?0:1);
 await h.click('#replay-previous');await h.mode('Historical');await until(async()=>await h.page.locator('#resource-tiles .tile polyline').count()>0,'resource polylines');
 const pointCounts=await h.page.locator('#resource-tiles .tile').evaluateAll(es=>es.map(e=>({label:e.querySelector('.label')?.textContent,points:e.querySelector('polyline')?.getAttribute('points')?.trim().split(/\s+/).length})));for(const label of ['Memory (RSS)','Open files','TCP retransmits'])assert.equal(pointCounts.find(e=>e.label===label).points,48);
 const netRow=h.page.locator('#resources tr').filter({hasText:'Retransmitted segments'});const values=await netRow.locator('td').allTextContents();assert.deepEqual(values.slice(-3),['0.00/s','48','1000']);assert.equal((await h.text('findings')).includes('Resident memory grows without a plateau'),!boundary);
 const response=await(await fetch(base+`/api/resources?start=${last-300}&end=${last}`)).json();assert.equal(response.rows.some(r=>r.ts>last),false);assert.equal(response.rows.filter(r=>r.pid===7).length,48);assert.equal(response.rows.filter(r=>r.pid===8).length,boundary?1:0);
 observations.push({boundary,inputs,pointCounts,rangeCounter:values,resourceRows:response.rows,assessment:await h.text('findings'),queryCutoffs:h.state.log.filter(x=>x.path==='/api/resources').map(x=>x.query)});
 }
 return observations;
});
await check('memory-growth-row-persists-load-earlier',async h=>{
 const {execFileSync}=await import('node:child_process');const inputs=seed('growth'),oldAt=last-3600;const old=structuredClone(inputs.snapshots[0]);old.recorded_at=oldAt;old.health.last_seen=oldAt;old.resources.updated=oldAt;old.memory.updated=oldAt;old.threads[0].last_sample=oldAt;inputs.snapshots.unshift(old);for(const row of [...inputs.resources].filter(r=>r.pid===7))inputs.resources.push({...row,ts:row.ts-3600});writeFileSync(dir+'/earlier-period-seed.json',JSON.stringify(inputs));execFileSync('python3',[dir+'/seed.py',dir+'/fixture/data',dir+'/earlier-period-seed.json']);
 await h.page.goto(base+'/?target=');await h.mode('Live');await until(async()=>(await h.text('history-status')).startsWith('Checked'),'first memory period',30000);await openDetails(h,'details[data-fold="past"]');await h.page.locator('#history-type').selectOption({label:'Memory'});assert.deepEqual(await h.page.locator('#history-list .t').allTextContents(),['Resident memory grows without a plateau']);const periods=[{status:await h.text('history-status'),rows:await h.page.locator('#history-list > li').allTextContents()}];
 while(await h.page.locator('#history-more').isVisible()){
 const before=await h.text('history-status');await h.click('#history-more');await until(async()=>(await h.text('history-status'))!==before&&(await h.text('history-status')).startsWith('Checked'),'earlier memory period',60000);const rows=await h.page.locator('#history-list .t').allTextContents();assert.ok(rows.includes('Resident memory grows without a plateau'));periods.push({status:await h.text('history-status'),rows:await h.page.locator('#history-list > li').allTextContents()});
 }
 assert.equal(await h.page.locator('#history-list > li').count(),2);assert.equal(await h.page.locator('#timeline-marks').evaluate(e=>e.children.length),2);
 const selections=[];for(let i=0;i<2;i++){await h.page.locator('#history-list > li').nth(i).click();await h.mode('Historical');const at=Number(await h.page.locator('#timeline-range').inputValue());assert.ok(at===last||at===oldAt);assert.match(await h.text('findings'),/Resident memory grows without a plateau/);selections.push({at,row:await h.page.locator('#history-list > li[aria-current=true]').innerText(),assessment:await h.text('findings')});}
 return {inputs,periods,selections};
});
await run.stop();writeFileSync(dir+'/observations-'+(process.env.ONLY||'memory-final')+'.json',JSON.stringify(out,null,2));console.log(out.scenarios.map(s=>s.status+' '+s.name).join('\n'));
