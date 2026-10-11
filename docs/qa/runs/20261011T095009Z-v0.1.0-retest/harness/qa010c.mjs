import { chromium } from 'playwright-core';
import fs from 'fs';
const EV = process.env.EV, SRC = 'file:///home/daksh/.t3/worktrees/triangulator/t3code-6c3ba7cd/docs/wire-format-overview.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await page.goto(SRC); await sleep(800);
const out = {};
const logText = () => page.evaluate(() => [...document.querySelectorAll('#log div')].map(d => d.innerText));
async function drop(kind, part, minTotal, afterSeq, tag) {
  for (let i = 0; i < 4000; i++) {
    const hit = await page.evaluate(([kind, part, minTotal, afterSeq]) => { const d = state.dgrams.find(d => d.kind === kind && d.part === part && d.total >= minTotal && d.seq > afterSeq && !d.lost && !d.done && (state.t - d.born) / d.flight < 0.5); return d ? { seq: d.seq, total: d.total } : null; }, [kind, part, minTotal, afterSeq]);
    if (!hit) { await sleep(60); continue; }
    await page.click('#play');
    const pos = await page.evaluate(([kind, seq, part]) => { const d = state.dgrams.find(d => d.kind === kind && d.seq === seq && d.part === part); const p = (state.t - d.born) / d.flight; const r = cv.getBoundingClientRect(); return { x: r.left + (240 + 454 * p + 23) * r.width / 1040, y: r.top + (ROWS[kind].y + 3) * r.height / 470 }; }, [kind, hit.seq, part]);
    await page.mouse.move(pos.x, pos.y); await sleep(200);
    const h = await page.evaluate(() => state.hover && { kind: state.hover.d.kind, seq: state.hover.d.seq, part: state.hover.d.part });
    if (h && h.kind === kind && h.part === part && h.seq === hit.seq) {
      await page.mouse.click(pos.x, pos.y); await page.mouse.click(pos.x, pos.y);
      await page.click('#play'); out[tag] = { ...hit, kind, part, hoverTitle: h }; return { ...hit, kind, part };
    }
    await page.click('#play');
  }
}
const lines = async (kind, seq) => (await logText()).filter(l => new RegExp(`${kind} seq ${seq}\\b`).test(l));
const asmOf = k => page.evaluate(k => ({ ...Object.fromEntries(['seq', 'total', 'flagged', 'done', 'ok', 'bad'].map(f => [f, asm[k][f]])) }), k);
let c = await drop('TRES', 0, 2, -1, 'tresSummary'); await sleep(14000);
out.tresSummaryResult = { lines: await lines('TRES', c.seq), dropLogCount: (await lines('TRES', c.seq)).filter(l => /dropped in flight/.test(l)).length, asm: await asmOf('TRES') };
c = await drop('TVMA', 0, 2, -1, 'tvmaSummary'); await sleep(16000);
out.tvmaSummaryResult = { lines: await lines('TVMA', c.seq), dropLogCount: (await lines('TVMA', c.seq)).filter(l => /dropped in flight/.test(l)).length, asm: await asmOf('TVMA') };
const prev = c.seq;
c = await drop('TVMA', 1, 2, prev, 'tvmaRegion'); await sleep(16000);
out.tvmaRegionResult = { lines: await lines('TVMA', c.seq), dropLogCount: (await lines('TVMA', c.seq)).filter(l => /dropped in flight/.test(l)).length, asm: await asmOf('TVMA') };
await page.screenshot({ path: `${EV}/qa010-drops.png` });
fs.writeFileSync(`${EV}/qa010-drops.json`, JSON.stringify(out, null, 1)); console.log(JSON.stringify(out, null, 1));
await browser.close();
