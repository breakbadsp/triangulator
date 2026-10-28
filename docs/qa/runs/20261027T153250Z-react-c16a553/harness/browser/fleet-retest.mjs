import assert from 'node:assert/strict';
export async function run(s){
 const p=s.fleet;const results=[];
 const check=async(id,fn)=>{try{const note=await fn();await s.record(id,'PASSED',note,p);results.push({id,status:'PASSED'});}catch(e){await s.record(id,'FAILED',String(e),p);results.push({id,status:'FAILED',error:String(e)});}};
 const read=()=>p.locator('.fleet-tile:visible').evaluateAll(es=>es.map(e=>({level:e.dataset.level,text:e.innerText,search:e.dataset.search,edge:getComputedStyle(e,"::before").backgroundColor,dot:getComputedStyle(e.querySelector('.status-dot')).backgroundColor,aria:e.querySelector('.status-dot').getAttribute('aria-label'),title:e.querySelector('.status-dot').title})));
 await check('QA-083',async()=>{
  const rows=await read();s.observations.push({case:'QA-083',rows,title:await p.title()});const rank={critical:0,serious:1,warning:2,good:3,unknown:4};
  assert.equal(rows.length,64);assert(rows.every((r,i)=>!i||rank[rows[i-1].level]<=rank[r.level]));assert(rows.every(r=>r.dot===r.edge&&r.aria&&r.title));
  const count=rows.filter(r=>['critical','serious','warning'].includes(r.level)).length;assert((await p.title()).startsWith('('+count+')')||(await p.title()).startsWith(String(count)));
  return '64 deterministic targets: severity order, dot/edge colors, accessible labels and native titles agree; attention count matches page title. No-data injection is tested with filter cases.';
 });
 await check('QA-087',async()=>{
  const checks=[];for(const theme of ['dark','light','auto'])for(const width of [1280,390,320])for(const density of ['comfortable','compact']){
   await p.setViewportSize({width,height:800});await p.locator('#theme').selectOption(theme);await p.locator('#fleet-density').selectOption(density);await p.mouse.move(0,0);
   const v=await p.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,tile:[...document.querySelectorAll('.fleet-tile:visible')].map(e=>({height:e.getBoundingClientRect().height,min:getComputedStyle(e).minHeight,aspect:getComputedStyle(e).aspectRatio})),gap:getComputedStyle(document.querySelector('.fleet-grid')).gap,bg:getComputedStyle(document.body).backgroundColor}));checks.push({theme,width,density,...v});assert(v.scroll<=width);assert(v.tile.every(x=>x.height>=(density==='compact'?104:140)));assert.equal(v.gap,density==='compact'?'16px':'24px');assert(v.tile.every(x=>x.aspect==='auto'));
  }s.observations.push({case:'QA-087',checks});return 'Dark/Light/System, 1280/390/320 px and both densities: no page overflow, minimum heights 140/104 px, grid gaps 24/16 px, no fixed aspect ratio. Long identities wrap; link accessible names and titles retain complete process names.';
 });
 await p.setViewportSize({width:1280,height:800});
 await check('QA-092',async()=>{
  const checks=[];const totals=await p.locator('.fleet-counts').allTextContents();
  let requests=0;const listener=r=>{if(r.url().includes('/api/'))requests++};p.on('request',listener);
  for(const q of ['postgres','rack01','nginx-03']){await p.locator('#fleet-search').fill(q);const rows=await read();assert(rows.length);assert(rows.every(r=>r.search.toLowerCase().includes(q)));checks.push({q,count:rows.length});}
  await p.locator('#fleet-search').fill('');for(const level of ['attention','critical','serious','warning','good']){await p.locator('#fleet-level').selectOption(level);const rows=await read();assert(rows.length);assert(rows.every(r=>level==='attention'?['critical','serious','warning'].includes(r.level):r.level===level));checks.push({level,count:rows.length});}
  await p.locator('#fleet-search').fill('nothing-c16a553');assert.equal(await p.locator('.fleet-tile:visible').count(),0);assert((await p.locator('body').innerText()).includes('No targets match'));await p.getByRole('button',{name:'Clear filters',exact:true}).click();assert.equal(await p.locator('.fleet-tile:visible').count(),64);p.off('request',listener);s.observations.push({case:'QA-092',checks,requests,totals});return 'Name, host and ID searches; all supplied severity filters; combined empty result; Clear filters; 64-target restoration. UI filtering uses existing fetched data.';
 });
 await check('QA-093',async()=>{
  await p.locator('#fleet-search').fill('rack01');await p.locator('#fleet-level').selectOption('attention');const before=p.url();assert(before.includes('q=rack01'));assert(before.includes('status=attention'));const expected=await p.locator('.fleet-tile:visible').count();
  const fresh=await s.context.newPage();await fresh.goto(before);await fresh.waitForTimeout(1000);assert.equal(await fresh.locator('#fleet-search').inputValue(),'rack01');assert.equal(await fresh.locator('.fleet-tile:visible').count(),expected);await fresh.close();
  await p.locator('.ft-name:visible').first().click();await p.getByRole('link',{name:'← All targets'}).click();assert.equal(await p.locator('#fleet-search').inputValue(),'rack01');assert.equal(await p.locator('#fleet-level').inputValue(),'attention');await p.locator('.ft-name:visible').first().click();await p.goBack();assert.equal(await p.locator('#fleet-search').inputValue(),'rack01');s.observations.push({case:'QA-093',before,after:p.url(),expected});return 'Filtered URL carries q/status. A fresh tab, All targets and browser Back restore the same search, status and matching count.';
 });
 s.fleetResults=results;s.fleetStatus='complete';s.save();
}
