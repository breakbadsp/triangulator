import {execFileSync} from 'node:child_process';
const container='triangulator-qa-c16-runtime';
const shell=cmd=>execFileSync('podman',['exec','-e','TRIANGULATOR_HOME=/qa/package/triangulator',container,'bash','-lc',cmd],{encoding:'utf8'});
export async function run(s){
 let p; s.labStatus='running';
 const tests=[
 ['QA-101','healthy',70,/No problems detected/,/worker-/],
 ['QA-102','cpu-spin',70,/saturat|CPU.*busy|core/i,/worker-hot/],
 ['QA-103','cpu-oversub',70,/waiting for CPU|run delay/i,/runnable|run/i],
 ['QA-105','yield-storm',70,/kernel|system/i,/yield|poll/i],
 ['QA-106','lock-convoy',70,/lock.contention|lock contention|contend/i,/futex/i],
 ['QA-107','deadlock',70,/stuck|not.*wok|not.*wak|long.*wait/i,/futex/i],
 ['QA-108','mem-leak',70,/RSS.*grow|resident.*grow|memory.*grow/i,/grow/i],
 ['QA-110','vm-bloat',70,/address.space.*(pressure|limit)|virtual.*limit/i,/RLIMIT_AS/],
 ['QA-111','fd-leak',70,/descriptor|file.*limit|open files/i,/high|exhaust|near.*limit/i],
 ['QA-112','disk-sync',70,/I\/O.*stall|blocked.*I\/O|disk.*stall/i,/uninterrupt|kernel|wait/i],
 ['QA-113','major-faults',70,/major.*fault/i,/I\/O.*stall|blocked.*I\/O/i],
 ['QA-114','tcp-slow',70,/zero.window|slow.peer|backpressure/i,/queued|queue/i],
 ['QA-115','udp-drop',70,/UDP.*drop|drop.*UDP/i,/buffer|pressure/i],
 ['QA-116','close-wait',70,/CLOSE.WAIT|close-wait/i,/excess|close problem|not clos|leak/i],
 ['QA-117','listen-full',70,/listen.*(queue|backlog)|incoming.*drop/i,/pressure|drop|full/i],
 ['QA-118','thread-churn',70,/lower bound/i,/thread.*(creat|churn)|churn/i],
 ['QA-119','thread-leak',165,/thread.count.*grow|thread.*increas|thread.*grow/i,/sustain|contin|grow/i],
 ['QA-120','stopped',70,/stopped/i,/thread/i]
 ];
 for(const [id,scenario,seconds,a,b] of tests.filter(t=>['QA-118','QA-119','QA-120'].includes(t[0]))){p=await s.context.newPage();p.setDefaultTimeout(5000);s.labPage=p;
  s.labStatus=id+' '+scenario;let pid;try{
   const kind=scenario==='stopped'?'healthy':scenario;
   shell(`/qa/bugbench ${kind} ${seconds+90} > /qa/${id}.log 2>&1 & echo $! > /qa/lab.pid`);
   pid=Number(shell('cat /qa/lab.pid').trim());
   shell('/qa/package/triangulator/scripts/set-target.sh lab '+pid);
   await p.goto('http://127.0.0.1:19401/?target=omarchy%2Flab');
   await p.waitForTimeout(1500);if(await p.getByRole('button',{name:'Show live',exact:true}).isVisible())await p.getByRole('button',{name:'Show live',exact:true}).click();await p.waitForFunction(pid=>document.body.innerText.includes('PID '+pid+' · Live'),pid,{timeout:10000});
   await p.locator('#threads-section').getByRole('button',{name:/All \d+/,exact:true}).click().catch(()=>{});
   if(scenario==='stopped'){await p.waitForTimeout(45000);shell('kill -STOP '+pid);await p.waitForTimeout(25000);}else await p.waitForTimeout(seconds*1000);
   const text=await p.locator('body').innerText();
   const overview=await p.locator('#overview').innerText();
   const memory=await p.locator('#memory-map').innerText();
   const resources=await p.locator('#resources').innerText();
   const threads=await p.locator('#threads-section').innerText();
   const fixture=shell('cat /qa/'+id+'.log');
   s.observations.push({case:id,scenario,pid,seconds,overview,memory,resources,threads,fixture});
   let pass=a.test(text)&&b.test(text);
   if(id==='QA-101')pass=overview.includes('No problems detected')&&!/saturat|leak|lock contention/.test(overview.replace('No saturated threads',''));
   if(id==='QA-120'){shell('kill -CONT '+pid);await p.waitForTimeout(2500);pass=pass&&!(await p.locator('#overview').innerText()).includes('Target process is absent');}
   await s.record(id,pass?'PASSED':'FAILED',`Observed ${scenario} in Chromium for ${seconds}s; PID ${pid}. Required patterns ${a} and ${b}. ${pass?'Observed':'One or more expected responses are absent'}.`,p);
  }catch(e){await s.record(id,'BLOCKED',String(e),p);}finally{if(pid)try{shell('kill -CONT '+pid+'; kill -TERM '+pid);}catch{} await p.close();s.save();}
 }
 s.labStatus='retest complete';
}
