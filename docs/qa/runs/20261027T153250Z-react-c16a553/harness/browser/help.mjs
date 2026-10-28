export async function run(s){
 const p=await s.context.newPage();p.setDefaultTimeout(5000);s.helpPage=p;await p.goto('http://127.0.0.1:19401/?target=omarchy%2Fsecond');await p.waitForTimeout(1000);
 const entries=await p.locator('[data-help]:visible').evaluateAll(es=>es.map((e,i)=>({i,topic:e.dataset.help,tag:e.tagName,text:e.innerText.slice(0,70)})));
 const checks=[];s.helpStatus='running';
 for(const entry of entries){try{
  const loc=p.locator('[data-help]:visible').nth(entry.i);if(!await loc.isVisible())continue;
  await p.keyboard.press('Escape');await loc.hover();await p.waitForTimeout(3100);
  const dialogs=await p.locator('[role=dialog]:visible').allTextContents();checks.push({...entry,dialogs:dialogs.map(t=>t.slice(0,140))});s.helpStatus=`${checks.length}/${entries.length}`;
 }catch(e){checks.push({...entry,error:String(e)});}}
 s.observations.push({case:'QA-007',checks});s.helpChecks=checks;s.helpStatus='hover complete';s.save();
}
