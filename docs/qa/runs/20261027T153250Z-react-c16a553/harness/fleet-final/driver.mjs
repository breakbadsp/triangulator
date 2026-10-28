import { chromium } from '../browser/node_modules/playwright/index.mjs';
import {createInterface} from 'node:readline';
import fs from 'node:fs';
const root='/home/daksh/.local/state/triangulator/qa-c16a553/fleet-final';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1280,height:800}});
const page=await context.newPage();
const errors=[]; const observations=[];
page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
const read=async(p=page)=>({url:p.url(),text:await p.locator('body').innerText(),inputs:await p.locator('input,select').evaluateAll(es=>es.map(e=>({tag:e.tagName,id:e.id,type:e.type,value:e.value,aria:e.getAttribute('aria-label'),options:e.options?[...e.options].map(o=>({value:o.value,text:o.text})):undefined}))),buttons:await p.getByRole('button').allTextContents()});
const save=()=>fs.writeFileSync(root+'/browser-observations.json',JSON.stringify({browser:browser.version(),viewport:{width:1280,height:800},errors,observations},null,2));
page.setDefaultTimeout(7000); const scope={browser,context,page,read,errors,observations,save,root};
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
for await(const line of createInterface({input:process.stdin})) {try {const result=await new AsyncFunction('s',`with(s){${line}}`)(scope); observations.push({at:new Date().toISOString(),action:line,result});save();console.log(JSON.stringify(result??null));}catch(e){console.log(JSON.stringify({error:String(e)}));save();}}
await browser.close();
