import { open, save, sleep } from './lib.mjs';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
const Q = '/tmp/qa-6c3ba7cd', EV = process.env.EV;
const cases = [
 ['101','healthy'],['102','cpu-spin'],['103','cpu-oversub'],['104','cpu-throttle'],['105','yield-storm'],['106','lock-convoy'],
 ['107','deadlock'],['108','mem-leak'],['109','mem-oom'],['110','vm-bloat'],['111','fd-leak'],['112','disk-sync'],['113','major-faults'],
 ['114','tcp-slow'],['115','udp-drop'],['116','close-wait'],['117','listen-full'],['118','thread-churn'],['119','thread-leak'],['120','stopped']];
const only = process.argv.slice(2);
const sc = { 'cpu-throttle': ['systemd-run','--user','--scope','--quiet','-p','CPUQuota=50%'],
  'mem-oom': ['systemd-run','--user','--scope','--quiet','-p','MemoryHigh=160M','-p','MemoryMax=240M','-p','MemorySwapMax=0'] };
const attempts = {};
for (const [id, name] of cases) {
  if (only.length && !only.includes(id)) continue;
  const hold = name === 'thread-leak' ? 165 : 70;
  const scenario = name === 'stopped' ? 'healthy' : name;
  const dir = name === 'disk-sync' ? '/home/daksh/.cache/triangulator-qa-6c3ba7cd/scratch' : `${Q}/scratch`;
  fs.mkdirSync(dir, { recursive: true });
  const log = `${EV}/qa${id}-${name}.log`;
  const fd = fs.openSync(log, 'w');
  const pre = sc[name] || [];
  const started = new Date().toISOString();
  const child = spawn(pre[0] || `${Q}/qa6c-fixture`, [...pre.slice(1), ...(pre.length ? [`${Q}/qa6c-fixture`] : []), scenario, String(hold + 40)],
    { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, BUG_LAB_DIR: dir } });
  child.unref();
  await sleep(1500);
  const pid = Number((fs.readFileSync(log, 'utf8').match(/\(pid (\d+)/) || [])[1]);
  if (!pid) { console.log(id, 'NO PID', fs.readFileSync(log, 'utf8')); continue; }
  execSync(`TRIANGULATOR_HOME=${Q}/rt2 ${Q}/pkg2/scripts/set-target.sh ${pid}`);
  const { browser, page, diag } = await open();
  await page.goto('http://127.0.0.1:19871/');
  await sleep(3000);
  const t0 = Date.now();
  const out = { id, name, pid, started, hold, startComm: fs.existsSync(`/proc/${pid}`) };
  if (name === 'stopped') {
    await sleep(45000 - (Date.now() - t0));
    process.kill(pid, 'SIGSTOP'); out.stopAt = new Date().toISOString();
    await sleep(25000);
    await save(page, `qa${id}-${name}-stopped`, `target meta: ${await page.innerText('#target-meta')}`);
    out.stopped = { meta: await page.innerText('#target-meta'), verdict: await page.innerText('#verdict') };
    process.kill(pid, 'SIGCONT'); out.contAt = new Date().toISOString();
    await sleep(15000);
    out.resumed = { meta: await page.innerText('#target-meta'), verdict: await page.innerText('#verdict') };
    await save(page, `qa${id}-${name}-resumed`);
  } else {
    await sleep(hold * 1000 - (Date.now() - t0));
    out.alive = fs.existsSync(`/proc/${pid}`);
    out.meta = await page.innerText('#target-meta');
    await save(page, `qa${id}-${name}`, `target meta: ${out.meta}\nfixture alive at capture: ${out.alive}`);
    if (name === 'thread-churn' || name === 'thread-leak') {
      const tile = page.locator('.tile', { hasText: 'Thread churn' }).first();
      out.churnTile = (await tile.count()) ? (await tile.innerText()).replace(/\s+/g, ' ') : null;
      if (out.churnTile) { await tile.scrollIntoViewIfNeeded(); const bb = await tile.boundingBox(); await page.mouse.move(bb.x + 20, bb.y + 20); await sleep(1800);
        out.churnCard = await page.evaluate(() => { const t = document.getElementById('tip'); return t.hidden ? null : t.innerText.replace(/\s+/g, ' '); }); }
    }
    if (name === 'cpu-spin') {
      const row = page.locator('#threads tr', { hasText: 'worker-hot' }).first();
      out.hotRows = await page.locator('#threads tr', { hasText: 'worker-hot' }).count();
      if (out.hotRows) { await row.click(); await sleep(2500);
        out.drawer = await page.evaluate(() => ({title: document.getElementById('history-title').innerText, tiles: document.getElementById('drawer-tiles').innerText.replace(/\s+/g,' '), live: document.getElementById('drawer-live').innerText.replace(/\s+/g,' ').slice(0,400)}));
        await save(page, `qa${id}-${name}-drawer`); }
    }
  }
  fs.writeFileSync(`${EV}/qa${id}-diag.json`, JSON.stringify({ ...out, diag }, null, 1));
  console.log(JSON.stringify({ ...out, diag: diag.length }));
  try { process.kill(pid, 'SIGCONT'); process.kill(pid, 'SIGTERM'); } catch {}
  await browser.close();
  await sleep(4000);
}
