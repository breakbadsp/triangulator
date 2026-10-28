import {start,setup,seed,sleep,until,frame,snapshots,first,last,now,dir,base,assert} from './common.mjs';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
const run=await start();const out={package:'dev-c16a553',head:'c16a55383c4bc6a219c270aa4f7cf9b55c97e45a',workflow:'40505148793',environment:{collector:'downloaded static EL9 binary on host (Docker socket denied)',browser:await run.browser.version(),viewport:[1440,1000],timezone:'UTC',clock:{browser:'real wall clock; no overrides',now,first,last}},scenarios:[]};
let h,caseId;
async function check(name,fn){if(process.env.ONLY&&!name.includes(process.env.ONLY))return;console.log('START '+name);const item={caseId,name,start:new Date().toISOString()};try{seed();h=await setup(run.browser);await h.goto();await until(async()=>(await h.text('history-status')).startsWith('Checked'),'scan');item.observations=await fn(h);item.status='PASSED';}catch(e){item.status='ERROR';item.error=e.stack;console.log(e.stack);if(e.name==='AssertionError')item.status='NEEDS_REVIEW';item.visible=await h.facts().catch(()=>({}));}finally{item.end=new Date().toISOString();if(h){item.requestLog=h.state.log;item.cancelled=h.state.cancelled;item.browserErrors=h.state.errors;await h.context.close();}out.scenarios.push(item);writeFileSync(dir+'/observations-'+(process.env.ONLY||'all')+'.json',JSON.stringify(out,null,2));console.log(item.status+' '+name);}}
const selected=h=>h.page.evaluate(()=>({at:document.querySelector('#timeline-range').value,name:document.querySelector('#target-name').textContent,cpu:document.querySelector('#hero-cpu').textContent,findings:document.querySelector('#findings').textContent,note:document.querySelector('#replay-note').textContent,help:document.querySelector('.help-card')?.textContent,focus:document.activeElement?.id}));
const openDetails=async(h,sel)=>{if(!await h.page.locator(sel).getAttribute('open').then(x=>x!==null))await h.click(sel+' > summary');};
caseId='QA-122';
await check('replay-errors-late-selection',async h=>{
 const {page,state,hold,release,click,mode,text}=h;await click('#replay-previous');await mode('Historical');assert.equal(await text('target-name'),'worker-100');assert.equal(await text('hero-cpu'),'0.25 cores');
 const initial=await selected(h);const notes=[];
 for(const reply of [{body:{first,last,snapshot:null},note:'No more'},{body:{first,last,snapshot:{health:{},threads:[]}},note:'Invalid recorded'},{body:{error:'qa read failed'},status:500,note:'qa read failed'}]){state.overrides.set('/api/replay',reply);await click('#replay-previous');await until(async()=>(await text('replay-note')).includes(reply.note),reply.note);assert.equal(await text('target-name'),'worker-100');assert.equal(await text('hero-cpu'),initial.cpu);notes.push(await text('replay-note'));}state.overrides.delete('/api/replay');
 // An in-flight success and error each arrive after a real return-to-Live click.
 for(const status of [200,500]){await click('#replay-live');await mode('Live');const a=hold('/api/replay',x=>x.query.direction!=='at');await click('#replay-previous');await until(()=>a.length>0,'snapshot pending');await click('#replay-live');await mode('Live');await release('/api/replay',status===200?{first,last,snapshot:snapshots[0]}:{error:'late error'},status);await sleep(350);assert.equal(await text('target-name'),'worker-200');assert.match(await text('replay-note'),/Live view/);}
 // Newer selection wins over a delayed older success, then an error.
 for(const status of [200,500]){await click('#replay-previous');await mode('Historical');const a=hold('/api/replay',x=>x.query.direction!=='at');await click('#replay-previous');await until(()=>a.length>0,'older pending');state.holds.delete('/api/replay');await page.locator('#timeline-range').press('End');await mode('Live');await click('#replay-previous');await mode('Historical');const before=await selected(h);for(const i of a)await state.fulfill(i.route,status===200?{first,last,snapshot:{...snapshots[0],threads:[{...snapshots[0].threads[0],name:'STALE'}]}}:{error:'stale recording error'},status);await sleep(300);assert.deepEqual(await selected(h),before);await click('#replay-live');await mode('Live');}
 return {initial,notes,final:await selected(h)};
});
await check('resources-layout-history-watch-late',async h=>{
 const {page,state,hold,release,click,mode,text}=h;
 const rr=hold('/api/resources',x=>Number(x.query.end)>last),mm=hold('/api/memory-map'),hh=hold('/api/history');
 state.current=frame(now+2);state.current.memory.layout_id='200:2';
 await click('#threads tr[data-tid]');await until(()=>rr.length&&mm.length&&hh.length,'live reads pending',20000);
 state.overrides.set('/api/replay',{body:{first,last,snapshot:{...snapshots[1],resources:{available:false}}}});
 await click('#replay-previous');await mode('Historical');const before=await selected(h);
 await release('/api/resources',{rows:[{ts:now+100,pid:42,rss_bytes:999999999}],bucket_s:1});await release('/api/memory-map',{...state.layout,id:'200:2'});await release('/api/history',{error:'late history failed'},500);await sleep(500);
 assert.deepEqual(await selected(h),before);assert.equal(await page.locator('#drawer').getAttribute('aria-hidden'),'true');assert.equal(await page.locator('#socket-panel').isVisible(),false);assert.match(await text('memory-map'),/latest layout/);
 const after=state.log.length;await sleep(2200);assert.equal(state.log.slice(after).some(x=>['/api/socket-io','/api/memory-map','/api/watches'].includes(x.path)),false);
 state.overrides.delete('/api/replay');await click('#replay-live');await mode('Live');
 const get=hold('/api/watches',x=>x.method==='GET');await click('a[href="#collector-settings"]');await until(()=>get.length,'watch GET pending');await click('#replay-previous');await mode('Historical');const historical=await selected(h);await release('/api/watches',{error:'late watch read'},500);await sleep(400);assert.deepEqual(await selected(h),historical);
 return {before,historical,heldCounts:[rr.length,mm.length,hh.length,get.length]};
});
await check('settings-draft-revision-sent-write',async h=>{
 const {page,state,click,mode,text,hold,release}=h;const p=page.getByRole('textbox',{name:'Thread name prefix, rule 1',exact:true});
 await p.fill('changed-');await click('#replay-previous');await mode('Historical');assert.match(await text('watch-recorded-readonly'),/unsaved edits are kept/);await click('#replay-live');await mode('Live');assert.equal(await p.inputValue(),'changed-');
 const a=hold('/api/watches',x=>x.method==='POST');await click('#watch-save');await until(()=>a.length,'sent write');assert.equal(JSON.parse(a[0].body).rules[0].prefix,'changed-');await click('#replay-previous');await mode('Historical');const before=await selected(h);state.revision='r2';state.rules=[{prefix:'changed-',wake_ms:500}];await release('/api/watches',state.watch());await sleep(300);assert.deepEqual(await selected(h),before);await click('#replay-live');await mode('Live');assert.equal(await p.inputValue(),'changed-');
 // A conflict is returned by the network fixture, using the real save control.
 await p.fill('conflict-');state.overrides.set('/api/watches',{status:409,body:{...state.watch(),revision:'r3',error:'Configuration changed; reload current rules'}});await click('#watch-save');await sleep(400);const conflict=await text('watch-editor');assert.match(conflict,/changed|conflict|reload/i);assert.equal(await p.inputValue(),'conflict-');return {before,conflict,request:JSON.parse(a[0].body)};
});
await check('pointer-focus-help-recorded-history-cutoff',async h=>{
 const {page,state,click,mode,text}=h;
 await click('[data-map-window="300"]');await page.locator('#search').fill('worker');
 await click('#replay-previous');await mode('Historical');await click('#threads tr[data-tid]');await until(()=>state.log.some(x=>x.path==='/api/history'),'recorded history request');const hist=state.log.filter(x=>x.path==='/api/history').at(-1);assert.equal(hist.query.session,'100');assert.equal(Number(hist.query.end),last);
 const local=s=>new Date(s*1000).toISOString().slice(0,19);await page.locator('#from').fill(local(last-100));await page.locator('#to').fill(local(now+50));await click('#load-history');await sleep(250);assert.equal(Number(state.log.filter(x=>x.path==='/api/history').at(-1).query.end),last);await click('#drawer-close');
 await page.locator('#mosaic .cell').hover();await until(async()=>await page.locator('.help-card').count()>0,'recorded cell Help');assert.match(await page.locator('.help-card').innerText(),/Recorded at/);const help=await page.locator('.help-card').innerText();
 // Keep the physical pointer still while the observation changes by keyboard.
 await page.locator('#replay-live').press('Enter');await mode('Live');await sleep(350);const newHelp=await page.locator('.help-card').allTextContents();assert.ok(newHelp.every(s=>!s.includes('Recorded at')));await page.keyboard.press('Escape');assert.equal(await page.locator('.help-card').count(),0);
 assert.equal(await page.locator('#search').inputValue(),'worker');assert.equal(await page.locator('[data-map-window][aria-pressed=true]').getAttribute('data-map-window'),'300');
 // Hold native slider pointer until after a live poll, then release.
 await page.locator('#timeline-range').scrollIntoViewIfNeeded();const b=await page.locator('#timeline-range').boundingBox(),before=state.log.filter(x=>x.path==='/api/replay'&&x.query.at).length;await page.mouse.move(b.x+6,b.y+b.height/2);await page.mouse.down();await sleep(1250);assert.equal(state.log.filter(x=>x.path==='/api/replay'&&x.query.at).length,before);assert.match(await text('timeline-cursor'),/Release to view/);await page.mouse.up();await mode('Historical');
 const selectedView=await selected(h);const resourceQueries=state.log.filter(x=>x.path==='/api/resources'&&Number(x.query.end)<=last);assert.ok(resourceQueries.length);assert.ok(resourceQueries.every(x=>Number(x.query.end)<=last));
 return {hist,help,newHelp,selectedView,resourceQueries};
});
await check('final-settle-absence-restart-exits-reload',async h=>{
 const {page,state,click,mode,text}=h;const empty={...frame(now+3,'300',77),threads:[]};state.current=empty;const started=Date.now();await sleep(1800);assert.equal(await text('target-name'),'worker-200');await click('#replay-previous');await mode('Historical');
 state.current={health:{session:'300',pid:0,last_seen:now+3,target_absent:true,sampler_silent:false},threads:[]};await until(()=>page.locator('#exited').isVisible(),'absence during replay');assert.equal(await text('target-name'),'worker-100');
 await click('#exited-live');await mode('Historical');assert.equal(await page.locator('#exited').isVisible(),false);assert.equal(await text('target-name'),'worker-100');
 // Restore populated process, then confirm a second absence with a final view.
 state.current=frame(now+4,'400',77);await click('#replay-live');await mode('Live');await until(async()=>(await text('target-name'))==='worker-400','replacement live');state.current={health:{session:'500',pid:0,last_seen:now+5,target_absent:true,sampler_silent:false},threads:[]};await mode('Stopped reporting');assert.equal(await text('target-name'),'worker-400');const final=await selected(h);state.current=frame(now+6,'600',88);await sleep(2200);assert.equal(await text('target-name'),'worker-400');assert.match(await text('exited-text'),/new process \(PID 88\)/);
 // Neither same PID/wrong session nor same session/wrong PID can add an exit.
 for(const exit of [{pid:77,session:'wrong',name:'wrong',ended_at:now+5,reason:'segfault'},{pid:88,session:'400',name:'wrong',ended_at:now+5,reason:'segfault'}]){state.current.exit=exit;await sleep(1200);assert.equal(await page.locator('#process-exit').count(),0);}
 state.current.exit={pid:77,session:'400',name:'worker-400',ended_at:now+5,reason:'segfault',next_session:'500'};await until(async()=>(await text('process-exit'))?.includes('Segmentation fault'),'matching exit');const matching=await text('process-exit');state.current.exit={pid:88,session:'wrong',ended_at:now+6,reason:'oom'};await sleep(1200);assert.equal(await text('process-exit'),matching);await page.reload();await mode('Stopped reporting');assert.match(await text('process-exit'),/Segmentation fault/);assert.equal(await text('target-name'),'worker-400');await click('#replay-previous');await mode('Historical');await click('#replay-live');await mode('Stopped reporting');assert.equal(await text('target-name'),'worker-400');
 await click('#exited-live');await mode('Live');state.current={...frame(now+7,'900',0),threads:[]};const settleStart=Date.now();await sleep(1700);assert.equal(await text('target-name'),'worker-600');await until(async()=>JSON.parse(await text('diagnostics')).session==='900','ten second settling',15000);const elapsed=Date.now()-settleStart;assert.ok(elapsed>=9500);assert.equal(await page.locator('#exited').isVisible(),false);return {final,matching,settlingMs:elapsed,initialSettleMs:Date.now()-started};
});
caseId='QA-081';
await check('memory-control-boundary-future-earlier',async h=>{
 const observations=[];
 for(const boundary of [false,true]){
 const inputs=seed(boundary?'boundary':'growth');await h.page.goto(base+'/?target=');await h.mode('Live');await until(async()=>(await h.text('history-status')).startsWith('Checked 1 recording'),'memory scan',25000);await openDetails(h,'details[data-fold="past"]');await h.page.locator('#history-type').selectOption({label:'Memory'});
 const rows=await h.page.locator('#history-list .t').allTextContents(),marks=await h.page.locator('#timeline-marks').evaluate(e=>e.children.length);assert.deepEqual(rows,boundary?[]:['Resident memory grows without a plateau']);assert.equal(marks,boundary?0:1);
 if(!boundary){await h.click('#history-list > li');await h.mode('Historical');assert.match(await h.text('findings'),/Resident memory grows without a plateau/);}
 await h.click('#replay-live');await h.mode('Live');await h.click('#replay-previous');await h.mode('Historical');await until(async()=>await h.page.locator('#resource-tiles .tile polyline').count()>0,'resource chart');assert.equal((await h.text('findings')).includes('Resident memory grows without a plateau'),!boundary);
 const tiles=await h.page.locator('#resource-tiles').innerText();const poly=await h.page.locator('#resource-tiles .tile').evaluateAll(es=>es.map(e=>({label:e.querySelector('.label')?.textContent,points:e.querySelector('polyline')?.getAttribute('points'),text:e.textContent})));const rss=poly.find(e=>e.label==='Memory (RSS)');assert.equal(rss.points.trim().split(/\s+/).length,48);assert.ok(!tiles.includes('999'));const range=await h.page.locator('#resource-range-note').allTextContents();
 const queries=h.state.log.filter(x=>x.path==='/api/resources').slice(-4);observations.push({boundary,inputs,rows,marks,tiles,poly,range,queries,assessment:await h.text('findings'),status:await h.text('history-status')});
 }
 return observations;
});
await run.stop();writeFileSync(dir+'/observations-'+(process.env.ONLY||'all')+'.json',JSON.stringify(out,null,2));console.log(out.scenarios.map(s=>s.status+' '+s.name).join('\n'));
