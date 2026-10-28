import {chromium} from '/home/daksh/.local/state/triangulator/qa-c16a553/browser/node_modules/playwright/index.mjs';
import {spawn,execFileSync} from 'node:child_process';
import {writeFileSync,readFileSync,existsSync,mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
export {assert};
export const dir='/home/daksh/.local/state/triangulator/qa-c16a553/ui-final',base='http://127.0.0.1:19490';
export const now=Math.floor(Date.now()/1000),first=now-600,last=now-500;
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function frame(at=now,session='200',pid=42){return {recorded_at:at,recording_interval_s:1,process:{session,pid,started_at:at-500,command:`process-${session}`,executable:'/usr/bin/proof'},health:{session,pid,last_seen:at,target_absent:false,sampler_silent:false,sample_interval_ms:1000,packet_loss_pct:0,raw_samples:12,bad_packets:0,duplicates:0,late_packets:0},threads:[{tid:pid,generation:1,name:`worker-${session}`,group:'workers',state:'running',state_mix:{running:20},last_sample:at,cpu_pct:session==='200'?80:25,run_delay_pct:0,switches_per_s:2,cpu:3,wake_ms:500}],groups:{workers:1},resources:{available:true,session,pid,updated:at,memory:{rss:8388608,anon:4194304},fds:{open:12,soft_limit:1024},io:{read_bps:50,write_bps:10}},memory:{available:true,pid,layout_id:`${session}:1`,updated:at,interval_s:30,values:{vm_size_bytes:16777216,vm_data_bytes:4194304,major_faults:5,vma_count:1,max_map_count:65530}}};}
export const snapshots=[frame(first,'100'),frame(last,'100')];
export function seed(mode='initial'){
 const ss=mode==='initial'?snapshots:[frame(last,'100',7)];
 let resources;
 if(mode==='initial') resources=[first-180,first-60,first,last,last+200,now].map((ts,sequence)=>({ts,session:ts<=last?'100':'200',sequence,pid:42,elapsed_s:10,rss_bytes:ts<=last?8388608:33554432,fd_open:ts<=last?12:99}));
 else {ss[0].threads[0].cpu_pct=5;ss[0].resources.memory.rss=(100+8*235)*2**20;resources=Array.from({length:48},(_,i)=>({ts:last-240+5*i,session:'100',sequence:i,pid:7,elapsed_s:5,rss_bytes:(100+8*5*i)*2**20,fd_open:12}));if(mode==='boundary')resources.push({ts:last-6,session:'100',sequence:48,pid:8,elapsed_s:5,rss_bytes:null,fd_open:88}); resources.push({ts:last+1,session:'100',sequence:49,pid:8,elapsed_s:1,rss_bytes:999999999999,fd_open:999});}
 writeFileSync(dir+'/seed.json',JSON.stringify({snapshots:ss,resources}));
 execFileSync('python3',[dir+'/seed.py',dir+'/fixture/data',dir+'/seed.json']);
 return {snapshots:ss,resources};
}
export async function start(){mkdirSync(dir+'/fixture',{recursive:true});seed();
 writeFileSync(dir+'/fixture/collector.toml',`udp_host="127.0.0.1"\nudp_port=19499\nhttp_port=19490\ndata_dir="${dir}/fixture/data"\nreplay_interval_s=0\n`);
 const child=spawn('/home/daksh/.local/state/triangulator/qa-c16a553/package/triangulator/bin/triangulator-collector',[dir+'/fixture/collector.toml'],{stdio:['ignore','ignore','pipe']});let diagnostics='';child.stderr.on('data',d=>diagnostics+=d);writeFileSync(dir+'/collector.pid',String(child.pid));
 await until(async()=>{if(child.exitCode!==null)throw Error(diagnostics);try{return (await fetch(base+'/api/replay')).ok;}catch{return false;}},'collector');
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox'],downloadsPath:dir+'/downloads'});
 return {child,browser,stop:async()=>{await browser.close();child.kill('SIGTERM');await sleep(300);writeFileSync(dir+'/collector.log',diagnostics);}};
}
export async function until(fn,label,timeout=15000){const t=Date.now();while(Date.now()-t<timeout){if(await fn())return;await sleep(100);}throw Error('Observation timeout: '+label);}
export async function setup(browser,{storage='normal'}={}){
 const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'UTC'});const page=await context.newPage();page.setDefaultTimeout(7000);
 const state={current:frame(),lastTarget:{available:false},revision:'r1',rules:[{prefix:'worker-200',wake_ms:500}],holds:new Map(),overrides:new Map(),log:[],cancelled:[],errors:[],targets:[]};
 state.watch=()=>({rules:state.rules,source:'config',revision:state.revision,saved_error:null,limits:{prefix_max_bytes:15,wake_ms_min:1,wake_ms_max:60000,max_rules:64}});
 state.layout={available:true,id:'200:1',pid:42,updated:now,regions:[{start:'0x1000',end:'0x2000',size:4096,vmas:1,kind:'heap',permissions:'rw-p',name:'[heap]'}]};
 const values={total:'10000',current:11,average:10,minimum:1,maximum:20},metrics={input:values,output:values,messages:values};state.sockets={available:true,observer:'proof',pid:42,process_start:'77',messages_enabled:false,stale:false,stopped:false,losses:'0',lower_bound:false,duration:60,updated:now,gaps:0,truncated:false,rate_windows:6,coverage:'full',totals:metrics,rows:[{tid:42,name:'worker-200',thread_start:'1',kind:'tcp',kind_id:1,metrics}],history:[]};
 state.fulfill=async(route,body,status=200)=>{try{await route.fulfill({status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify(body)});}catch(e){state.cancelled.push(e.message);}};
 page.on('pageerror',e=>state.errors.push(e.message));
 await context.route(base+'/**',async route=>{const req=route.request(),u=new URL(req.url()),path=u.pathname; if(path.startsWith('/api/')){
 const item={route,path,query:Object.fromEntries(u.searchParams),method:req.method(),body:req.postData(),headers:req.headers(),at:Date.now()};state.log.push({...item,route:undefined});
 const held=state.holds.get(path);if(held&&(!held.predicate||held.predicate(item))){held.push(item);return;}
 if(state.overrides.has(path)){const x=state.overrides.get(path);return state.fulfill(route,x.body,x.status||200);}
 if(path==='/api/live')return state.fulfill(route,state.current);
 if(path==='/api/last-target')return state.fulfill(route,state.lastTarget);
 if(path==='/api/memory-map')return state.fulfill(route,state.layout);
 if(path==='/api/socket-io')return state.fulfill(route,state.sockets);
 if(path==='/api/watches'){if(req.method()==='POST'){state.rules=JSON.parse(req.postData()).rules;state.revision='r2';}return state.fulfill(route,state.watch());}
 if(path==='/api/history')return state.fulfill(route,{rows:[],limit:2000,truncated:false});
 if(path==='/api/targets')return state.fulfill(route,{targets:state.targets});
 if(storage==='blocked'){const r=await route.fetch();return route.fulfill({response:r,headers:{...r.headers(),'Access-Control-Allow-Origin':'*'}});}
 return route.continue();
 }
 if(path==='/storage-fill'){return route.fulfill({contentType:'text/html',body:`<button id="fill">Fill tab storage</button><div id="result"></div><a href="/?target=">Open dashboard</a><script>document.querySelector('button').onclick=()=>{let n=0;try{for(;n<10000;n++)sessionStorage.setItem('qa-fill-'+n,'x'.repeat(1024));}catch(e){document.querySelector('#result').textContent=e.name+' '+n+' KiB';}}</script>`});}
 if(storage==='blocked'){const r=await route.fetch();const h={...r.headers(),'Access-Control-Allow-Origin':'*'};if(path==='/')h['Content-Security-Policy']="sandbox allow-scripts allow-forms allow-popups allow-modals;";return route.fulfill({response:r,headers:h});}
 return route.continue();});
 const text=async id=>page.locator('#'+id).textContent();
 const facts=()=>page.evaluate(()=>Object.fromEntries(['target-name','target-meta','hero-cpu','hero-load','overview-rss','process-facts','findings','threads-live','resources','memory-map','replay-note','exited-text','process-exit','watch-editor','history-status','past-count'].map(id=>[id,document.getElementById(id)?.textContent])));
 const storageRead=()=>page.evaluate(()=>{try{return Object.fromEntries(Object.keys(sessionStorage).sort().filter(k=>!k.startsWith('qa-fill')).map(k=>[k,sessionStorage.getItem(k)]));}catch(e){return {error:e.name};}});
 const click=async sel=>{const node=page.locator(sel);if(await page.locator('#drawer').getAttribute('aria-hidden')==='false' && !await node.evaluate(e=>!!e.closest('#drawer')))await page.keyboard.press('Escape');await node.click();};
 const mode=async label=>until(async()=>(await text('target-meta'))?.includes(label),'mode '+label);
 const hold=(path,predicate)=>{const a=[];a.predicate=predicate;state.holds.set(path,a);return a;};
 const release=async(path,body,status=200)=>{const a=state.holds.get(path)||[];state.holds.delete(path);for(const i of a)if(body===undefined){try{await i.route.continue();}catch(e){state.cancelled.push(e.message);}}else await state.fulfill(i.route,body,status);};
 const goto=async()=>{await page.goto(base+'/?target=');await mode(state.current.health.target_absent?'Target absent':'Live');};
 return {context,page,state,text,facts,storageRead,click,mode,hold,release,goto};
}
