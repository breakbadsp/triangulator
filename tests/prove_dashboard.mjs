// Run after make check: node tests/prove_dashboard.mjs. Needs Chromium and Node 24+.
// Use the real collector and an isolated fixture so CSP and embedding are tested together.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const profile = await mkdtemp(join(root, "build/dashboard-browser-"));
const server = createServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const base = `http://127.0.0.1:${port}`;
const fixture = spawn(
  "python3",
  ["tests/fleet_fixture.py", "--targets", "20", "--http-port", String(port)],
  { cwd: root, stdio: ["ignore", "ignore", "pipe"] },
);
let diagnostics = "";
fixture.stderr.on("data", (chunk) => {
  diagnostics += chunk;
});
const browser = spawn(
  process.env.CHROMIUM || "chromium",
  [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
browser.stderr.on("data", (chunk) => {
  diagnostics += chunk;
});
let socket;

async function until(check, description) {
  for (let attempt = 0; attempt < 150; ++attempt) {
    if (await check()) return;
    if (
      fixture.exitCode !== null ||
      fixture.signalCode !== null ||
      browser.exitCode !== null ||
      browser.signalCode !== null
    )
      throw new Error(`A proof process exited: ${diagnostics}`);
    await delay(100);
  }
  throw new Error(`Timed out: ${description}\n${diagnostics}`);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await exit;
  } finally {
    clearTimeout(timer);
  }
}

try {
  let debugPort;
  await until(async () => {
    try {
      debugPort = (
        await readFile(join(profile, "DevToolsActivePort"), "utf8")
      ).split("\n")[0];
      return true;
    } catch {
      return false;
    }
  }, "Chromium debugging endpoint");
  const tabs = await (
    await fetch(`http://127.0.0.1:${debugPort}/json/list`)
  ).json();
  socket = new WebSocket(
    tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl,
  );
  await once(socket, "open");
  let sequence = 0;
  const pending = new Map();
  const requests = [];
  const exceptions = [];
  let onPaused = () => undefined;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error)
          request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
      }
    }
    if (message.method === "Network.requestWillBeSent")
      requests.push(message.params.request.url);
    if (message.method === "Fetch.requestPaused") void onPaused(message.params);
    if (message.method === "Runtime.exceptionThrown")
      exceptions.push(message.params.exceptionDetails.text);
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert.equal(
      result.exceptionDetails,
      undefined,
      JSON.stringify(result.exceptionDetails),
    );
    return result.result.value;
  }
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source:
      "window.cspViolations=[];addEventListener('securitypolicyviolation',event=>window.cspViolations.push(event.violatedDirective))",
  });
  await until(async () => {
    try {
      return (await fetch(`${base}/api/targets`)).ok;
    } catch {
      return false;
    }
  }, "collector startup");
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    await readFile(join(root, "dashboard/dist/index.html")),
  );
  const csp = response.headers.get("content-security-policy");
  assert.equal(
    csp,
    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  );
  await send("Page.navigate", { url: `${base}/` });
  await until(
    () =>
      evaluate(
        "document.querySelector('#target-select')?.options.length === 21 && document.querySelectorAll('#fleet-grid > article').length === 20",
      ),
    "fleet target list and tiles",
  );
  const fleet = await evaluate(`({
    title: document.title,
    attention: [...document.querySelectorAll('#fleet-grid > article')].filter((tile) => ['critical', 'serious', 'warning'].includes(tile.dataset.level)).length,
    externalAssets: document.querySelectorAll('script[src],link[rel="stylesheet"],link[rel="modulepreload"],img').length,
    headerPosition: getComputedStyle(document.querySelector('.topbar')).position,
    tabs: document.querySelectorAll('nav.tabs').length,
    cspViolations: window.cspViolations,
  })`);
  assert.equal(
    fleet.title,
    (fleet.attention ? `(${fleet.attention}) ` : "") +
      "Targets · Thread monitor",
  );
  assert.equal(fleet.externalAssets, 0);
  assert.equal(fleet.headerPosition, "sticky");
  assert.equal(fleet.tabs, 0);
  assert.deepEqual(fleet.cspViolations, []);
  await evaluate(
    "document.querySelector('#theme').value='dark';document.querySelector('#theme').dispatchEvent(new Event('change',{bubbles:true}))",
  );
  await until(
    () => evaluate("document.documentElement.dataset.theme === 'dark'"),
    "theme change",
  );
  assert.deepEqual(
    await evaluate(
      "({saved:localStorage.getItem('triangulator:theme'),background:getComputedStyle(document.documentElement).backgroundColor})",
    ),
    { saved: "dark", background: "rgb(9, 9, 10)" },
  );
  await send("Page.bringToFront");
  await evaluate("document.querySelector('[data-help=appearance]').focus()");

  await until(
    () => evaluate("!!document.querySelector('[role=dialog]')"),
    "focused help card",
  );
  const help = await evaluate(
    "({position:getComputedStyle(document.querySelector('[role=dialog]')).position,left:document.querySelector('[role=dialog]').style.left,links:document.querySelector('[role=dialog]').querySelectorAll('a').length})",
  );
  assert.equal(help.position, "fixed");
  assert.ok(help.left.endsWith("px"));
  assert.equal(help.links, 0);
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
  });
  assert.equal(
    await evaluate("document.querySelector('[role=dialog]') === null"),
    true,
  );
  // Chromium drops focus without a blur event when a focused node moves.
  // Make the last tile serious, so React moves the tiles after it, and check
  // that the moved, focused healthy tile link keeps focus.
  const tileKeys = `[...document.querySelectorAll('#fleet-grid > article')].map((tile) => ({key: new URLSearchParams(tile.querySelector('.ft-name').getAttribute('href')).get('target'), level: tile.dataset.level}))`;
  const before = await evaluate(tileKeys);
  const focusIndex = before.findIndex((tile) => tile.level === "good");
  assert.ok(
    focusIndex >= 0 && focusIndex < before.length - 1,
    "two healthy tiles",
  );
  const focusKey = before[focusIndex].key;
  const mover = before.at(-1).key;
  await evaluate(
    `window.focusedLink = document.querySelector(${JSON.stringify(`.ft-name[href="?target=${encodeURIComponent(focusKey)}"]`)}); window.focusedLink.focus(); window.focusedTileMoved = false; new MutationObserver((records) => { for (const record of records) for (const node of record.removedNodes) if (node.contains(window.focusedLink)) window.focusedTileMoved = true; }).observe(document.querySelector('#fleet-grid'), {childList: true}); document.activeElement === window.focusedLink`,
  );
  onPaused = async ({ requestId }) => {
    const reply = await send("Fetch.getResponseBody", { requestId });
    const view = JSON.parse(
      reply.base64Encoded
        ? Buffer.from(reply.body, "base64").toString()
        : reply.body,
    );
    const main = view.threads.find((thread) => thread.tid === view.health.pid);
    view.threads = [
      { ...main, cpu_pct: 99, run_delay_pct: 0, state: "running" },
    ];
    await send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: Buffer.from(JSON.stringify(view)).toString("base64"),
    });
  };
  await send("Fetch.enable", {
    patterns: [
      {
        urlPattern: `*/api/live?target=${encodeURIComponent(mover)}`,
        requestStage: "Response",
      },
    ],
  });
  await until(async () => {
    const after = await evaluate(tileKeys);
    return (
      after.findIndex((tile) => tile.key === mover) <
      after.findIndex((tile) => tile.key === focusKey)
    );
  }, "tile reorder");
  const reorder = await evaluate(
    `({moverLevel: document.querySelector(${JSON.stringify(`.ft-name[href="?target=${encodeURIComponent(mover)}"]`)}).closest('article').dataset.level, moved: window.focusedTileMoved, focusKept: document.activeElement === window.focusedLink, connected: window.focusedLink.isConnected})`,
  );
  assert.deepEqual(reorder, {
    moverLevel: "serious",
    moved: true,
    focusKept: true,
    connected: true,
  });
  await send("Fetch.disable");
  onPaused = () => undefined;
  let target;
  await until(async () => {
    const targets = (await (await fetch(`${base}/api/targets`)).json()).targets;
    target = targets.find((entry) => entry.status === "live" && entry.pid > 0);
    return !!target;
  }, "fixture live target");
  // Drive the real select. Its change handler must navigate with location.assign.
  await evaluate(
    `document.querySelector('#target-select').value=${JSON.stringify(target.key)};document.querySelector('#target-select').dispatchEvent(new Event('change',{bubbles:true}))`,
  );
  await until(
    () =>
      evaluate(
        `new URLSearchParams(location.search).get('target') === ${JSON.stringify(target.key)} && !!document.querySelector('#target-name') && document.querySelector('#target-name').textContent !== 'Connecting…'`,
      ),
    "target navigation and live response",
  );
  const live = await (
    await fetch(
      `${base}/api/live?${new URLSearchParams({ target: target.key })}`,
    )
  ).json();
  const expectedName = live.threads.find(
    (thread) => thread.tid === live.health.pid,
  ).name;
  const selected = await evaluate(
    "({name:document.querySelector('#target-name').textContent,meta:document.querySelector('#target-meta').textContent,theme:document.documentElement.dataset.theme,cspViolations:window.cspViolations})",
  );
  assert.equal(selected.name, expectedName);
  assert.ok(selected.meta.includes(`PID ${live.health.pid}`));
  assert.equal(selected.theme, "dark");
  assert.deepEqual(selected.cspViolations, []);
  assert.ok(
    requests.some(
      (url) =>
        new URL(url).pathname === "/api/live" &&
        new URL(url).searchParams.get("target") === target.key,
    ),
  );
  assert.ok(
    requests.every(
      (url) => url === "about:blank" || new URL(url).origin === base,
    ),
  );
  assert.deepEqual(exceptions, []);
  console.log(
    JSON.stringify(
      {
        embeddedBytesEqual: true,
        csp,
        fleet,
        reorder: { focusKey, mover, ...reorder },
        theme: { saved: "dark", background: "rgb(9, 9, 10)" },
        help,
        selected,
        sameOriginRequests: true,
        runtimeExceptions: 0,
      },
      null,
      2,
    ),
  );
} finally {
  socket?.close();
  await Promise.all([stop(browser), stop(fixture)]);
  await rm(profile, { recursive: true, force: true });
}
