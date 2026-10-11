import { open, sleep } from './lib.mjs';
import fs from 'fs';
const out = {};
for (const [name, vp] of [['desktop', { width: 1280, height: 900 }], ['narrow', { width: 390, height: 844 }]]) {
  const { browser, page, diag } = await open(vp);
  fs.writeFileSync('/tmp/qa-6c3ba7cd/fx/state.json', JSON.stringify({ page: 4096, layout: 1 }));
  await page.goto('http://127.0.0.1:19872/#memory-map'); await sleep(5000);
  out[name] = await page.evaluate(() => {
    const r = e => { const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    const charts = [...document.querySelectorAll('#memory-charts > *')].map(r);
    return { docW: document.documentElement.scrollWidth, vw: innerWidth, charts, facts: r(document.getElementById('memory-zoom-facts')), legendVisible: !!document.querySelector('#memory-grid ~ .legend')?.getBoundingClientRect().width, gridVisible: r(document.getElementById('memory-grid')).w > 0, headings: [...document.querySelectorAll('#memory-charts h4, #memory-charts .chart-title, #memory-charts > * > :first-child')].slice(0, 3).map(e => e.innerText.replace(/\n/g, ' / ')) };
  });
  await page.screenshot({ path: `${process.env.EV}/qa015-${name}.png` });
  if (name === 'narrow') {
    const sum = page.locator('summary', { hasText: 'Member regions' });
    await sum.scrollIntoViewIfNeeded(); await sum.focus();
    const det = () => page.evaluate(() => document.querySelector('details:has(#memory-regions)').open);
    out.kbd = { before: await det() };
    await page.keyboard.press('Enter'); await sleep(400); out.kbd.afterEnter = await det();
    await sleep(4000); out.kbd.afterSample = await det();   // fixture polls: new sample
    await page.keyboard.press('Enter'); await sleep(400); out.kbd.afterClose = await det();
    await page.keyboard.press('Enter'); await sleep(400);
    const hb = page.locator('details:has(#memory-regions) .help-button, summary:has-text("Member regions") .help-button, summary:has-text("Member regions") ~ * .help-button').first();
    out.memberHelp = (await hb.count()) ? await (async () => { await hb.focus(); await page.keyboard.press('Enter'); await sleep(500); const t = await page.evaluate(() => document.getElementById('help-guide-title').innerText + ' :: ' + document.getElementById('help-guide-body').innerText.replace(/\s+/g, ' ').slice(0, 400)); await page.keyboard.press('Escape'); await page.click('#help-guide-close').catch(() => {}); return t; })() : 'no help button';
    const tb = page.locator('#memory-map .help-button[aria-label="Explain Thread stacks"]').first();
    await tb.scrollIntoViewIfNeeded(); await (await tb.evaluateHandle(e => e.parentElement)).asElement().hover(); await tb.click(); await sleep(500);
    out.threadStacks = await page.evaluate(() => document.getElementById('help-guide-body').innerText.replace(/\s+/g, ' ').slice(0, 600));
  }
  out[name].diag = diag; await browser.close();
}
fs.writeFileSync(process.env.EV + '/qa015-observations.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1).slice(0, 4000));
