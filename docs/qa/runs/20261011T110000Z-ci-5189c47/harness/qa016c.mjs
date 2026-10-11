import { open, sleep } from './lib.mjs';
import fs from 'fs';
const { browser, page, diag } = await open({ width: 1280, height: 900 });
const st = o => fs.writeFileSync('/tmp/qa-6c3ba7cd/fx/state.json', JSON.stringify(o));
const cap = () => page.evaluate(() => document.getElementById('memory-grid-caption').innerText.split('\n').slice(-1)[0]);
const out = {};
st({ page: 4096, layout: 1 });
await page.goto('http://127.0.0.1:19872/#memory-map'); await sleep(5000);
const b = page.locator('#memory-map .help-button[aria-label="Explain Heap display margin"]').first();
out.helpButtons = await page.evaluate(() => [...document.querySelectorAll('#memory-map .help-button')].map(x => x.getAttribute('aria-label')).filter(l => /margin|gap|stack/i.test(l)));
out.helpBtn = await b.count();
if (out.helpBtn) { await b.scrollIntoViewIfNeeded(); await page.mouse.move(2,2); await (await b.evaluateHandle(e => e.parentElement)).asElement().hover().catch(()=>{}); await b.click(); await sleep(500); out.help = await page.evaluate(() => document.getElementById('help-guide-body').innerText.replace(/\s+/g, ' ').slice(0, 500)); await page.click('#help-guide-close'); }
// grow past, then change selection and come back
st({ page: 4096, layout: 3, heap: 1314816 }); await sleep(6000); out.grown = await cap();
const bars = page.locator('#memory-amap [data-kind], #memory-amap .bar-row');
out.barCount = await bars.count();
await page.evaluate(() => { document.getElementById('memory-amap').scrollIntoView({ block: 'center' }); });
const rows = await page.evaluate(() => [...document.querySelectorAll('#memory-amap > *')].map(e => e.className + ' | ' + e.innerText.replace(/\s+/g, ' ').slice(0, 50)).slice(0, 12));
out.rows = rows;
await page.locator('#memory-amap').locator('text=/neighbor/').first().click().catch(e => out.clickErr = String(e).slice(0, 80)); await sleep(2500);
out.otherSel = await cap();
await page.locator('#memory-amap').locator('text=[heap]').first().click().catch(e => out.clickErr2 = String(e).slice(0, 80)); await sleep(2500);
out.backToHeap = await cap();
out.diag = diag; fs.writeFileSync(process.env.EV + '/qa016-help-selection.json', JSON.stringify(out, null, 1)); console.log(JSON.stringify(out, null, 1).slice(0, 2500));
await browser.close();
