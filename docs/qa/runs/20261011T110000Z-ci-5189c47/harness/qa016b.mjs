import { open, sleep } from './lib.mjs';
import fs from 'fs';
const { browser, page, diag } = await open({ width: 1280, height: 900 });
const st = o => fs.writeFileSync('/tmp/qa-6c3ba7cd/fx/state.json', JSON.stringify(o));
const read = () => page.evaluate(() => ({ caption: document.getElementById('memory-grid-caption').innerText.split('\n').slice(-1)[0], cells: document.querySelectorAll('#memory-grid > *').length, nonpad: [...document.querySelectorAll('#memory-grid > *')].filter(e => !/pad/.test(e.className)).length, sub: document.getElementById('memory-zoom-sub').innerText }));
const out = {}; const step = async (name, s, wait = 6000) => { st(s); await sleep(wait); out[name] = await read(); console.log(name, JSON.stringify(out[name])); };
st({ page: 4096, layout: 1 });
await page.goto('http://127.0.0.1:19872/#memory-map'); await sleep(5000);
out.start = await read(); console.log('start', JSON.stringify(out.start));
await step('growWithin', { page: 4096, layout: 2, heap: 1052672 });
await step('growPast', { page: 4096, layout: 3, heap: 1310720 + 4096 });
await step('growFar', { page: 4096, layout: 4, heap: 4194304 });
await step('contract', { page: 4096, layout: 5, heap: 1048576 });
await step('stale', { page: 4096, layout: 6, heap: 1048576, stale: true });
await step('partial', { page: 4096, layout: 7, heap: 1048576, partial: true });
// help
await page.evaluate(() => window.scrollTo(0, 0));
const btn = page.locator('#memory-map [data-help="heapmargin"] .help-button, #memory-map .help-button[aria-label*="margin" i]').first();
out.helpBtn = await btn.count();
if (out.helpBtn) { await btn.scrollIntoViewIfNeeded(); await btn.click(); await sleep(500); out.help = await page.evaluate(() => document.getElementById('help-guide-body').innerText.replace(/\s+/g, ' ').slice(0, 300)); }
out.diag = diag;
fs.writeFileSync(process.env.EV + '/qa016-sequence.json', JSON.stringify(out, null, 1));
await browser.close();
