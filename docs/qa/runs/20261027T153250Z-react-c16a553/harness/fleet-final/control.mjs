import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
export async function run(s){const p=s.page;
const pod=(...args)=>execFileSync('podman',['exec','triangulator-qa-fleet-final',...args],{encoding:'utf8'});
await s.check('QA-089',async()=>{await p.goto('http://127.0.0.1:19463');await p.getByRole('button',{name:'+Add target',exact:true}).click();s.detail.push({addDialog:await p.locator('[role=dialog]').innerText(),inputs:await p.locator('[role=dialog] input').evaluateAll(es=>es.map(e=>({id:e.id,placeholder:e.placeholder,type:e.type})))});return 'INSPECT';});
}
