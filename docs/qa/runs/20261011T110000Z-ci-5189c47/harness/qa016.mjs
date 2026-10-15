import { open, save, sleep } from './lib.mjs';
import fs from 'fs';
const { browser, page, diag } = await open({ width: 1280, height: 900 });
const st = o => fs.writeFileSync('/tmp/qa-6c3ba7cd/fx/state.json', JSON.stringify(o));
const read = () => page.evaluate(() => ({ caption: document.getElementById('memory-grid-caption').innerText, sub: document.getElementById('memory-zoom-sub').innerText, cells: document.querySelectorAll('#memory-grid > *').length, charts: document.getElementById('memory-charts').innerText }));
const out = {};
st({ page: 4096, layout: 1 });
await page.goto('http://127.0.0.1:19872/#memory-map'); await sleep(5000);
out.before = await read(); await page.screenshot({ path: process.env.EV + '/qa016-before.png' });
// legend/colors for heap zoom (QA-008 partial): swatches present in legend
out.legendHeap = await page.evaluate(() => [...document.querySelectorAll('#memory-grid ~ .legend > span, #memory-zoom-facts ~ .legend > span, .mem-legend > span')].map(e => e.innerText.trim()));
st({ page: 4096, layout: 2, heap: 1052672, stack: 4096 });
await sleep(6000);
out.after = await read(); await page.screenshot({ path: process.env.EV + '/qa016-after.png' });
out.diag = diag;
fs.writeFileSync(process.env.EV + '/qa016-observations.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
await browser.close();
