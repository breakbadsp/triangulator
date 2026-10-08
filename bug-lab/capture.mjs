// Screenshot the dashboard with headless Chromium, using only Node and the
// DevTools protocol (no npm packages).
//
//   node capture.mjs <url> <wait-seconds> <full.png> [selector=out.png ...]
//
// The tab stays open for <wait-seconds> so the dashboard's live trend charts
// fill in (they live in the browser tab, not in the collector). Then it writes
// a full-page screenshot and a text dump of the page (same name, .txt), plus one cropped screenshot per selector=file pair.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, waitArg, fullPath, ...crops] = process.argv.slice(2);
if (!url || !waitArg || !fullPath) {
  console.error('usage: capture.mjs <url> <wait-seconds> <full.png> [selector=out.png ...]');
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'bug-lab-chromium-'));
const port = 9300 + Math.floor(Math.random() * 500);
const browser = spawn(
  process.env.CHROMIUM || 'chromium',
  [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--window-size=1440,1000', 'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return new WebSocket(page.webSocketDebuggerUrl);
    } catch { /* browser still starting */ }
    await sleep(100);
  }
  throw new Error('chromium did not start');
}

try {
  const ws = await connect();
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let next = 1;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  const shoot = async (clip, path) => {
    const { data } = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true, clip: { ...clip, scale: 1 },
    });
    writeFileSync(path, Buffer.from(data, 'base64'));
  };

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', { url });
  await sleep(Number(waitArg) * 1000);

  const height = await evaluate('Math.ceil(document.documentElement.scrollHeight)');
  await shoot({ x: 0, y: 0, width: 1440, height }, fullPath);
  writeFileSync(fullPath.replace(/\.png$/, '.txt'), await evaluate('document.body.innerText'));
  for (const spec of crops) {
    const [selector, path] = spec.split('=');
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
    })()`);
    if (box) await shoot(box, path);
    else console.error(`no element for ${selector}`);
  }
  ws.close();
} finally {
  browser.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
