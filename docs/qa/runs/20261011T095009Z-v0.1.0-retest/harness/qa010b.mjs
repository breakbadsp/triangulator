import { chromium } from 'playwright-core';
import fs from 'fs';
const EV = process.env.EV, SRC = 'file:///home/daksh/.t3/worktrees/triangulator/t3code-6c3ba7cd/docs/wire-format-overview.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const diag = []; page.on('pageerror', e => diag.push('pageerror ' + e.message)); page.on('console', m => { if (m.type() === 'error') diag.push('console.error ' + m.text()); });
const out = {};
await page.goto(SRC); await sleep(1000);
const setRange = (id, v) => page.$eval('#' + id, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, String(v));
const logText = () => page.evaluate(() => [...document.querySelectorAll('#log div')].map(d => d.innerText));
await setRange('speed', 3);
// thread counts: wait for the next TMON log line after the change
out.threads = {};
for (const n of [1, 10, 11, 60]) {
  const before = (await logText()).filter(l => /TMON seq/.test(l) && /splits/.test(l)).length;
  await setRange('threads', n);
  for (let i = 0; i < 60; i++) { await sleep(500); const ls = (await logText()).filter(l => /TMON seq \d+: sender splits/.test(l)); if (ls.length > before || (ls.length && /\b(\d+) datagram/.test(ls.at(-1)) && i > 20)) { out.threads[n] = ls.at(-1); break; } }
  // the log is capped at 60 lines: compare last TMON line with a fresh mark
  await sleep(100);
}
// ensure each reading is from after the change: re-read using unique marker
out.threadsFresh = {};
for (const n of [1, 10, 11, 60]) {
  await setRange('threads', n);
  const t0 = await page.evaluate(() => state.t);
  for (let i = 0; i < 80; i++) { await sleep(300);
    const r = await page.evaluate(t0 => { const ls = [...document.querySelectorAll('#log div')].map(d => d.innerText).filter(l => /TMON seq \d+: sender splits/.test(l)); const l = ls.at(-1); const m = l && l.match(/^t=([\d.]+)s/); return m && +m[1] > t0 ? l : null; }, t0);
    if (r) { out.threadsFresh[n] = r; break; } }
}
// packet loss 50%
await setRange('loss', 50); await page.evaluate(() => { logEl.innerHTML = ''; });
await sleep(60000 / 3);  // 60 sim seconds at speed 3 ~ 20 s real
out.loss50 = { lossLabel: await page.innerText('#lossv'), log: (await logText()).filter(l => /discard|incomplete|missing|loss counted|sample complete|layout updated|kept/.test(l)).slice(0, 14), counters: await page.evaluate(() => Object.fromEntries(Object.entries(asm).map(([k, a]) => [k, { ok: a.ok, bad: a.bad }]))) };
// pause / resume
await page.click('#play'); const t1 = await page.evaluate(() => state.t); await sleep(1500); const t2 = await page.evaluate(() => state.t);
const label1 = await page.innerText('#play');
await page.click('#play'); await sleep(1000); const t3 = await page.evaluate(() => state.t);
out.pause = { label1, pausedAdvance: t2 - t1, resumedAdvance: t3 - t2, label2: await page.innerText('#play') };
await page.screenshot({ path: `${EV}/qa010-loss50.png` });
// drops
await setRange('loss', 0); await setRange('speed', 1);
const box = async () => page.evaluate(() => { const r = cv.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
async function dropOne(pred, tag) {
  for (let tries = 0; tries < 3000; tries++) {
    const c = await page.evaluate(src => {
      const f = eval('(' + src + ')');
      for (const d of state.dgrams) { if (d.lost || d.done) continue; const p = (state.t - d.born) / d.flight; if (p < 0.1 || p > 0.6) continue; if (!f(d, asm)) continue;
        return { kind: d.kind, seq: d.seq, part: d.part, total: d.total, x: 240 + (740 - 240 - 46) * p + 23, y: ROWS[d.kind].y - 6 + 9 }; }
      return null; }, pred);
    if (!c) { await sleep(120); continue; }
    await page.click('#play');  // pause so the datagram holds still
    const b = await box();
    await page.mouse.move(b.l + c.x * b.w / 1040, b.t + c.y * b.h / 470); await sleep(250);
    const hovered = await page.evaluate(() => !!state.hover);
    if (!hovered) { await page.click('#play'); continue; }
    await page.mouse.click(b.l + c.x * b.w / 1040, b.t + c.y * b.h / 470);
    await page.mouse.click(b.l + c.x * b.w / 1040, b.t + c.y * b.h / 470);  // second click must not drop again
    await sleep(200);
    await page.click('#play');
    out[tag] = c; return c;
  }
}
const countDrops = async (c) => (await logText()).filter(l => l.includes(`${c.kind}</b> seq ${c.seq} part ${c.part + 1}/${c.total} dropped in flight by you`) || l.includes(`${c.kind} seq ${c.seq} part ${c.part + 1}/${c.total} dropped in flight by you`)).length;
// TRES summary
fs.writeFileSync(`${EV}/qa010-interactive.json`, JSON.stringify(out, null, 1));
const tres = await dropOne('(d)=>d.kind==="TRES"&&d.part===0', 'dropTRESsummary');
await sleep(14000);
out.tresResult = { dropLogs: await countDrops(tres), lines: (await logText()).filter(l => new RegExp(`TRES seq ${tres.seq}\\b`).test(l)) , asm: await page.evaluate(s => ({ seq: asm.TRES.seq, flagged: asm.TRES.flagged, done: asm.TRES.done, got: asm.TRES.got, ok: asm.TRES.ok, bad: asm.TRES.bad }), tres.seq) };
// TVMA summary: need a full (multi-part) sample
const tvmaS = await dropOne('(d)=>d.kind==="TVMA"&&d.part===0&&d.total>1', 'dropTVMAsummary');
await sleep(18000);
out.tvmaSummaryResult = { dropLogs: await countDrops(tvmaS), lines: (await logText()).filter(l => new RegExp(`TVMA seq ${tvmaS.seq}\\b`).test(l)), asm: await page.evaluate(() => ({ seq: asm.TVMA.seq, total: asm.TVMA.total, flagged: asm.TVMA.flagged, done: asm.TVMA.done, ok: asm.TVMA.ok, bad: asm.TVMA.bad })) };
// TVMA region part in a separate full sample
const tvmaR = await dropOne('(d)=>d.kind==="TVMA"&&d.part===1&&d.total>1&&d.seq>' + tvmaS.seq, 'dropTVMAregion');
await sleep(18000);
out.tvmaRegionResult = { dropLogs: await countDrops(tvmaR), lines: (await logText()).filter(l => new RegExp(`TVMA seq ${tvmaR.seq}\\b`).test(l)), asm: await page.evaluate(() => ({ seq: asm.TVMA.seq, total: asm.TVMA.total, flagged: asm.TVMA.flagged, done: asm.TVMA.done, ok: asm.TVMA.ok, bad: asm.TVMA.bad })) };
await page.screenshot({ path: `${EV}/qa010-drops.png` });
out.diag = diag;
fs.writeFileSync(`${EV}/qa010-interactive.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
await browser.close();
