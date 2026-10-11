import { open, sleep } from './lib.mjs';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
const Q = '/tmp/qa-6c3ba7cd', EV = process.env.EV;
const { browser, page, diag } = await open({ width: 1280, height: 900 });
const start = (sc, secs) => { const log = `${EV}/qa018-${sc}.log`; const fd = fs.openSync(log, 'w'); const c = spawn(`${Q}/qa6c-fixture`, [sc, String(secs)], { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, BUG_LAB_DIR: `${Q}/scratch` } }); c.unref(); return c.pid; };
const target = pid => execSync(`TRIANGULATOR_HOME=${Q}/rt2 ${Q}/pkg2/scripts/set-target.sh ${pid}`);
const zoom = () => page.evaluate(() => ({ name: document.getElementById('memory-zoom-name').innerText, sub: document.getElementById('memory-zoom-sub').innerText, facts: document.getElementById('memory-zoom-facts').innerText.replace(/\n+/g, ' | '), charts: document.getElementById('memory-charts').innerText.replace(/\n+/g, ' | '), legend: [...document.querySelectorAll('#memory-grid ~ .legend > span')].map(s => s.innerText.trim()) }));
const out = { legend: [] };
const healthy = start('healthy', 400); await sleep(1200); target(healthy);
await page.goto('http://127.0.0.1:19871/#memory-map'); await sleep(12000);
out.healthyA = await zoom(); await sleep(6000); out.healthyB = await zoom();
// QA-008: each bar, compare legend vs grid colours
const n = await page.locator('#memory-amap .arow').count();
for (let i = 0; i < n; i++) {
  const row = page.locator('#memory-amap .arow').nth(i); await row.scrollIntoViewIfNeeded(); const label = (await row.innerText()).replace(/\s+/g, ' ').slice(0, 50); await row.click(); await sleep(1500);
  out.legend.push({ i, label, ...(await page.evaluate(() => { const cells = [...document.querySelectorAll('#memory-grid > *')]; const cols = new Set(); let hatched = 0, guardish = 0; cells.forEach(c => { const cs = getComputedStyle(c); if (cs.backgroundImage !== 'none') hatched++; else if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)') cols.add(cs.backgroundColor); }); const sw = [...document.querySelectorAll('#memory-grid ~ .legend > span')].map(s => [s.innerText.trim(), getComputedStyle(s.querySelector('i,.sw') || s).backgroundColor, getComputedStyle(s.querySelector('i,.sw') || s).backgroundImage !== 'none']); const swCols = new Set(sw.filter(x => !x[2]).map(x => x[1])); return { gridColours: [...cols], hatched, legend: sw, legendMatchesGrid: [...cols].every(c => swCols.has(c)) && [...swCols].every(c => cols.has(c)), notMappedListedOnlyWithGaps: sw.some(x => x[0] === 'not mapped') === (hatched > 0) }; })) });
}
// heap again for QA-018
await page.locator('#memory-amap .arow', { hasText: '[heap]' }).first().click(); await sleep(1500);
const leak = start('mem-leak', 120); out.leakPid = leak; target(leak); await sleep(1000);
const t0 = Date.now(); out.leakSamples = [];
let sawMapped = false;
for (let k = 0; k < 14; k++) { await sleep(5000); const z = await zoom(); out.leakSamples.push({ t: Math.round((Date.now() - t0) / 1000), ...z }); }
// QA-008 step 3: zoom the anonymous bar while allocation continues, watch for "Mapped since the previous layout"
await page.locator('#memory-amap .arow', { hasText: /anonymous/ }).first().click().catch(() => {});
out.mappedSince = [];
for (let k = 0; k < 20; k++) { await sleep(2500); const z = await zoom(); out.mappedSince.push({ name: z.name, legend: z.legend }); }
out.diag = diag;
fs.writeFileSync(`${EV}/qa018-observations.json`, JSON.stringify(out, null, 1));
await page.screenshot({ path: `${EV}/qa018-final.png` });
console.log(JSON.stringify({ healthyA: out.healthyA, healthyB: out.healthyB, leakFirst: out.leakSamples[0], leakLast: out.leakSamples.at(-1), bars: out.legend.map(l => [l.label, l.legendMatchesGrid, l.notMappedListedOnlyWithGaps]), mappedSince: [...new Set(out.mappedSince.flatMap(m => m.legend))] }, null, 1));
try { process.kill(healthy); process.kill(leak); } catch {}
await browser.close();
