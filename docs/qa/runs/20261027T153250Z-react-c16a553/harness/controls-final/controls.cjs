const {connect,text,save,root}=require('./browser.cjs');
const {execFileSync}=require('child_process');const fs=require('fs');
function sh(s){return execFileSync('podman',['exec','triangulator-qa-controls-final','bash','-c',s],{encoding:'utf8'}).trim()}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{const {b,c}=await connect();const a=await c.newPage(),d=await c.newPage();const out={steps:[],errors:[]};const snapshot=async(label,p=a)=>{const t=await text(p);out.steps.push({label,text:t});await save('controls-observations',out);console.log(label,t.match(/(?:Unable|capacity|maximum|Invalid|already|no running|last target)[^\n]*/gi)?.slice(0,5)||'observed');};
const api=async()=>await (await a.request.get('http://127.0.0.1:19501/api/targets')).json();const config=()=>fs.readFileSync(root+'/runtime/config/sampler.toml','utf8');
await a.goto('http://127.0.0.1:19501/');await d.goto('http://127.0.0.1:19501/');await wait(1000);out.before=await api();out.samplerPid=sh('cat /qa/runtime/run/sampler.pid');out.configBefore=config();a.setDefaultTimeout(7000);await a.bringToFront();await a.setViewportSize({width:1100,height:900});await a.locator('#fleet-add').click();await a.locator('#target-id').fill('extra');await a.locator('#target-input').fill(fs.readFileSync(root+'/fixtures/extra.pid','utf8').trim());
await a.locator('label[for="target-id"]').hover();await wait(3500);out.help=await a.locator('.help-card').allTextContents();out.helpInside=await a.locator('.help-card').evaluateAll(es=>es.map(e=>!!e.closest('dialog')));if(await a.locator('.help-card a[href="#help-manage-targets"]').count())await a.locator('.help-card a[href="#help-manage-targets"]').click();out.relatedHelp=await a.locator('.help-card').allTextContents();await a.keyboard.press('Escape');out.escapeGuide={dialog:await a.locator('#target-settings').isVisible(),cards:await a.locator('.help-card').count()};
a.once('dialog',x=>x.accept());await a.locator('#target-save').click();await wait(1000);await snapshot('sixth-at-capacity');out.capacityConfigUnchanged=config()===out.configBefore;
await a.keyboard.press('Escape');
console.log('buttons',await a.locator('#fleet-grid article').evaluateAll(es=>es.map(e=>({text:e.innerText.slice(0,180),html:e.querySelector('button')?.outerHTML}))));
await save('controls-observations',out);await b.close();})();
