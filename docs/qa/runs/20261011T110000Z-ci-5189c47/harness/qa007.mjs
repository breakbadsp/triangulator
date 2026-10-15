import { open, save, sleep } from './lib.mjs';
import fs from 'fs';
const EV = process.env.EV;
const { browser, page, diag } = await open({ width: 1400, height: 900 });
await page.goto('http://127.0.0.1:19871/'); await sleep(7000);
const out = { hoverHelpOn: await page.isChecked('#hover-help').catch(() => null), sections: {}, memory: [], buttons: [], messages: [] };
const SEL = '[data-help],[data-hint],td,.tile,.bar-row,.cell,.core,.meter,.legend>span,.health-list>div,.facts>div,.mini-tiles>div,.kv,.chip';
const FIND = `(sel, scope, n) => { const els = [...document.querySelectorAll(scope)].filter(e => e.matches(sel) && e.getBoundingClientRect().width > 2 && !e.closest('#tip,#help-guide') && (e.innerText || e.dataset.hint || e.dataset.help)); const e = els[n]; if (!e) return null; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, label: e.tagName + '.' + e.className + ' | ' + (e.innerText || e.dataset.hint || '').replace(/\\s+/g, ' ').slice(0, 40) }; }`;
async function probeAt(sel, scope, n) {
  const box = await page.evaluate(`(${FIND})(${JSON.stringify(sel)}, ${JSON.stringify(scope)}, ${n})`);
  if (!box) return null;
  await page.mouse.move(2, 2); for (let k = 0; k < 20 && !(await page.evaluate(() => document.getElementById('tip').hidden)); k++) { await page.keyboard.press('Escape'); await sleep(150); }
  await page.mouse.move(box.x + Math.min(box.w / 2, 40), box.y + box.h / 2);
  await sleep(700); const early = await page.evaluate(() => !document.getElementById('tip').hidden);
  await sleep(700);
  const r = await page.evaluate(() => { const t = document.getElementById('tip'); return t.hidden ? null : { title: t.querySelector('.help-title')?.innerText, scope: t.querySelector('.help-scope')?.innerText, text: t.innerText.replace(/\s+/g, ' ').slice(0, 220) }; });
  return { label: box.label, openedBefore0_8s: early, card: r };
}
// 1. headings
for (const [name, sel] of [['Summary', '#overview h2'], ['Threads', '#threads-section h2'], ['Thread details', '#thread-details h3'], ['Pressure', '#resources h2'], ['Socket I/O', '#socket-title'], ['Memory map', '#memory-map h2'], ['Monitor', '#monitor h2']]) {
  out.sections[name] = (await probeAt('*', sel, 0)) || { label: name, error: 'selector not found: ' + sel };
  if (out.sections[name].label) out.sections[name].label = name + ' | ' + out.sections[name].label;
}
// 2. memory map: every target the helpTarget() selector would pick
const total = await page.evaluate(sel => [...document.querySelectorAll('#memory-map *')].filter(e => e.matches(sel) && e.getBoundingClientRect().width > 2 && !e.closest('#tip,#help-guide') && (e.innerText || e.dataset.hint || e.dataset.help)).length, SEL);
out.memoryCandidates = total;
for (let i = 0; i < Math.min(total, 150); i++) { const r = await probeAt(SEL, '#memory-map *', i); if (r) out.memory.push(r); }
// 3. full-width messages
for (const [name, sel] of [['Idle thread row / message', '#threads td[colspan]'], ['Socket queued data message', '#resource-sockets td[colspan]'], ['Socket I/O empty', '#socket-empty']]) {
  const r = await probeAt('*', sel, 0); out.messages.push(r ? { ...r, label: name + ' | ' + r.label } : { label: name, error: 'not present: ' + sel });
}
// 4. information buttons in Memory map: click each and read the guide
const nb = await page.locator('#memory-map .help-button').count();
for (let i = 0; i < nb; i++) {
  const b = page.locator('#memory-map .help-button').nth(i);
  try { await b.scrollIntoViewIfNeeded({ timeout: 3000 }); await page.mouse.move(2, 2); await (await b.evaluateHandle(e => e.parentElement)).asElement().hover(); await b.click({ timeout: 4000 }); } catch (e) { out.buttons.push({ i, error: String(e).slice(0, 100) }); continue; }
  await sleep(400);
  const g = await page.evaluate(() => ({ title: document.getElementById('help-guide-title').innerText, body: document.getElementById('help-guide-body').innerText.replace(/\s+/g, ' ').slice(0, 160), open: document.getElementById('help-guide').getBoundingClientRect().width > 0 }));
  out.buttons.push({ i, ...g });
  await page.click('#help-guide-close').catch(() => {}); await sleep(200);
}
// 5. keyboard focus on an information button opens the card
if (nb) { const b = page.locator('#memory-map .help-button').first(); await b.focus(); await sleep(1500); out.keyboardFocus = await page.evaluate(() => { const t = document.getElementById('tip'); return t.hidden ? null : t.querySelector('.help-title')?.innerText; }); }
out.diag = diag;
fs.writeFileSync(`${EV}/qa007-help.json`, JSON.stringify(out, null, 1));
const bad = [...Object.values(out.sections), ...out.memory, ...out.messages].filter(r => !r.card || r.card.title === 'How to read this page' || r.openedBefore0_8s);
console.log('sections', JSON.stringify(Object.fromEntries(Object.entries(out.sections).map(([k, v]) => [k, v.card?.title || v.error]))));
console.log('memory probes', out.memory.length, 'bad', bad.length); console.log(JSON.stringify(bad.slice(0, 20), null, 1));
console.log('messages', JSON.stringify(out.messages.map(m => [m.label, m.card?.title || m.error])));
console.log('buttons', out.buttons.length, 'noguide', out.buttons.filter(b => !b.open).length, 'kbd', out.keyboardFocus);
await page.screenshot({ path: `${EV}/qa007-final.png` });
await browser.close();
