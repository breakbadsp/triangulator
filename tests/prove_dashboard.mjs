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
  const chromiumVersion = (await send("Browser.getVersion")).product;
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
  assert.deepEqual(summary.tabs, ["Summary", "Threads"]);
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
  assert.equal(await evaluate("!!document.querySelector('#drawer.open')"), true);
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
  assert.equal(await evaluate("!!document.querySelector('#drawer.open')"), false);
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

  assert.ok(
    requests.every(
      (url) =>
        url === "about:blank" ||
        url.startsWith("data:image/svg+xml;") ||
        new URL(url).origin === base,
    ),
    JSON.stringify(
      requests.filter(
        (url) =>
          url !== "about:blank" &&
          !url.startsWith("data:image/svg+xml;") &&
          new URL(url).origin !== base,
      ),
    ),
  );
  assert.deepEqual(exceptions, []);
  console.log(
    JSON.stringify(
      {
        chromiumVersion,
        embeddedBytesEqual: true,
        csp,
        fleet,
        reorder: { focusKey, mover, ...reorder },
        theme: { saved: "dark", background: "rgb(9, 9, 10)" },
        help,
        selected,
        summary,
        readout,
        restored,
        threads,
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
