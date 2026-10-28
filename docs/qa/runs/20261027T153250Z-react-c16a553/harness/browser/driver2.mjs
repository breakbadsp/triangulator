import { chromium } from 'playwright';
import {createInterface} from 'node:readline';
import fs from 'node:fs';
const root='/home/daksh/.local/state/triangulator/qa-c16a553';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1280,height:800}});
const page=await context.newPage();
const prior=fs.existsSync(root+'/browser-continuation.json')?JSON.parse(fs.readFileSync(root+'/browser-continuation.json','utf8')):{};
const errors=prior.errors||[]; const observations=prior.observations||[];
page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
const read=async(p=page)=>({url:p.url(),text:await p.locator('body').innerText(),inputs:await p.locator('input,select').evaluateAll(es=>es.map(e=>({tag:e.tagName,id:e.id,type:e.type,value:e.value,aria:e.getAttribute('aria-label'),options:e.options?[...e.options].map(o=>({value:o.value,text:o.text})):undefined}))),buttons:await p.getByRole('button').allTextContents()});
const save=()=>fs.writeFileSync(root+'/browser-continuation.json',JSON.stringify({browser:browser.version(),viewport:{width:1280,height:800},errors,observations},null,2));
const results=JSON.parse(fs.readFileSync(root+'/results.json','utf8'));
const record=async(id,status,note,p=page)=>{results[id]={status,note};observations.push({at:new Date().toISOString(),case:id,status,note});if(status==='FAILED')await p.screenshot({path:root+'/'+id.toLowerCase()+'-continuation-failure.png'});fs.writeFileSync(root+'/results.json',JSON.stringify(results,null,2));save();return results[id]};
const scope={browser,context,page,read,errors,observations,save,root,results,record};page.setDefaultTimeout(7000);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
for await(const line of createInterface({input:process.stdin})) {try {const result=await new AsyncFunction('s',`with(s){${line}}`)(scope); observations.push({at:new Date().toISOString(),action:line,result});save();console.log(JSON.stringify(result??null));}catch(e){console.log(JSON.stringify({error:String(e)}));save();}}
await browser.close();
