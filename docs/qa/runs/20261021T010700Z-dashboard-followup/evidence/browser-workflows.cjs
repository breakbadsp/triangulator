const {chromium,firefox}=require('/home/daksh/.t3/runtime/versions/0.1.0/node_modules/playwright-core');
const fs=require('fs'),net=require('net'),cp=require('child_process');
const out=__dirname+'/browser-workflows.json', observations=[];
const record=(stage,value)=>{observations.push({stage,time:new Date().toISOString(),value});fs.writeFileSync(out,JSON.stringify(observations,null,2));console.log(stage,JSON.stringify(value).slice(0,350));};
const url='http://127.0.0.1:19571/?target=omarchy%2Fdefault';
const state=p=>p.evaluate(()=>({url:location.href,name:document.querySelector('#target-name')?.innerText,meta:document.querySelector('#target-meta')?.innerText,health:document.querySelector('#health')?.innerText,search:document.querySelector('#search')?.value,replay:document.querySelector('#replay-note')?.innerText}));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
record('chromium-version',browser.version());
const contexts=[],pages=[];
for(let i=0;i<20;i++) {let c=await browser.newContext({viewport:{width:1280,height:800}});contexts.push(c);let p=await c.newPage();pages.push(p);await p.goto(url);await p.locator('#target-name').filter({hasText:'bb-healthy'}).waitFor();}
record('qa045-twenty-initial',await Promise.all(pages.map(state)));
const idle=net.connect(19571,'127.0.0.1'),slow=net.connect(19571,'127.0.0.1');let closed=null;const start=Date.now();slow.on('error',()=>{});slow.on('end',()=>{closed=Date.now()-start});slow.on('close',()=>{closed??=Date.now()-start});slow.write('G');const timer=setInterval(()=>{if(!slow.destroyed)slow.write('E')},1000);
await pause(11000);clearInterval(timer);record('qa045-slow-deadline',{closedMs:closed,views:await Promise.all(pages.map(state))});idle.destroy();slow.destroy();
await pages[0].locator('[data-fold=timeline] > summary').click();await pages[0].locator('#replay-previous').click();await pages[0].locator('#replay-note').filter({hasText:'Recorded view'}).waitFor();record('qa045-local-replay',await Promise.all(pages.map(state)));
await pages[0].locator('#replay-live').click();
const runtime='/tmp/triangulator-dashboard-followup/triangulator';const env={...process.env,TRIANGULATOR_HOME:runtime};
cp.execFileSync(runtime+'/scripts/stop.sh',['collector'],{env});await pause(15000);record('qa051-outage',await Promise.all(pages.map(state)));
cp.execFileSync(runtime+'/scripts/start.sh',['collector'],{env});await pause(16000);record('qa051-recovery',await Promise.all(pages.map(state)));
for(let i=1;i<20;i++)await contexts[i].close();
try {
 const ff=await firefox.launch({executablePath:'/home/daksh/.cache/ms-playwright/firefox-1555/firefox/firefox',headless:true});record('firefox-version',ff.version());const fc=await ff.newContext(),f=await fc.newPage();await f.goto(url);await f.locator('#target-name').filter({hasText:'bb-healthy'}).waitFor();
 await f.locator('#search').fill('worker-0');await f.locator('[data-fold=timeline] > summary').click();await f.locator('#replay-previous').click();await f.locator('#replay-note').filter({hasText:'Recorded view'}).waitFor();record('qa052-independent-filter-replay',{firefox:await state(f),chromium:await state(pages[0])});
 await f.locator('#replay-live').click();await f.locator('#target-select').selectOption('omarchy/locks');await f.locator('#target-name').filter({hasText:'bb-deadlock'}).waitFor();record('qa052-target-isolation',{firefox:await state(f),chromium:await state(pages[0])});await ff.close();
}catch(e){record('qa052-firefox-error',String(e))}
for(const [filename,kind] of [['dashboard-http-animation.html','animation'],['sampler-benchmark.html','benchmark']]){
 const file='file:///home/daksh/.t3/worktrees/triangulator/qa-five-prod-targets/docs/'+filename;
 const c=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce',offline:true});const p=await c.newPage();await p.goto(file);record(kind+'-reduced-offline',{text:(await p.locator('body').innerText()).slice(0,4500),layout:await p.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches}))});
 await p.keyboard.press('Tab');record(kind+'-keyboard-focus',await p.evaluate(()=>({tag:document.activeElement.tagName,text:document.activeElement.innerText,outline:getComputedStyle(document.activeElement).outline})));
 if(kind==='animation'){await p.locator('#play').click();record('animation-reduced-play',await p.evaluate(()=>({marker:getComputedStyle(document.querySelector('#marker')||document.querySelector('.packet')||document.body).visibility,text:document.body.innerText.slice(0,700)})));}
 else {await p.locator('button[data-rate="2"]').focus();await p.keyboard.press('Enter');await p.locator('button[data-hz="2"][data-count="300"]').focus();await p.keyboard.press('Enter');await p.getByRole('button',{name:'Explain sampler CPU',exact:true}).click();await p.keyboard.press('Escape');record('benchmark-keyboard-return',await p.evaluate(()=>({focus:document.activeElement.getAttribute('aria-label'),text:document.querySelector('dialog')?.innerText,open:document.querySelector('dialog')?.open})));}
 await c.close();const nc=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844},offline:true});const np=await nc.newPage();await np.goto(file);record(kind+'-no-javascript',{text:(await np.locator('body').innerText()).slice(-6500),layout:await np.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}))});await nc.close();
}
await browser.close();record('completed',true);
})().catch(e=>{record('fatal',String(e));process.exitCode=1});
