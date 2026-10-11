import { open, sleep } from './lib.mjs';
import fs from 'fs';
const { browser, page } = await open({ width: 1280, height: 900 });
fs.writeFileSync('/tmp/qa-6c3ba7cd/fx/state.json', JSON.stringify({ page: 4096, layout: 1 }));
await page.goto('http://127.0.0.1:19872/#memory-map'); await sleep(5000);
const out = [];
const n = await page.locator('#memory-amap .arow').count();
for (let i = 0; i < n; i++) {
  await page.locator('#memory-amap .arow').nth(i).scrollIntoViewIfNeeded();
  await page.locator('#memory-amap .arow').nth(i).click(); await sleep(1800);
  out.push(await page.evaluate(() => {
    const cells = [...document.querySelectorAll('#memory-grid > *')];
    const kinds = {}; cells.forEach(c => { const k = c.className.replace(/\s+/g, ' ') + '|' + getComputedStyle(c).backgroundColor + (getComputedStyle(c).backgroundImage !== 'none' ? '+img' : ''); kinds[k] = (kinds[k] || 0) + 1; });
    const legend = [...document.querySelectorAll('#memory-grid ~ .legend > span, #memory-grid-caption ~ .legend > span, .legend')].map(e => e.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 3);
    const sw = [...document.querySelectorAll('#memory-grid ~ .legend > span')].map(s => [s.innerText.trim(), getComputedStyle(s.querySelector('i,.sw')||s).backgroundColor]);
    return { zoom: document.getElementById('memory-zoom-name').innerText, kinds, legend, sw, html: document.getElementById('memory-grid').parentElement.querySelector('.legend')?.outerHTML.slice(0, 600) };
  }));
}
fs.writeFileSync(process.env.EV + '/qa008-legend.json', JSON.stringify(out, null, 1));
for (const o of out) console.log(o.zoom, JSON.stringify(o.kinds), JSON.stringify(o.sw));
await browser.close();
