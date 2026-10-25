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
let controlFixture;
let controlBase;

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
  let onDialog = () => undefined;
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
    if (message.method === "Page.javascriptDialogOpening") void onDialog(message.params);
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
  const typeInto = async (selector, text) => {
    await evaluate(
      `(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.focus(); input.select(); })()`,
    );
    await send("Input.insertText", { text });
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  const chromiumVersion = (await send("Browser.getVersion")).product;
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source:
      "window.cspViolations=[];addEventListener('securitypolicyviolation',event=>window.cspViolations.push(event.violatedDirective))",
  });
  let priorProof = {};
  // Reuse prior-phase proof when only the target-control script changes.
  if (!process.argv.includes("--target-control-only") && !process.argv.includes("--replay-only")) {
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
  // Summary: the load average and trends come from this tab's live series.
  await until(
    () =>
      evaluate(
        "document.querySelector('#hero-load')?.textContent !== '—' && !!document.querySelector('#chart-load svg polygon')",
      ),
    "summary load chart",
  );
  const summary = await evaluate(`({
    tabs: [...document.querySelectorAll('nav.tabs a')].map((link) => link.textContent),
    verdict: document.querySelector('#verdict').textContent,
    heroLoad: document.querySelector('#hero-load').textContent,
    tiles: [...document.querySelectorAll('#tiles .tile .label')].map((label) => label.textContent),
    chartWidth: Number(document.querySelector('#chart-load svg').getAttribute('width')),
    hostWidth: document.querySelector('#chart-load').clientWidth,
    sub: document.querySelector('#overview-sub').textContent,
  })`);
  assert.deepEqual(summary.tabs, [
    "Timeline",
    "Summary",
    "Threads",
    "Resources",
    "Sockets",
    "Memory",
    "Monitor",
    "Settings",
  ]);
  assert.match(summary.heroLoad, /^\d+\.\d\d$/);
  assert.ok(summary.tiles.includes("Active threads"));
  // The chart is drawn at its host's measured width, not the 600 px default.
  assert.equal(summary.chartWidth, Math.max(240, summary.hostWidth));
  assert.notEqual(summary.hostWidth, 600);
  // Hover near the first sample: its time stays fixed while new samples arrive.
  const box = await evaluate(`(() => {
    const hit = document.querySelector('#chart-load rect');
    hit.scrollIntoView({ block: 'center' });
    const bounds = hit.getBoundingClientRect();
    return { x: bounds.left + 2, y: bounds.top + bounds.height / 2, width: innerWidth, height: innerHeight };
  })()`);
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: box.x,
    y: box.y,
  });
  await until(
    () => evaluate("!!document.querySelector('[role=dialog] .help-reading')"),
    "chart readout",
  );
  const readout = await evaluate(`(() => {
    const card = document.querySelector('[role=dialog]');
    return {
      title: card.getAttribute('aria-label'),
      rows: [...card.querySelectorAll('.help-reading')].map((row) => row.textContent),
      left: parseFloat(card.style.left),
      top: parseFloat(card.style.top),
      height: card.getBoundingClientRect().height,
    };
  })()`);
  assert.equal(readout.title, "Process load");
  // Stacked bands at 0 are left out, as before; the average line always has a value.
  assert.ok(
    readout.rows.some((row) => row.endsWith("1-min load average")),
    JSON.stringify(readout),
  );
  // The card opens beside the pointer, not under the chart's corner.
  assert.ok(Math.abs(readout.left - (box.x + 8)) <= 1, JSON.stringify(readout));
  assert.ok(
    Math.abs(
      readout.top -
        Math.max(12, Math.min(box.y, box.height - readout.height - 12)),
    ) <= 1,
    JSON.stringify(readout),
  );
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
  // A reload restores the series that the tab saved when the page hid.
  const since = summary.sub.match(/since (.+)\.$/)?.[1];
  assert.ok(since, summary.sub);
  await send("Page.reload");
  await until(
    () =>
      evaluate(
        `document.querySelector('#overview-sub')?.textContent.endsWith(${JSON.stringify(`since ${since}.`)}) && !!document.querySelector('#chart-load svg polygon')`,
      ),
    "series restored after reload",
  );
  const restored = await evaluate(
    "({sub: document.querySelector('#overview-sub').textContent, saved: JSON.parse(sessionStorage.getItem('triangulator:buffer:' + new URLSearchParams(location.search).get('target'))).points.length})",
  );
  assert.ok(restored.saved > 1);
  assert.ok(
    requests.some(
      (url) =>
        new URL(url).pathname === "/api/live" &&
        new URL(url).searchParams.get("target") === target.key,
    ),
  );
  // Phase 5: keep the real collector and embedded page. Override only live
  // responses for deterministic reorders and unavailable rates.
  let threadStage = 0,
    threadPolls = 0;
  onPaused = async ({ requestId }) => {
    const reply = await send("Fetch.getResponseBody", { requestId });
    const view = JSON.parse(
      reply.base64Encoded
        ? Buffer.from(reply.body, "base64").toString()
        : reply.body,
    );
    threadPolls++;
    const tick = live.health.last_seen + threadPolls * 10 + 100;
    view.health.session = "999999";
    view.health.last_seen = tick;
    view.groups = { main: 40 };
    view.threads = Array.from({ length: 40 }, (_, index) => ({
      tid: 7001 + index,
      generation: 1,
      name:
        index === 0
          ? "zulu"
          : index === 1
            ? "alpha"
            : `worker-${String(index).padStart(2, "0")}`,
      group: "main",
      state: threadStage >= 4 && index >= 20 ? "futex" : "running",
      wchan:
        threadStage >= 4 && index >= 20
          ? threadStage === 4
            ? "futex_wait"
            : "do_epoll_wait"
          : "",
      state_mix:
        threadStage >= 4 && index >= 20 ? { futex: 20 } : { running: 20 },
      cpu_pct:
        index === 0
          ? threadStage === 2
            ? null
            : threadStage === 3
              ? 55
              : threadStage === 0
                ? 90
                : 0
          : index === 1
            ? threadStage === 1
              ? 990
              : 1
            : 1,
      run_delay_pct: 0,
      switches_per_s: 10,
      read_bps: 2048,
      write_bps: 4096,
      major_faults_per_s: 0,
      cpu: index % 4,
      last_sample: tick,
    }));
    await send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: Buffer.from(JSON.stringify(view)).toString("base64"),
    });
  };
  await send("Fetch.enable", {
    patterns: [{ urlPattern: "*/api/live?*", requestStage: "Response" }],
  });
  await until(
    () =>
      evaluate(
        "document.querySelectorAll('#threads tr[data-tid]').length === 40",
      ),
    "40 thread rows",
  );
  async function escapeHelp() {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
    });
    await evaluate("document.activeElement?.blur()");
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
    await delay(300);
  }
  async function hover(selector) {
    const point = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      node.scrollIntoView({ block: 'center' });
      const b = node.getBoundingClientRect(); return { x: b.left + Math.min(10, b.width / 2), y: b.top + b.height / 2 };
    })()`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  }
  const mapOrder =
    "[...document.querySelectorAll('#mosaic [data-tid]')].map(node => node.dataset.tid)";
  await evaluate("document.querySelector('[data-map-window=\"300\"]').click()");
  await escapeHelp();
  await hover('#mosaic [data-tid="7001"]');
  await until(
    () => evaluate("!!document.querySelector('[role=dialog] .help-readout')"),
    "averaged map card",
  );
  const heldMap = await evaluate(mapOrder);
  const heldText = await evaluate(
    "document.querySelector('[role=dialog]').textContent",
  );
  await hover('[role="dialog"]');
  const pollsBefore = threadPolls;
  threadStage = 1;
  await until(
    () => threadPolls >= pollsBefore + 2,
    "map reorder polls while inside card",
  );
  assert.deepEqual(await evaluate(mapOrder), heldMap);
  assert.equal(
    await evaluate("document.querySelector('[role=dialog]').textContent"),
    heldText,
  );
  await escapeHelp();
  await until(
    async () => (await evaluate(mapOrder))[0] === "7002",
    "latest averaged order after leaving card",
  );
  // One row, two columns with one topic: the second card must show Write/s.
  const readCell = '#threads [data-tid="7001"] td:nth-child(8)';
  const writeCell = '#threads [data-tid="7001"] td:nth-child(9)';
  await hover(readCell);
  await until(
    () =>
      evaluate(
        "document.querySelector('[role=dialog] .help-readout')?.textContent.includes('Read/s')",
      ),
    "Read/s card",
  );
  const readText = await evaluate(
    "document.querySelector('[role=dialog] .help-readout').textContent",
  );
  assert.ok(readText.includes("2.0 KB"));
  await hover(writeCell);
  await until(
    () =>
      evaluate(
        "document.querySelector('[role=dialog] .help-readout')?.textContent.includes('Write/s')",
      ),
    "Write/s card",
  );
  assert.ok(
    await evaluate(
      "document.querySelector('[role=dialog] .help-readout').textContent.includes('4.0 KB')",
    ),
  );
  await escapeHelp();
  // A null rate remains unavailable in its card across a new poll.
  threadStage = 2;
  await until(
    () =>
      evaluate(
        "document.querySelector('#threads [data-tid=\"7001\"] td:nth-child(5)').textContent.includes('—')",
      ),
    "missing CPU rate",
  );
  await hover('#threads [data-tid="7001"] td:nth-child(5)');
  await until(
    () =>
      evaluate(
        "document.querySelector('[role=dialog] .help-readout')?.textContent.includes('Not available')",
      ),
    "unavailable CPU card",
  );
  const heldTable = await evaluate(
    "document.querySelector('#threads').textContent",
  );
  await hover('[role="dialog"]');
  threadStage = 3;
  const tablePoll = threadPolls;
  await until(() => threadPolls > tablePoll, "table poll inside card");
  assert.equal(
    await evaluate("document.querySelector('#threads').textContent"),
    heldTable,
  );
  assert.ok(
    await evaluate(
      "document.querySelector('[role=dialog] .help-readout').textContent.includes('Not available')",
    ),
  );
  await escapeHelp();
  await until(
    () =>
      evaluate(
        "document.querySelector('#threads [data-tid=\"7001\"] td:nth-child(5)').textContent.includes('55.0%')",
      ),
    "table resumes after card",
  );
  // Reorder the DOM while the row has focus; keep its scroll container.
  await evaluate(`window.threadRow = document.querySelector('#threads [data-tid="7001"]'); window.threadRow.focus();
    window.threadScroller = window.threadRow.closest('.table-wrap'); window.threadScroller.scrollTop = 100;
    window.threadScroll = window.threadScroller.scrollTop; document.querySelector('th[data-sort="name"]').click()`);
  const threadFocus =
    await evaluate(`({ kept: document.activeElement === window.threadRow,
    connected: window.threadRow.isConnected, scroll: window.threadScroller.scrollTop, before: window.threadScroll,
    last: document.querySelector('#threads tr:last-child').dataset.tid })`);
  assert.equal(threadFocus.kept, true);
  assert.equal(threadFocus.connected, true);
  assert.equal(threadFocus.scroll, threadFocus.before);
  assert.ok(threadFocus.before > 0);
  assert.equal(threadFocus.last, "7001");
  const focusPoll = threadPolls;
  await until(() => threadPolls > focusPoll, "focused row poll");
  assert.ok(
    await evaluate(
      "document.activeElement === window.threadRow && window.threadScroller.scrollTop === window.threadScroll",
    ),
  );
  await escapeHelp();
  // A wait-channel readout holds its bars through a poll and card entry.
  threadStage = 4;
  await until(
    () =>
      evaluate(
        "document.querySelector('#wchan-bars .name')?.textContent === 'futex_wait'",
      ),
    "wait channel bars",
  );
  await hover("#wchan-bars .bar-row");
  await until(
    () =>
      evaluate(
        "document.querySelector('[role=dialog] .help-readout')?.textContent.includes('futex_wait')",
      ),
    "wait channel readout",
  );
  const waitingBars = await evaluate(
    "document.querySelector('#wchan-bars').textContent",
  );
  await hover('[role="dialog"]');
  threadStage = 5;
  const waitingPoll = threadPolls;
  await until(() => threadPolls > waitingPoll, "wait channel poll inside card");
  assert.equal(
    await evaluate("document.querySelector('#wchan-bars').textContent"),
    waitingBars,
  );
  await escapeHelp();
  await until(
    () =>
      evaluate(
        "document.querySelector('#wchan-bars .name')?.textContent === 'do_epoll_wait'",
      ),
    "wait channels resume",
  );
  await evaluate("document.querySelector('#wchan-bars .bar-row').click()");
  assert.equal(
    await evaluate(
      "document.querySelector('[data-activity=all]').getAttribute('aria-pressed')",
    ),
    "true",
  );
  assert.equal(
    await evaluate("document.querySelectorAll('#threads tr[data-tid]').length"),
    20,
  );
  await evaluate(
    "document.querySelector('#clear-filters').click();document.querySelector('#family-bars .bar-row').click()",
  );
  assert.equal(
    await evaluate("document.querySelector('#search').value"),
    "worker",
  );
  assert.equal(
    await evaluate("document.querySelectorAll('#threads tr[data-tid]').length"),
    38,
  );
  await evaluate(
    "document.querySelector('#clear-filters').click();document.querySelector('[data-fold=cores] > summary').click()",
  );
  await escapeHelp();
  assert.equal(
    await evaluate("document.querySelectorAll('#cores .core').length"),
    4,
  );
  // Check each Threads topic with real focus. The metric topics retain their
  // source descriptions. Column labels reuse those topics.
  const threadHelp = [];
  for (const topic of [
    "states",
    "wchan",
    "map",
    "families",
    "cores",
    "thread",
    "group",
    "mix",
    "cpu",
    "delay",
    "switches",
    "sysio",
    "faults",
    "active",
  ]) {
    await escapeHelp();
    await evaluate(
      `(() => { const node = document.querySelector('#threads-section [data-help="${topic}"]'); node.scrollIntoView({block:'center'}); node.focus(); })()`,
    );
    await until(
      () => evaluate("!!document.querySelector('[role=dialog] h2')"),
      `help for ${topic}`,
    );
    const text = await evaluate(
      "document.querySelector('[role=dialog]').textContent",
    );
    assert.ok(text.includes("Limits."), topic);
    threadHelp.push(topic);
  }
  await escapeHelp();

  await evaluate(
    "document.querySelector('#threads [data-tid=\"7001\"]').click()",
  );
  await until(
    () =>
      evaluate(
        "!!document.querySelector('#drawer.open') && document.querySelector('#history-note').textContent !== 'Loading…'",
      ),
    "thread drawer and real history response",
  );
  assert.equal(await evaluate("location.hash"), "#thread=7001");
  // Keep History focused while an earlier Help instance has a pending hover.
  await evaluate(
    "document.querySelector('#history [data-help=history]').focus()",
  );
  await delay(300);
  assert.deepEqual(
    await evaluate(
      "[...document.querySelectorAll('.help-card h2')].map(node => node.textContent)",
    ),
    ["History"],
  );
  await hover("#drawer-close");
  await until(
    () => evaluate("document.querySelector('#drawer-close').matches(':hover')"),
    "Close thread details receives the hover",
  );
  assert.deepEqual(
    await evaluate(
      "[...document.querySelectorAll('.help-card h2')].map(node => node.textContent)",
    ),
    ["History"],
    "Escape precedes the Close thread details dwell",
  );
  assert.equal(
    await evaluate("document.activeElement.dataset.help"),
    "history",
  );
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
  });
  assert.equal(
    await evaluate("document.querySelectorAll('.help-card').length"),
    0,
    "Escape dismisses focused History help despite an earlier pending hover",
  );
  assert.equal(
    await evaluate("!!document.querySelector('#drawer.open')"),
    true,
  );
  await delay(1300);
  assert.deepEqual(
    await evaluate(
      "[...document.querySelectorAll('.help-card h2')].map(node => node.textContent)",
    ),
    [],
    "Escape cancels pending help without reopening the focused card",
  );
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
  });
  assert.equal(
    await evaluate("!!document.querySelector('#drawer.open')"),
    false,
  );
  await evaluate(
    "document.querySelector('#threads [data-tid=\"7001\"]').click()",
  );
  await until(
    () =>
      evaluate(
        "!!document.querySelector('#drawer.open') && document.querySelector('#history-note').textContent !== 'Loading…'",
      ),
    "reopened drawer after two Escape presses",
  );
  await evaluate(`(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (const [id, value] of [['from', '2026-10-23T10:00'], ['to', '2026-10-23T10:15']]) {
      const node = document.getElementById(id); setter.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.querySelector('#load-history').click(); document.querySelector('#history details').open = true;
  })()`);
  await until(
    () =>
      evaluate(
        "document.querySelector('#history-note').textContent.includes('2026-10-23 10:00')",
      ),
    "custom range history response",
  );
  await evaluate(
    "document.querySelector('#drawer-close').click();document.querySelector('#threads [data-tid=\"7002\"]').click()",
  );
  await until(
    () =>
      evaluate(
        "location.hash === '#thread=7002' && document.querySelector('#history-note').textContent.includes('2026-10-23 10:00')",
      ),
    "custom range on second thread",
  );
  const historyRange = await evaluate(
    `({from: document.querySelector('#from').value, to: document.querySelector('#to').value, tableOpen: document.querySelector('#history details').open})`,
  );
  assert.deepEqual(historyRange, {
    from: "2026-10-23T10:00",
    to: "2026-10-23T10:15",
    tableOpen: true,
  });
  await evaluate("document.querySelector('#drawer-close').click()");
  assert.equal(
    await evaluate("new URLSearchParams(location.search).get('target')"),
    target.key,
  );
  assert.equal(await evaluate("location.hash"), "");
  await delay(350);
  assert.equal(
    await evaluate("document.querySelectorAll('[role=dialog]').length"),
    0,
    "closing the drawer dismisses its help",
  );
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "/",
    code: "Slash",
  });
  assert.equal(await evaluate("document.activeElement.id"), "search");
  await send("Fetch.disable");
  onPaused = () => undefined;
  // Phase 6: Resources and Socket I/O on the real collector and page. The
  // first socket request reaches the collector; the fixture has no observer.
  await until(
    () =>
      requests.some(
        (url) =>
          new URL(url).pathname === "/api/socket-io" &&
          new URL(url).searchParams.get("pid") === String(live.health.pid) &&
          new URL(url).searchParams.get("target") === target.key,
      ),
    "socket report request for the selected target",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('#socket-panel #socket-status')?.textContent === 'Not available'",
      ),
    "real collector socket answer",
  );
  const socketEntry = await evaluate(`({
    panel: !!document.querySelector('section#socket-panel'),
    empty: document.querySelector('#socket-empty').textContent,
    tabs: [...document.querySelectorAll('nav.tabs a')].map((link) => link.textContent),
    resourcesEmpty: document.querySelector('#resources-empty')?.textContent,
  })`);
  assert.equal(socketEntry.panel, true);
  assert.ok(socketEntry.empty.length > 0, JSON.stringify(socketEntry));
  assert.deepEqual(socketEntry.tabs, [
    "Timeline",
    "Summary",
    "Threads",
    "Resources",
    "Sockets",
    "Memory",
    "Monitor",
    "Settings",
  ]);
  // From here the test answers live and socket requests, so every state is
  // deterministic. Resource history still comes from the collector.
  let liveSession = "600001",
    resourceTick = 0,
    netActive = false,
    socketPolls = 0,
    socketBody = null,
    holdSocket = false;
  const heldSockets = [];
  const socketValues = (total, current = 5) => ({
    total,
    current,
    average: 2,
    minimum: 0,
    maximum: 9,
  });
  const socketRow = (tid, name, kindId, total, start = "1") => ({
    tid,
    name,
    thread_start: start,
    kind: kindId === 6 ? "Application marker" : "TCP IPv4",
    kind_id: kindId,
    metrics: {
      input: socketValues(total),
      output: socketValues("0", 0),
      messages: socketValues(kindId === 6 ? total : "0"),
    },
  });
  const socketReport = (extra = {}) => ({
    available: true,
    observer: "900",
    pid: live.health.pid,
    process_start: "800",
    messages_enabled: true,
    stale: false,
    stopped: false,
    losses: "0",
    lower_bound: false,
    duration: 60,
    updated: Date.now() / 1000,
    gaps: 0,
    truncated: false,
    rate_windows: 10,
    coverage: "Observed socket paths only.",
    totals: {
      input: socketValues("4096", null),
      output: socketValues("0", 0),
      messages: socketValues("3"),
    },
    rows: [
      socketRow(43, "reader", 1, "1024"),
      socketRow(43, "reader", 1, "3072", "2"),
      socketRow(45, "worker", 6, "3"),
      ...Array.from({ length: 40 }, (_, index) =>
        socketRow(100 + index, `pool-${String(index)}`, 1, String(index)),
      ),
    ],
    history: [
      { ts: Date.now() / 1000 - 2, input: 10, output: 0, messages: null },
      { ts: Date.now() / 1000 - 1, input: null, output: 0, messages: null },
    ],
    ...extra,
  });
  socketBody = socketReport();
  const resourceSample = () => ({
    available: true,
    session: liveSession,
    pid: live.health.pid,
    sequence: ++resourceTick,
    interval_s: 2,
    updated: Date.now() / 1000,
    pressure: {
      cgroup: { cpu: { some: { pct: 1 } } },
      host: { cpu: { some: { pct: 30 } } },
    },
    sockets: {
      tcp: { sockets: 40, rx_queue: 10, tx_queue: 0 },
      udp: { sockets: 0, rx_queue: 0, tx_queue: 0 },
      unix: { sockets: 0, rx_queue: 0, tx_queue: 0 },
      top: Array.from({ length: 40 }, (_, index) => ({
        fd: 10 + index,
        inode: 5000 + index,
        kind: "tcp4",
        state: "ESTAB",
        listener: false,
        local: `127.0.0.1:${String(4000 + index)}`,
        remote: "127.0.0.1:9",
        rx_queue: 100 + index,
        tx_queue: 0,
        rx_fill_pct: 20,
      })),
      matched: 40,
      complete: true,
    },
    network: {
      listen_drops: { delta: 0, per_s: 0, total: 9 },
      tcp_timeouts: netActive
        ? { delta: 3, per_s: 1.5, total: 7 + resourceTick }
        : { delta: 0, per_s: 0, total: 4 },
    },
  });
  onPaused = async ({ requestId, request }) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/socket-io") {
      socketPolls++;
      if (holdSocket) {
        holdSocket = false;
        heldSockets.push(requestId);
        return;
      }
      const reply =
        typeof socketBody === "number"
          ? { status: socketBody, body: { error: "not found" } }
          : { status: 200, body: socketBody };
      await send("Fetch.fulfillRequest", {
        requestId,
        responseCode: reply.status,
        responseHeaders: [{ name: "Content-Type", value: "application/json" }],
        body: Buffer.from(JSON.stringify(reply.body)).toString("base64"),
      });
      return;
    }
    const reply = await send("Fetch.getResponseBody", { requestId });
    const view = JSON.parse(
      reply.base64Encoded
        ? Buffer.from(reply.body, "base64").toString()
        : reply.body,
    );
    view.health.session = liveSession;
    view.resources = resourceSample();
    await send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: Buffer.from(JSON.stringify(view)).toString("base64"),
    });
  };
  await send("Fetch.enable", {
    patterns: [
      { urlPattern: "*/api/live?*", requestStage: "Response" },
      { urlPattern: "*/api/socket-io?*", requestStage: "Request" },
    ],
  });
  const socketPoll = async (description) => {
    const before = socketPolls;
    await until(() => socketPolls > before + 1, description);
    await delay(100);
  };
  await until(
    () =>
      evaluate(
        "!!document.querySelector('[data-socket-metric=\"messages\"]') && !!document.querySelector('#resource-tiles .tile')",
      ),
    "available socket report and resource sample",
  );
  const rowIds =
    "[...document.querySelectorAll('#socket-rows tr[data-row]')].map((row) => row.dataset.row)";
  const card = (title) =>
    `[...document.querySelectorAll('#socket-cards .tile')].find((tile) => tile.querySelector('.label').textContent === ${JSON.stringify(title)}).querySelector('.value').textContent`;
  const sockets = {
    messagesOffered: true,
    unknownCurrent: await evaluate(card("Current rate")),
    generations: (await evaluate(rowIds)).filter((id) =>
      id.startsWith("900|800|43|"),
    ),
  };
  assert.equal(sockets.unknownCurrent, "—");
  assert.deepEqual(sockets.generations, ["900|800|43|2|1", "900|800|43|1|1"]);
  await evaluate(
    "document.querySelector('[data-socket-metric=\"output\"]').click()",
  );
  sockets.measuredZero = await evaluate(card("Current rate"));
  assert.equal(sockets.measuredZero, "0 B /s");
  await evaluate(
    "document.querySelector('[data-socket-metric=\"messages\"]').click()",
  );
  sockets.messages = await evaluate(
    `({kindDisabled: document.querySelector('#socket-kind').disabled, rows: ${rowIds}})`,
  );
  assert.deepEqual(sockets.messages, {
    kindDisabled: true,
    rows: ["900|800|45|1|6"],
  });
  await evaluate(
    "document.querySelector('[data-socket-metric=\"input\"]').click()",
  );
  // Focus and scroll survive polls; a filter starts the table at its top.
  await evaluate(
    "document.querySelector('#socket-rows').closest('.table-wrap').scrollTop = 120; document.querySelector('#socket-search').focus()",
  );
  await socketPoll("socket polls with focus and scroll");
  sockets.focusAndScroll = await evaluate(
    "({focus: document.activeElement.id, scroll: document.querySelector('#socket-rows').closest('.table-wrap').scrollTop})",
  );
  assert.deepEqual(sockets.focusAndScroll, {
    focus: "socket-search",
    scroll: 120,
  });
  await send("Input.insertText", { text: "pool-3" });
  sockets.filtered = await evaluate(
    `({focus: document.activeElement.id, scroll: document.querySelector('#socket-rows').closest('.table-wrap').scrollTop, rows: ${rowIds}.length})`,
  );
  assert.deepEqual(sockets.filtered, {
    focus: "socket-search",
    scroll: 0,
    rows: 11,
  });
  await evaluate(`(() => {
    const node = document.querySelector('#socket-search');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, '');
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.blur();
  })()`);
  // Observer states, each from a fresh report.
  sockets.states = {};
  for (const [name, body] of [
    ["silent", socketReport({ stale: true })],
    ["ended", socketReport({ stopped: true })],
    ["lowerBound", socketReport({ lower_bound: true, losses: "12" })],
    ["cached", socketReport({ refresh_error: true })],
    ["unavailable", { available: false, reason: "No socket observations." }],
    ["noEndpoint", 404],
  ]) {
    socketBody = body;
    await socketPoll(`socket state ${name}`);
    sockets.states[name] = await evaluate(
      "[document.querySelector('#socket-status').textContent, document.querySelector('#socket-empty')?.textContent ?? '']",
    );
  }
  assert.deepEqual(sockets.states, {
    silent: ["Observer silent", ""],
    ended: ["Observation ended", ""],
    lowerBound: ["Incomplete · lower-bound totals", ""],
    cached: ["Report refresh failed · cached", ""],
    unavailable: ["Not available", "No socket observations."],
    noEndpoint: [
      "Not available",
      "This collector does not support socket observations. Use the C++ collector.",
    ],
  });
  socketBody = socketReport();
  await until(
    () => evaluate("!!document.querySelector('#socket-rows tr[data-row]')"),
    "socket rows again",
  );
  // A held row keeps its readout across polls; Escape dismisses it.
  await escapeHelp();
  await hover('#socket-rows tr[data-row="900|800|43|2|1"] td:nth-child(3)');
  await until(
    () => evaluate("!!document.querySelector('[role=dialog] .help-readout')"),
    "socket total readout",
  );
  const heldCard = await evaluate(
    "document.querySelector('[role=dialog]').textContent",
  );
  socketBody = socketReport({ rows: [socketRow(46, "fresh", 1, "1")] });
  await socketPoll("polls under a held socket row");
  sockets.held = await evaluate(
    `({rows: ${rowIds}.length, card: document.querySelector('[role=dialog]')?.textContent})`,
  );
  assert.equal(sockets.held.rows, 42);
  assert.equal(sockets.held.card, heldCard);
  assert.ok(heldCard.includes("3072"), heldCard);
  // A process restart while the row is held drops the old rows at once,
  // and a late answer for the old session never shows.
  holdSocket = true;
  await until(() => heldSockets.length === 1, "pending old-session report");
  socketBody = socketReport({
    observer: "901",
    process_start: "801",
    rows: [socketRow(47, "restarted", 1, "1")],
  });
  liveSession = "600002";
  await until(
    () => evaluate(`JSON.stringify(${rowIds}) === '["901|801|47|1|1"]'`),
    "new session report",
  );
  try {
    await send("Fetch.fulfillRequest", {
      requestId: heldSockets[0],
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: Buffer.from(JSON.stringify(socketReport())).toString("base64"),
    });
  } catch {
    // The page already aborted the old request.
  }
  await delay(300);
  sockets.restart = await evaluate(
    `({rows: ${rowIds}, scope: document.querySelector('#socket-scope').textContent, oldCards: [...document.querySelectorAll('.help-card')].filter((node) => node.textContent.includes('3072')).length})`,
  );
  assert.deepEqual(sockets.restart.rows, ["901|801|47|1|1"]);
  assert.ok(
    sockets.restart.scope.endsWith("observer 901"),
    sockets.restart.scope,
  );
  assert.equal(sockets.restart.oldCards, 0);
  await hover('#socket-rows tr[data-row="901|801|47|1|1"] td:nth-child(3)');
  await until(
    () => evaluate("!!document.querySelector('[role=dialog] .help-readout')"),
    "readout after restart",
  );
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
  });
  sockets.escape = await evaluate(
    "document.querySelectorAll('.help-card').length",
  );
  assert.equal(sockets.escape, 0);
  await escapeHelp();

  // Resources: the range refreshes at once, scoped to the selected target.
  await evaluate("document.querySelector('[data-res-range=\"3600\"]').click()");
  await until(
    () =>
      requests.some((url) => {
        const query = new URL(url).searchParams;
        return (
          new URL(url).pathname === "/api/resources" &&
          query.get("target") === target.key &&
          Number(query.get("end")) - Number(query.get("start")) === 3600
        );
      }),
    "1 h resource history request",
  );
  const resources = {
    range: await evaluate(
      "document.querySelector('[data-res-range=\"3600\"]').getAttribute('aria-pressed')",
    ),
  };
  assert.equal(resources.range, "true");
  // The click focused the range control and opened its help.
  await escapeHelp();
  // A held counter table keeps its order; release shows the active first.
  await evaluate(
    "document.querySelector('details[data-fold=\"netstack\"]').open || document.querySelector('details[data-fold=\"netstack\"] summary').click()",
  );
  const counterOrder =
    "[...document.querySelectorAll('#netstack tr[data-counter]')].map((row) => row.dataset.counter)";
  // Opening the fold slides it open for 0.2 s; hover after it settles.
  await delay(500);
  await hover('#netstack tr[data-counter="tcp_timeouts"] td:nth-child(4)');
  await until(
    () => evaluate("!!document.querySelector('[role=dialog] .help-readout')"),
    "network counter readout",
  );
  resources.counterCard = await evaluate(
    "document.querySelector('[role=dialog] h2').textContent",
  );
  assert.equal(resources.counterCard, "Retransmission timeouts");
  const heldTotal = await evaluate(
    "document.querySelector('[role=dialog] .help-readout').textContent",
  );
  netActive = true;
  const tick = resourceTick;
  await until(() => resourceTick > tick + 2, "live polls under the counters");
  resources.held = await evaluate(
    `({order: ${counterOrder}, readout: document.querySelector('[role=dialog] .help-readout')?.textContent})`,
  );
  assert.deepEqual(resources.held.order, ["listen_drops", "tcp_timeouts"]);
  assert.equal(resources.held.readout, heldTotal);
  await escapeHelp();
  await until(
    () => evaluate(`${counterOrder}[0] === 'tcp_timeouts'`),
    "active counter first after release",
  );
  // The busy filter keeps focus and starts its table at the top.
  await evaluate(
    "document.querySelector('#resource-sockets').closest('.table-wrap').scrollTop = 150; document.querySelector('#sockets-busy-only').focus()",
  );
  await delay(1200);
  resources.busyBefore = await evaluate(
    "({focus: document.activeElement.id, scroll: document.querySelector('#resource-sockets').closest('.table-wrap').scrollTop})",
  );
  assert.deepEqual(resources.busyBefore, {
    focus: "sockets-busy-only",
    scroll: 150,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: " ",
    code: "Space",
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: " ",
    code: "Space",
  });
  resources.busyAfter = await evaluate(
    "({focus: document.activeElement.id, checked: document.querySelector('#sockets-busy-only').checked, scroll: document.querySelector('#resource-sockets').closest('.table-wrap').scrollTop, count: document.querySelector('#resource-socket-count').textContent})",
  );
  assert.deepEqual(resources.busyAfter, {
    focus: "sockets-busy-only",
    checked: false,
    scroll: 0,
    count: "(40 of 40 reported)",
  });
  // Help: every label of both sections opens a registered topic.
  resources.help = [];
  for (const topic of [
    "pressure",
    "limits",
    "queues",
    "netdrops",
    "recvq",
    "coverage",
    "socketio",
    "rates",
    "sockettotal",
    "messages",
  ]) {
    await escapeHelp();
    await evaluate(
      `(() => { const node = document.querySelector('#resources [data-help="${topic}"], #socket-panel [data-help="${topic}"]'); node.scrollIntoView({block:'center'}); node.focus(); })()`,
    );
    await until(
      () => evaluate("!!document.querySelector('[role=dialog] h2')"),
      `help for ${topic}`,
    );
    assert.ok(
      (
        await evaluate("document.querySelector('[role=dialog]').textContent")
      ).includes("Limits."),
      topic,
    );
    resources.help.push(topic);
  }
  await escapeHelp();
  await send("Fetch.disable");
  onPaused = () => undefined;
  // Phase 7: Memory map on the real collector and page. The fixture sends
  // no memory samples, so the first answer is the collector's own reason.
  await until(
    () =>
      evaluate(
        `document.querySelector('#memory-empty')?.textContent === ${JSON.stringify(live.memory.reason)}`,
      ),
    "real collector memory reason",
  );
  // From here the test answers the live memory fields and /api/memory-map,
  // so each process is deterministic.
  let memSession = "800001",
    memPid = live.health.pid,
    memSeq = 1,
    memComm = "oldproc",
    holdLayout = false;
  const memoryRequests = [],
    heldLayouts = [];
  const memoryLayout = () => ({
    available: true,
    id: `${memSession}:${String(memSeq)}`,
    pid: memPid,
    updated: Date.now() / 1000,
    flags: {},
    regions: [
      ["0x7ffc00000000", 0x21000, "stack", "rw-p", ""],
      ["0x555500400000", 0x100000, "heap", "rw-p", ""],
      ["0x555500000000", 0x200000, "file", "r-xp", `/usr/bin/${memComm}`],
    ].map(([start, size, kind, permissions, name]) => ({
      start,
      end: "0x" + (BigInt(start) + BigInt(size)).toString(16),
      size,
      vmas: 1,
      kind,
      permissions,
      name,
    })),
  });
  const answer = (requestId, body) =>
    send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: Buffer.from(JSON.stringify(body)).toString("base64"),
    });
  onPaused = async ({ requestId, request }) => {
    if (new URL(request.url).pathname === "/api/memory-map") {
      memoryRequests.push(request.url);
      if (holdLayout) heldLayouts.push({ requestId, body: memoryLayout() });
      else await answer(requestId, memoryLayout());
      return;
    }
    const reply = await send("Fetch.getResponseBody", { requestId });
    const view = JSON.parse(
      reply.base64Encoded
        ? Buffer.from(reply.body, "base64").toString()
        : reply.body,
    );
    view.health.session = memSession;
    view.health.pid = memPid;
    view.threads = [
      ...view.threads.filter((thread) => thread.tid !== memPid),
      { ...view.threads[0], tid: memPid, name: memComm },
    ];
    view.memory = {
      available: true,
      stale: false,
      pid: memPid,
      updated: Date.now() / 1000,
      interval_s: 30,
      flags: {},
      layout_id: `${memSession}:${String(memSeq)}`,
      values: {
        vm_size_bytes: 2 ** 30,
        vma_count: 3,
        max_map_count: 65530,
        stack_limit_bytes: 8 << 20,
        major_faults: 1,
        minor_faults: 2,
      },
    };
    await answer(requestId, view);
  };
  await send("Fetch.enable", {
    patterns: [
      { urlPattern: "*/api/live?*", requestStage: "Response" },
      { urlPattern: "*/api/memory-map*", requestStage: "Request" },
    ],
  });
  const barNames = () =>
    evaluate(
      "[...document.querySelectorAll('#memory-amap .arow .name')].map((node) => node.textContent)",
    );
  const memoryText = () =>
    evaluate(
      "document.querySelector('#memory-map').textContent + [...document.querySelectorAll('[role=dialog]')].map((node) => node.textContent).join('')",
    );
  await until(
    async () => (await barNames()).includes("oldproc (program image)"),
    "memory bars of the first process",
  );
  const memory = {
    layoutRequestTarget: new URL(memoryRequests[0]).searchParams.get("target"),
  };
  assert.equal(memory.layoutRequestTarget, target.key);
  // A layout is fetched once: polls that name the same layout send nothing.
  const requestsBefore = memoryRequests.length;
  await delay(2500);
  memory.requestsDuringSameLayout = memoryRequests.length - requestsBefore;
  assert.equal(memory.requestsDuringSameLayout, 0);
  // Open the fold and Member regions with clicks, as a person does.
  await evaluate(
    "(() => { const fold = document.querySelector('#memory-map details[data-fold]'); if (!fold.open) fold.querySelector('summary').click(); })()",
  );
  await until(
    () => evaluate("document.querySelector('#memory-map details[data-fold]').open"),
    "memory fold open",
  );
  await evaluate("document.querySelector('#memory-regions-summary').click()");
  await until(
    () => evaluate("document.querySelector('#memory-region-details').open"),
    "member regions open",
  );
  const disclosures = () =>
    evaluate(
      "[document.querySelector('#memory-map details[data-fold]').open, document.querySelector('#memory-region-details').open]",
    );
  // Hold the pointer on the program bar: its readout card opens, stays
  // inside the viewport, and keeps its readout through polls.
  const programBar = "#memory-amap button:last-of-type";
  await escapeHelp();
  await hover(programBar);
  await until(
    () =>
      evaluate(
        "[...document.querySelectorAll('[role=dialog]')].some((node) => node.textContent.includes('oldproc (program image)'))",
      ),
    "bar readout card",
  );
  const barCard = () =>
    evaluate(`(() => { const node = [...document.querySelectorAll('[role=dialog]')].find((item) => item.textContent.includes('oldproc (program image)')); if (!node) return null; const b = node.getBoundingClientRect(); return { id: node.id, left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: innerWidth, height: innerHeight }; })()`);
  const opened = await barCard();
  await delay(2500);
  const afterPolls = await barCard();
  assert.equal(afterPolls?.id, opened.id, "the readout card survives polls");
  assert.ok(
    opened.left >= 0 &&
      opened.right <= opened.width &&
      opened.top >= 0 &&
      opened.bottom <= opened.height,
    JSON.stringify(opened),
  );
  memory.readoutCardHeldThroughPolls = true;
  // Focus the bar too. Its focused topic card is the open card from here.
  await evaluate(`document.querySelector('${programBar}').focus({preventScroll:true})`);
  await until(
    () => evaluate("document.activeElement?.matches('#memory-amap button')"),
    "focused bar",
  );
  // A late layout of the old session never shows. Hold the old session's
  // next layout, then restart the process (new session and PID) while the
  // pointer and focus stay on the bar and the disclosures are open.
  holdLayout = true;
  memSeq = 2;
  await until(() => heldLayouts.length >= 1, "held layout of the old session");
  memSession = "800002";
  memPid += 1;
  memSeq = 1;
  memComm = "newproc";
  await until(
    async () => !(await memoryText()).includes("oldproc"),
    "old process gone from the memory map",
  );
  await until(() => heldLayouts.length >= 2, "held layout of the new session");
  memory.whileNewLayoutPending = await evaluate(`({
    noLayout: document.querySelector('#memory-amap').textContent.includes('No layout yet'),
    dialogs: document.querySelectorAll('[role=dialog]').length,
  })`);
  assert.deepEqual(memory.whileNewLayoutPending, { noLayout: true, dialogs: 0 });
  assert.deepEqual(await disclosures(), [true, true]);
  // Answer the old session's request first, then the rest.
  holdLayout = false;
  // The page aborts a request whose process is gone; the browser then
  // refuses its late answer. Any answer that does arrive must not show.
  let abortedLayouts = 0;
  for (const held of heldLayouts.splice(0)) {
    try {
      await answer(held.requestId, held.body);
    } catch {
      abortedLayouts++;
    }
    await delay(300);
    assert.ok(!(await memoryText()).includes("oldproc"), "late old layout");
  }
  await until(
    async () => (await barNames()).includes("newproc (program image)"),
    "memory bars of the new session",
  );
  memory.sessionChange = {
    lateOldLayoutShown: false,
    abortedLayouts,
    disclosures: await disclosures(),
  };
  assert.deepEqual(memory.sessionChange.disclosures, [true, true]);
  // A new PID in the same sampler session.
  memPid += 1;
  memSeq = 2;
  memComm = "thirdproc";
  await until(
    async () => (await barNames()).includes("thirdproc (program image)"),
    "memory bars of the new PID",
  );
  assert.ok(!(await memoryText()).includes("newproc"));
  memory.pidChange = { disclosures: await disclosures() };
  assert.deepEqual(memory.pidChange.disclosures, [true, true]);
  // Escape closes the card; a second Escape leaves the disclosures open.
  await hover(programBar);
  await until(
    () =>
      evaluate(
        "[...document.querySelectorAll('[role=dialog]')].some((node) => node.textContent.includes('thirdproc (program image)'))",
      ),
    "bar readout card of the new PID",
  );
  for (const press of [1, 2]) {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
    });
    await delay(200);
    assert.equal(await evaluate("document.querySelectorAll('[role=dialog]').length"), 0, `Escape ${String(press)}`);
  }
  memory.escape = { disclosures: await disclosures() };
  assert.deepEqual(memory.escape.disclosures, [true, true]);
  await escapeHelp();
  await send("Fetch.disable");
  onPaused = () => undefined;
  await escapeHelp();
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await delay(100);
  const mobileThreads = await evaluate(`({
    width: innerWidth,
    pageScrollWidth: document.documentElement.scrollWidth,
    sectionRight: document.querySelector('#threads-section').getBoundingClientRect().right,
    columns: getComputedStyle(document.querySelector('#threads-section .g-2-1')).gridTemplateColumns,
    headerOverflow: Math.max(0, document.querySelector('#target-select').getBoundingClientRect().right - innerWidth),
    overflowingThreads: [...document.querySelectorAll('#threads-section *')].filter(node => !node.closest('.table-wrap') && node.getBoundingClientRect().right > innerWidth + 1).map(node => node.id || node.className),
  })`);
  assert.ok(
    mobileThreads.sectionRight <= mobileThreads.width,
    JSON.stringify(mobileThreads),
  );
  assert.deepEqual(
    mobileThreads.overflowingThreads,
    [],
    JSON.stringify(mobileThreads),
  );
  assert.ok(
    !mobileThreads.columns.includes(" "),
    JSON.stringify(mobileThreads),
  );
  // Watch rules: the first write path, against the real collector. A second
  // editor (this script) saves between two saves of the page.
  await send("Emulation.clearDeviceMetricsOverride");
  const watchUrl = `${base}/api/watches?${new URLSearchParams({ target: target.key })}`;
  const watchWrites = [];
  const watchStatuses = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const { method, params } = message;
    if (
      method === "Network.requestWillBeSent" &&
      params.request.method === "POST" &&
      new URL(params.request.url).pathname.startsWith("/api/watches")
    )
      watchWrites.push({
        id: params.requestId,
        path: new URL(params.request.url).pathname,
        ifMatch: params.request.headers["If-Match"],
        guard: params.request.headers["X-Triangulator"],
        body: params.request.postData,
      });
    if (method === "Network.responseReceived")
      watchStatuses.set(params.requestId, params.response.status);
  });
  const writeStatus = (index) => watchStatuses.get(watchWrites[index]?.id);
  // Reset and Reload ask first; answer yes.
  await evaluate("window.confirm = () => true");
  await evaluate("document.querySelector('a[href=\"#collector-settings\"]').click()");
  await until(
    () => evaluate("!!document.querySelector('#watch-add:not([disabled])')"),
    "watch rules editor",
  );
  const watchText = (id) =>
    evaluate(`document.getElementById(${JSON.stringify(id)})?.textContent ?? null`);
  const watchStatus = async (pattern, description) => {
    await until(async () => pattern.test((await watchText("watch-status")) ?? ""), description);
    return watchText("watch-status");
  };
  const rowsBefore = await evaluate("document.querySelectorAll('#watch-rows tr').length");
  await evaluate("document.querySelector('#watch-add').click()");
  const lastRow = `#watch-rows tr:nth-child(${String(rowsBefore + 1)})`;
  assert.equal(
    await evaluate(`document.activeElement === document.querySelector('${lastRow} .watch-prefix')`),
    true,
  );
  await send("Input.insertText", { text: "proof-" });
  await typeInto(`${lastRow} .watch-wake`, "500");
  const watchBefore = await (await fetch(watchUrl)).json();
  await evaluate("document.querySelector('#watch-save').click()");
  const watch = { saved: await watchStatus(/^Saved and applied\.$/, "real save") };
  const afterSave = await (await fetch(watchUrl)).json();
  assert.deepEqual(watchWrites[0], {
    id: watchWrites[0].id,
    path: "/api/watches",
    ifMatch: `"${watchBefore.revision}"`,
    guard: "1",
    body: JSON.stringify({ rules: [...watchBefore.rules, { prefix: "proof-", wake_ms: 500 }] }),
  });
  assert.equal(writeStatus(0), 200);
  assert.equal(afterSave.source, "dashboard");
  assert.deepEqual(afterSave.rules.at(-1), { prefix: "proof-", wake_ms: 500 });
  // The second editor saves with the revision in force.
  const other = await fetch(watchUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Triangulator": "1",
      Origin: base,
      "If-Match": `"${afterSave.revision}"`,
    },
    body: JSON.stringify({ rules: [{ prefix: "other-", wake_ms: 1000 }] }),
  });
  assert.equal(other.status, 200);
  const otherRules = await other.json();
  // The page still holds afterSave as its base. Its next save is refused.
  await typeInto(`${lastRow} .watch-wake`, "750");
  await evaluate("document.querySelector('#watch-save').click()");
  watch.conflict = await watchStatus(/^Another user changed/, "real 409");
  assert.equal(watchWrites[1].ifMatch, `"${afterSave.revision}"`);
  assert.equal(writeStatus(1), 409);
  watch.afterConflict = await evaluate(`({
    draftKept: document.querySelector('${lastRow} .watch-wake').value,
    saveDisabled: document.querySelector('#watch-save').disabled,
    resetDisabled: document.querySelector('#watch-reset').disabled,
    reload: !!document.querySelector('#watch-reload'),
  })`);
  assert.deepEqual(watch.afterConflict, {
    draftKept: "750",
    saveDisabled: true,
    resetDisabled: true,
    reload: true,
  });
  assert.deepEqual((await (await fetch(watchUrl)).json()).rules, otherRules.rules);
  await evaluate("document.querySelector('#watch-reload').click()");
  watch.reloaded = await watchStatus(/^Current rules loaded\./, "reload after 409");
  assert.equal(
    await evaluate("document.querySelector('#watch-rows .watch-prefix').value"),
    "other-",
  );
  // A double click sends one write, which names the reloaded revision.
  await typeInto("#watch-rows .watch-wake", "1500");
  await evaluate(
    "(() => { const save = document.querySelector('#watch-save'); save.click(); save.click(); })()",
  );
  await watchStatus(/^Saved and applied\.$/, "save after reload");
  await delay(300);
  assert.equal(watchWrites.length, 3, "one write for two clicks");
  assert.equal(watchWrites[2].ifMatch, `"${otherRules.revision}"`);
  assert.equal(writeStatus(2), 200);
  await evaluate("document.querySelector('#watch-reset').click()");
  watch.reset = await watchStatus(/^Reset\. The rules from the config file are in force\.$/, "real reset");
  assert.equal(watchWrites[3].path, "/api/watches/reset");
  assert.equal(writeStatus(3), 200);
  const afterReset = await (await fetch(watchUrl)).json();
  assert.equal(afterReset.source, "config");
  assert.deepEqual(afterReset.rules, watchBefore.rules);
  watch.writes = watchWrites.map((write, index) => ({
    path: write.path,
    status: writeStatus(index),
    ifMatch: write.ifMatch,
  }));
  watch.source = await watchText("watch-source");
  const threads = {
    focusedHelpAndPendingHoverEscape: true,
    mapHeldAcrossPollsAndCard: true,
    columnReadouts: true,
    nullRateHeld: true,
    threadFocus,
    historyRange,
    targetQueryKept: true,
    slashSearch: true,
    waitBarsHeldAndFilter: true,
    familyFilter: true,
    threadHelp,
    mobileThreads,
  };
  assert.deepEqual(await evaluate("window.cspViolations"), []);

  priorProof = {
    embeddedBytesEqual: true, csp, fleet, reorder: { focusKey, mover, ...reorder },
    theme: { saved: "dark", background: "rgb(9, 9, 10)" }, help, selected, summary,
    readout, restored, threads, socketEntry, sockets, resources, memory, watch,
  };
  }

  if (process.argv.includes("--replay-only") || !process.argv.includes("--target-control-only")) {
    const { proveReplay } = await import("./prove_replay.mjs");
    priorProof.replay = await proveReplay({ root, profile, send, evaluate, until, stop, setPaused: value => { onPaused = value; }, setDialog: value => { onDialog = value; } });
  }
  if (process.argv.includes("--replay-only")) {
    assert.deepEqual(exceptions, []);
    console.log(JSON.stringify({ chromiumVersion, ...priorProof, runtimeExceptions: 0 }, null, 2));
  } else {
  // Target management: real collector, local helper, sampler and owned PIDs.
  // Reuse the integration fixture so its process and runtime isolation stay shared.
  controlFixture = spawn("python3", ["-u", "-c", `
import json, signal, sys, time
sys.path.insert(0, "tests")
from test_sampler_control import ScriptTests, start_named, stop
case = ScriptTests()
try:
    case.setUp()
    case.start_dashboard(extra='sampler_ips=["127.0.0.1"]\\n')
    config = case.runtime / "config/sampler.toml"
    config.write_text(f'collector="127.0.0.1:{case.port}"\\nrate_hz=5\\n[[target]]\\nid="default"\\npid={case.target.pid}\\n')
    case.start_sampler(config)
    name = f"proof-{case.target.pid}"
    first, second = start_named(name), start_named(name)
    case.addCleanup(stop, first, second)
    print(json.dumps({"url": case.dashboard, "pid": first.pid, "name": name, "config": str(config)}), flush=True)
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    try:
        while True: time.sleep(1)
    except KeyboardInterrupt: pass
finally:
    case.doCleanups()
`], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let controlInfo;
  let fixtureOutput = "";
  controlFixture.stdout.on("data", (chunk) => {
    fixtureOutput += chunk;
    if (!controlInfo && fixtureOutput.includes("\n")) controlInfo = JSON.parse(fixtureOutput.split("\n")[0]);
  });
  controlFixture.stderr.on("data", (chunk) => { diagnostics += chunk; });
  await until(() => {
    assert.equal(controlFixture.exitCode, null, diagnostics);
    return !!controlInfo;
  }, "local control fixture");
  controlBase = controlInfo.url;
  const controlUrl = `${controlBase}/api/targets/control`;
  const targetList = async () => (await (await fetch(controlUrl)).json()).targets;
  await until(async () => (await targetList())?.length === 1, "local configured target");
  const originalConfig = await readFile(controlInfo.config, "utf8");
  const targetWrites = [];
  const targetStatuses = new Map();
  const confirmations = [];
  let acceptTargetChange = false;
  socket.addEventListener("message", ({ data }) => {
    const { method, params } = JSON.parse(data);
    if (method === "Network.requestWillBeSent" && params.request.method === "POST" && params.request.url === `${controlBase}/api/targets`)
      targetWrites.push({ id: params.requestId, body: JSON.parse(params.request.postData), headers: params.request.headers });
    if (method === "Network.responseReceived") targetStatuses.set(params.requestId, params.response.status);
    if (method === "Page.javascriptDialogOpening") {
      confirmations.push(params.message);
      void send("Page.handleJavaScriptDialog", { accept: acceptTargetChange });
    }
  });
  await send("Page.navigate", { url: controlBase });
  await until(() => evaluate("!!document.querySelector('#fleet-add') && document.querySelectorAll('#fleet-grid > article').length === 1"), "local Add tile");
  const click = async (selector) => {
    const point = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({block:'center'});
      const r = element.getBoundingClientRect();
      const x = r.left + r.width/2, y = r.top + r.height/2;
      return {x,y,hit:element.contains(document.elementFromPoint(x,y))};
    })()`);
    assert.equal(point.hit, true, `Clickable: ${selector}`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  };
  const escapeTargetHelp = async () => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  };
  await click("#fleet-add");
  await until(() => evaluate("document.querySelector('#target-settings')?.matches(':modal')"), "native modal top layer");
  await evaluate("document.querySelector('#target-id').focus()");
  await until(() => evaluate("!!document.querySelector('#target-settings .help-card[aria-label=\"Target ID\"]')"), "modal ID help");
  const modalHelp = await evaluate(`(() => {
    const dialog = document.querySelector('#target-settings');
    const card = dialog.querySelector('.help-card[aria-label="Target ID"]');
    const r = card.getBoundingClientRect();
    document.querySelector('#fleet-search').focus();
    return {inside:card.closest('dialog')===dialog,focusInside:dialog.contains(document.activeElement),clamped:r.top>=0&&r.bottom<=innerHeight};
  })()`);
  assert.deepEqual(modalHelp, { inside: true, focusInside: true, clamped: true });
  await click('#target-settings .help-card[aria-label="Target ID"] a[href="#help-manage-targets"]');
  await until(() => evaluate("!!document.querySelector('#target-settings .help-card[aria-label=\"Manage targets\"]')"), "modal related help link");
  await escapeTargetHelp();
  assert.equal(await evaluate("document.querySelector('#target-settings').matches(':modal') && !document.querySelector('#target-settings .help-card')"), true);
  // Help remains interactive in the top layer. Close by a real pointer click.
  await evaluate("document.querySelector('#target-input').focus()");
  await click("#target-settings .help-close");
  assert.equal(await evaluate("document.querySelector('#target-settings .help-card') === null"), true);
  await typeInto("#target-id", "proof");
  await escapeTargetHelp();
  await typeInto("#target-input", "2147483647");
  await escapeTargetHelp();
  await click("#target-save");
  await until(() => evaluate("document.querySelector('#target-status').textContent.includes('no running process')"), "real invalid PID refusal");
  assert.equal(confirmations.length, 0);
  assert.equal(targetWrites.length, 1);
  assert.equal(targetStatuses.get(targetWrites[0].id), 400);
  assert.equal(await readFile(controlInfo.config, "utf8"), originalConfig);
  await typeInto("#target-input", controlInfo.name);
  await escapeTargetHelp();
  await click("#target-save");
  await until(() => evaluate("document.querySelector('#target-pid')?.options.length === 3"), "real ambiguous process picker");
  assert.equal(await evaluate("document.activeElement.id"), "target-pid");
  await evaluate(`document.querySelector('#target-pid').value=${JSON.stringify(String(controlInfo.pid))};document.querySelector('#target-pid').dispatchEvent(new Event('change',{bubbles:true}))`);
  assert.equal(await evaluate("document.querySelector('#target-input').value"), String(controlInfo.pid));
  assert.match(await evaluate("document.querySelector('#target-status').textContent"), /does not follow a restart/);
  await escapeTargetHelp();
  // Cancelled Add checks once but never applies.
  await click("#target-save");
  await until(() => confirmations.length === 1, "cancelled native Add confirmation");
  await until(() => evaluate("!document.querySelector('#target-save').disabled"), "cancelled Add ready");
  assert.equal(await readFile(controlInfo.config, "utf8"), originalConfig);
  assert.equal(targetWrites.length, 3);
  // A non-JSON server failure keeps the same input and permits a retry.
  onPaused = async ({ requestId }) => {
    await send("Fetch.fulfillRequest", { requestId, responseCode: 503, body: Buffer.from("unavailable").toString("base64") });
  };
  await send("Fetch.enable", { patterns: [{ urlPattern: `${controlBase}/api/targets`, requestStage: "Request" }] });
  await evaluate("document.querySelector('#target-form').requestSubmit()");
  await until(() => evaluate("document.querySelector('#target-status').textContent === 'Unable to change targets (HTTP 503)'"), "non-JSON failure recovery");
  await send("Fetch.disable");
  assert.equal(await evaluate("document.querySelector('#target-input').value"), String(controlInfo.pid));
  acceptTargetChange = true;
  const addStart = targetWrites.length;
  await evaluate("document.querySelector('#target-form').requestSubmit();document.querySelector('#target-form').requestSubmit()");
  await until(() => evaluate("!document.querySelector('#target-settings') && document.querySelector('#fleet-status').textContent.includes('Reload requested')"), "real Add and dialog close");
  assert.deepEqual(targetWrites.slice(addStart).map((entry) => entry.body), [
    { action: "add", id: "proof", target: String(controlInfo.pid), check: true },
    { action: "add", id: "proof", target: String(controlInfo.pid) },
  ]);
  assert.equal(confirmations.length, 2);
  await until(async () => (await targetList()).length === 2, "sampler config contains added target");
  await until(() => evaluate("!!document.querySelector('[aria-label=\"Remove target proof\"]')"), "new removable tile after refresh");
  acceptTargetChange = false;
  const removeStart = targetWrites.length;
  await click('[aria-label="Remove target proof"]');
  await until(() => confirmations.length === 3, "cancelled native Remove confirmation");
  assert.equal(targetWrites.length, removeStart);
  acceptTargetChange = true;
  await escapeTargetHelp();
  await click('[aria-label="Remove target proof"]');
  await until(async () => (await targetList()).length === 1, "real Remove in sampler config");
  await until(() => evaluate("!document.querySelector('[aria-label=\"Remove target proof\"]')"), "removed tile after refresh");
  assert.deepEqual(targetWrites.slice(removeStart).map((entry) => entry.body), [{ action: "remove", id: "proof", target: String(controlInfo.pid) }]);
  assert.equal(confirmations.length, 4);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Remove target default\"]').disabled"), true);
  for (const entry of targetWrites) {
    const headers = Object.fromEntries(Object.entries(entry.headers).map(([name, value]) => [name.toLowerCase(), value]));
    assert.equal(headers["x-triangulator"], "1");
    assert.equal(headers["content-type"], "application/json");
  }
  // Collector guards are separate evidence from the new page-side writes.
  const currentConfig = await readFile(controlInfo.config, "utf8");
  const guardRequest = async (headers) => fetch(`${controlBase}/api/targets`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ action: "remove", id: "default" }) });
  assert.equal((await guardRequest({})).status, 403);
  assert.equal((await guardRequest({ "X-Triangulator": "1", Origin: "https://untrusted.invalid" })).status, 403);
  assert.equal((await guardRequest({ "X-Triangulator": "1" })).status, 400);
  assert.equal(await readFile(controlInfo.config, "utf8"), currentConfig);
  assert.equal(await evaluate("document.querySelector('[id*=alert], [data-help=alerts]') === null"), true);
  assert.equal(requests.some((url) => url.includes("/api/alert-settings")), false);
  const targetControl = { realAdd: true, realRemove: true, invalidPidRefusedBeforeConfirm: true, ambiguousPidPicker: true, cancelledAddAndRemove: true, doubleSubmit: true, nonJsonRecovery: true, modalHelp, nativeConfirmations: confirmations, guardedHeaders: true, collectorGuards: [403,403,400], hiddenAlerts: true };

  assert.ok(
    requests.every(
      (url) =>
        url === "about:blank" ||
        url.startsWith("data:image/svg+xml;") ||
        (new URL(url).origin === base || new URL(url).origin === controlBase || new URL(url).origin === priorProof.replay?.base),
    ),
    JSON.stringify(
      requests.filter(
        (url) =>
          url !== "about:blank" &&
          !url.startsWith("data:image/svg+xml;") &&
          new URL(url).origin !== base && new URL(url).origin !== controlBase && new URL(url).origin !== priorProof.replay?.base,
      ),
    ),
  );
  assert.deepEqual(exceptions, []);
  console.log(
    JSON.stringify(
      {
        chromiumVersion,
        ...priorProof,
        targetControl,
        sameOriginRequests: true,
        runtimeExceptions: 0,
      },
      null,
      2,
    ),
  );
  }
} finally {
  socket?.close();
  await Promise.all([stop(browser), stop(fixture), ...(controlFixture ? [stop(controlFixture)] : [])]);
  await rm(profile, { recursive: true, force: true });
}
