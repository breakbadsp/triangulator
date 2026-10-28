const { chromium } = require('/home/daksh/.local/state/triangulator/qa-c16a553/browser/node_modules/playwright');
const fs = require('fs');
const root=__dirname;
async function connect(){const b=await chromium.connectOverCDP('http://127.0.0.1:19502');const c=b.contexts()[0];return {b,c,p:c.pages()[0]||await c.newPage()};}
async function text(p){return await p.locator('body').innerText();}
async function save(name,data){fs.writeFileSync(`${root}/${name}.json`,JSON.stringify(data,null,2));}
module.exports={connect,text,save,root};
if(require.main===module)(async()=>{const {b,p}=await connect();await p.goto('http://127.0.0.1:19501/?target=omarchy%2Fmemory');await p.waitForTimeout(1500);console.log((await text(p)).slice(0,19000));console.log(await p.locator('button,select,input').evaluateAll(es=>es.map(e=>({tag:e.tagName,id:e.id,text:e.innerText,title:e.title,aria:e.getAttribute('aria-label')}))));await b.close();})();
