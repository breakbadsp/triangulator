// Batch CDP driver. Reads JSON lines on stdin. Fields: tab, k, ...
import {readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
const PORT=process.env.CDP_PORT||'19368', ROOT='/tmp/qa-pkg/out'+(process.env.CDP_PORT?'-'+PORT:'');
const TABS=ROOT+'-tabs.json', LOG=ROOT+'-obs.ndjson', ERR=ROOT+'-errors.ndjson';
const tabs=existsSync(TABS)?JSON.parse(readFileSync(TABS)):{};
const conns={};let last=null;
async function conn(name,raw){
  if(conns[name])return conns[name];
  const list=await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t=list.find(x=>x.id===tabs[name]); if(!t)throw Error('no tab '+name);
  const ws=new WebSocket(t.webSocketDebuggerUrl); await once(ws,'open');
  let id=0; const pend=new Map();
  ws.addEventListener('message',({data})=>{const m=JSON.parse(data);
    if(m.id){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(m.error):p.res(m.result);}
    else if(m.method==='Page.javascriptDialogOpening'){console.log('DIALOG '+JSON.stringify(m.params));appendFileSafe(LOG,{dialog:m.params});}
    else if(m.method==='Runtime.exceptionThrown'||m.method==='Network.loadingFailed'||(m.method==='Runtime.consoleAPICalled'&&['error','warning'].includes(m.params.type))||(m.method==='Network.responseReceived'&&m.params.response.status>=400))
      appendFileSafe(ERR,{tab:name,at:new Date().toISOString(),method:m.method,p:m.method==='Network.responseReceived'?{url:m.params.response.url,status:m.params.response.status}:m.params});});
  const send=(method,params={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method,params}));setTimeout(()=>rej(Error('timeout '+method)),20000);});
  if(!raw)for(const d of ['Page','Runtime','Network'])await send(d+'.enable');
  return conns[name]={send,ws};
}
function appendFileSafe(f,o){appendFileSync(f,JSON.stringify(o).slice(0,2000)+'\n');}
async function ev(c,expr){const r=await c.send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails).slice(0,400));return r.result.value;}
async function mouse(c,pt,clicks=1){await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...pt});await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:clicks,...pt});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:clicks,...pt});}
async function pt(c,a){return ev(c,`(()=>{const L=[...document.querySelectorAll(${JSON.stringify(a.sel)})].filter(e=>!${JSON.stringify(a.text||'')}||((e.innerText||'')+' '+(e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')).includes(${JSON.stringify(a.text||'')}));const e=L[${a.i||0}];if(!e)throw Error('missing '+${JSON.stringify(a.sel+'|'+(a.text||''))});e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);}
async function run(a){
  let r=null;
  if(a.k==='newtab'){const x=await(await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURI(a.url)}`,{method:'PUT'})).json();tabs[a.tab]=x.id;writeFileSync(TABS,JSON.stringify(tabs));await delay(a.wait||2500);r={id:x.id};}
  else if(a.k==='sleep'){await delay(a.ms);}
  else{const c=await conn(a.tab,a.k==='dialog');if(last!==a.tab&&a.k!=='front'){await fetch(`http://127.0.0.1:${PORT}/json/activate/${tabs[a.tab]}`);await delay(400);last=a.tab;}
    if(a.k==='nav'){await c.send('Page.navigate',{url:a.url});await delay(a.wait||2500);r=await ev(c,'location.href');}
    else if(a.k==='eval')r=await ev(c,a.expr);
    else if(a.k==='click'){const p=await pt(c,a);await mouse(c,p);await delay(a.wait||700);r=p;}
    else if(a.k==='key'){await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:a.key,code:a.code||a.key,windowsVirtualKeyCode:a.vk||0});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:a.key,code:a.code||a.key,windowsVirtualKeyCode:a.vk||0});await delay(a.wait||600);}
    else if(a.k==='type'){const p=await pt(c,a);await mouse(c,p);await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2});await c.send('Input.insertText',{text:a.text2});await delay(400);}
    else if(a.k==='dialog'){r=await c.send('Page.handleJavaScriptDialog',{accept:a.accept});}
    else if(a.k==='clicknw'){const p=await pt(c,a);c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p}).catch(()=>{});c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p}).catch(()=>{});await delay(600);c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p}).catch(()=>{});await delay(800);r=p;}
    else if(a.k==='shot'){const s=await c.send('Page.captureScreenshot',{format:'png'});writeFileSync(a.path,Buffer.from(s.data,'base64'));r=a.path;}
    else if(a.k==='viewport'){r=await c.send('Emulation.setDeviceMetricsOverride',{width:a.w,height:a.h,deviceScaleFactor:1,mobile:false});}
    else if(a.k==='front'){await fetch(`http://127.0.0.1:${PORT}/json/activate/${tabs[a.tab]}`);}
  }
  const out=JSON.stringify(r);console.log((a.label?a.label+': ':'')+(out&&out.length>1500?out.slice(0,1500)+'…':out));
  appendFileSafe(LOG,{at:new Date().toISOString(),a,r});
}
for await(const line of createInterface({input:process.stdin})){if(!line.trim())continue;try{await run(JSON.parse(line));}catch(e){console.log('ERR '+e.message);}}
for(const c of Object.values(conns))c.ws.close();
