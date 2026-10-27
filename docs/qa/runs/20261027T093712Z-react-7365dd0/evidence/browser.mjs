import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
const root='/tmp/triangulator-qa-react-full-7365dd0';
const tabs=await(await fetch('http://127.0.0.1:19367/json/list')).json();
const ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
await once(ws,'open');
let id=0;const pending=new Map();
ws.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(m.error):p.resolve(m.result);}else if(m.method==='Page.javascriptDialogOpening'){console.log(JSON.stringify({dialog:m.params}));}});
function send(method,params={}){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CDP timeout: '+method)),10000);pending.set(++id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
await send('Page.enable');
async function run(action){
let result;
if(action.kind==='cdp'){result=await send(action.method,action.params);}
if(action.kind==='dialog'){result=await send('Page.handleJavaScriptDialog',{accept:action.accept});}
if(action.kind==='navigate'){result=await send('Page.navigate',{url:action.url});}
if(action.kind==='scroll'){
 const doc=await send('DOM.getDocument');
 const {nodeId}=await send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:action.selector});
 result=await send('DOM.scrollIntoViewIfNeeded',{nodeId});
}
if(action.kind==='read'){result=await evaluate(action.expression??'({title:document.title,text:document.body.innerText,controls:[...document.querySelectorAll("button,input,select,a")].map(e=>({tag:e.tagName,text:e.innerText,aria:e.getAttribute("aria-label"),id:e.id,type:e.type,value:e.value}))})');}
if(action.kind==='click'||action.kind==='fill'||action.kind==='hover'){
 const box=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(action.selector)});if(!e)throw Error('Missing selector');const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',...box});
 if(action.kind!=='hover'){
  await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});
 }
 if(action.kind==='fill'){
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2});
  await send('Input.insertText',{text:action.text});
 }
 result=box;
}
if(action.kind==='key'){await send('Input.dispatchKeyEvent',{type:'keyDown',key:action.key});await send('Input.dispatchKeyEvent',{type:'keyUp',key:action.key});}
if(action.kind==='screenshot'){const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(action.path,Buffer.from(r.data,'base64'));result=action.path;}
if(action.kind==='viewport'){result=await send('Emulation.setDeviceMetricsOverride',{width:action.width,height:action.height,deviceScaleFactor:1,mobile:false});}
console.log(JSON.stringify(result??null));
await appendFile(root+'/browser-observations.ndjson',JSON.stringify({at:new Date().toISOString(),action,result:result??null})+'\n');
}
if(process.argv[2]==='-'){
 const input=createInterface({input:process.stdin});
 for await(const line of input){try{await run(JSON.parse(line));}catch(e){console.log(JSON.stringify({error:String(e)}));}}
}else{await run(JSON.parse(process.argv[2]));}
ws.close();
