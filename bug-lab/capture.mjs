// Screenshot the dashboard with headless Chromium, using only Node and the
// DevTools protocol (no npm packages).
//
//   node capture.mjs <url> <wait-seconds> <full.png> [selector=out.png ...]
//
// The tab stays open for <wait-seconds> so the dashboard's live trend charts
// fill in (they live in the browser tab, not in the collector). Then it writes
// a full-page screenshot and a text dump of the page (same name, .txt), plus one cropped screenshot per selector=file pair.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [url, waitArg, fullPath, ...crops] = process.argv.slice(2);
if (!url || !waitArg || !fullPath) {
  console.error('usage: capture.mjs <url> <wait-seconds> <full.png> [selector=out.png ...]');
  process.exit(2);
}
const waitSeconds = Number(waitArg);
if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 3600) {
  console.error('wait-seconds must be a number from 0 to 3600');
  process.exit(2);
}

const controller = new AbortController();
const interrupt = () => controller.abort();
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);

const profile = mkdtempSync(join(tmpdir(), 'bug-lab-chromium-'));
const browser = spawn(
  process.env.CHROMIUM || 'chromium',
  [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--window-size=1440,1000', 'about:blank',
  ],
  { stdio: 'ignore' },
);
let browserError;
browser.on('error', error => {browserError = error;});
let socket;

const sleep = ms => delay(ms, undefined, {signal: controller.signal});

async function connect() {
  for (let i = 0; i < 100; i++) {
    if (browserError) throw browserError;
    if (browser.exitCode !== null || browser.signalCode !== null) throw new Error('chromium exited before capture');
    try {
      const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
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
  socket = ws;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('chromium connection timed out')), 10000);
    const abort = () => finish(new Error('capture interrupted'));
    const finish = error => {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    ws.addEventListener('open', () => finish(), {once: true});
    ws.addEventListener('error', () => finish(new Error('chromium connection failed')), {once: true});
    controller.signal.addEventListener('abort', abort, {once: true});
    if (controller.signal.aborted) abort();
  });
  let next = 1;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  ws.addEventListener('close', () => {
    for (const finish of pending.values()) finish({error: {message: 'chromium connection closed'}});
    pending.clear();
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = next++;
      const abort = () => finish({error: {message: 'capture interrupted'}});
      const timer = setTimeout(() => finish({error: {message: `${method} timed out`}}), 10000);
      const finish = m => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', abort);
        pending.delete(id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      };
      pending.set(id, finish);
      controller.signal.addEventListener('abort', abort, {once: true});
      if (controller.signal.aborted) {abort(); return;}
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', {expression, returnByValue: true});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
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
  await sleep(waitSeconds * 1000);

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
  socket?.close();
  browser.kill();
  await delay(300);
  if (!browserError && browser.exitCode === null && browser.signalCode === null) {
    const closed = new Promise(resolve => browser.once('close', resolve));
    browser.kill('SIGKILL');
    await closed;
  }
  rmSync(profile, { recursive: true, force: true });
}
