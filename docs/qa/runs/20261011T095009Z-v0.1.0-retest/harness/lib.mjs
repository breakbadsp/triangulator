import { chromium } from 'playwright-core';
import fs from 'fs';
export const EV = process.env.EV;
export const URL = 'http://127.0.0.1:19861/';
export async function open(vp = { width: 1280, height: 800 }) {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: vp });
  const page = await ctx.newPage();
  const diag = [];
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) diag.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', e => diag.push(`pageerror: ${e.message}`));
  page.on('requestfailed', r => diag.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', r => { if (r.status() >= 400) diag.push(`http ${r.status()}: ${r.url()}`); });
  return { browser, page, diag, version: browser.version() };
}
export const text = p => p.evaluate(() => document.body.innerText);
export async function save(page, name, extra = '') {
  fs.writeFileSync(`${EV}/${name}.txt`, (extra ? extra + '\n---\n' : '') + await text(page));
  await page.screenshot({ path: `${EV}/${name}.png`, fullPage: false });
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
