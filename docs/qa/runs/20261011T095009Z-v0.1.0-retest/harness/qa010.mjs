import { chromium } from 'playwright-core';
import fs from 'fs';
const EV = process.env.EV, SRC = 'file:///home/daksh/.t3/worktrees/triangulator/t3code-6c3ba7cd/docs/wire-format-overview.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const diag = []; page.on('pageerror', e => diag.push('pageerror ' + e.message)); page.on('console', m => { if (m.type() === 'error') diag.push('console.error ' + m.text()); });
const out = {};
await page.goto(SRC); await sleep(1500);
// nav links
out.nav = [];
for (const href of ['#s1', '#s2', '#s3', '#s4']) {
  await page.click(`nav a[href="${href}"]`); await sleep(600);
  out.nav.push(await page.evaluate(h => { const e = document.querySelector(h), n = document.querySelector('nav'); return { h, headTop: Math.round(e.getBoundingClientRect().top), navBottom: Math.round(n.getBoundingClientRect().bottom), below: e.getBoundingClientRect().top >= n.getBoundingClientRect().bottom - 1, text: e.innerText.slice(0, 40) }; }, href));
}
// tabs
await page.click('nav a[href="#s2"]'); await sleep(300);
out.tabs = {};
const tabNames = await page.$$eval('#tabs > *', els => els.map(e => e.innerText));
out.tabNames = tabNames;
for (const t of tabNames) {
  await page.click(`#tabs >> text=${t.split(/\s/)[0]}`); await sleep(300);
  const lay = await page.innerText('#layout');
  out.tabs[t] = lay.replace(/\s+/g, ' ').slice(0, 260);
  await page.click('nav a[href="#s3"]'); await sleep(200);
  await page.click('#encbtn'); await sleep(1200); await page.click('#decbtn'); await sleep(1200);
  out.tabs[t + ':enc'] = (await page.innerText('#hex')).replace(/\s+/g, ' ').slice(0, 200) + ' || ' + (await page.innerText('#decout')).replace(/\s+/g, ' ').slice(0, 300);
  await page.click('nav a[href="#s2"]'); await sleep(200);
}
fs.writeFileSync(`${EV}/qa010-layouts.json`, JSON.stringify(out, null, 1));
// section 1: thread counts
await page.click('nav a[href="#s1"]'); await sleep(500);
out.threads = {};
for (const n of [1, 10, 11, 60]) {
  await page.$eval('#threads', (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, String(n));
  await sleep(1200);
  out.threads[n] = await page.evaluate(() => ({ label: document.getElementById('threadsv').textContent, tmon: state.threads, total: asm.TMON && asm.TMON.total }));
}
await page.screenshot({ path: `${EV}/qa010-flow.png` });
console.log(JSON.stringify({ nav: out.nav, tabNames, threads: out.threads }, null, 1));
fs.writeFileSync('/tmp/qa-6c3ba7cd/qa010-part1.json', JSON.stringify(out, null, 1));
console.log(diag);
await browser.close();
