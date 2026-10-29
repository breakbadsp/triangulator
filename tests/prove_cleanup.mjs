// Called by prove_dashboard.mjs. These checks use its real collector and
// native input. Controlled HTTP replies provide long identities and findings.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function proveCleanup({
  root,
  profile,
  base,
  controlBase,
  send,
  evaluate,
  until,
  stop,
  setPaused,
}) {
  let key;
  await until(async () => {
    try {
      const targets = (await (await fetch(`${base}/api/targets`)).json())
        .targets;
      key = targets
        .filter((t) => t.pid > 0 && t.status === "live")
        .sort((a, b) => b.key.length - a.key.length)[0]?.key;
      return !!key;
    } catch {
      return false;
    }
  }, "cleanup targets announced");
  const targetUrl = `${base}/?target=${encodeURIComponent(key)}`;
  let liveReads = 0,
    targetReads = 0;
  const longName = "worker-" + "long-process-identity".repeat(18);
  setPaused(async ({ requestId, request }) => {
    const url = new URL(request.url);
    const reply = await (await fetch(url)).json();
    // The overview reads the target list and live views in one request.
    const fleet = url.pathname === "/api/fleet";
    if (url.pathname !== "/api/targets") liveReads++;
    for (const data of url.pathname === "/api/targets"
      ? []
      : fleet
        ? Object.values(reply.live)
        : [reply]) {
      if (data.threads?.[0]) {
        data.threads[0].name = longName;
        data.threads[0].cpu_pct = 99;
      }
      if (data.process) data.process.command = longName;
      data.resources = {
        ...data.resources,
        available: true, stale: false, session: data.health.session, pid: data.health.pid,
        memory: { ...data.resources?.memory, rss: (32 + liveReads) * 2 ** 20 },
      };
      data.memory = {
        ...data.memory,
        available: true, stale: false, pid: data.health.pid,
        values: { ...data.memory?.values, vm_size_bytes: (512 + liveReads * 8) * 2 ** 20 },
      };
    }
    if (url.pathname !== "/api/live") {
      targetReads++;
      for (const target of (fleet ? reply.list : reply).targets) {
        target.host += "-" + "long-host".repeat(18);
      }
    }
    await send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: Buffer.from(JSON.stringify(reply)).toString("base64"),
    });
  });
  await send("Fetch.enable", {
    patterns: [
      { urlPattern: "*/api/live*" },
      { urlPattern: "*/api/targets" },
      { urlPattern: "*/api/fleet" },
    ],
  });
  const keypress = async (key, modifiers = 0) => {
    const windowsVirtualKeyCode = {
      Escape: 27,
      Tab: 9,
      Home: 36,
      End: 35,
      ArrowDown: 40,
      Enter: 13,
    }[key];
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code: key,
      modifiers,
      windowsVirtualKeyCode,
      text: key === "Enter" ? "\r" : undefined,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code: key,
      modifiers,
      windowsVirtualKeyCode,
    });
  };
  const click = async (selector) => {
    const point = await evaluate(
      `(() => {const el=document.querySelector(${JSON.stringify(selector)}); if(!el)throw Error('Missing click target');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect(); const x=r.left+r.width/2,y=r.top+r.height/2;return {x,y,hit:el.contains(document.elementFromPoint(x,y)),top:document.elementFromPoint(x,y)?.outerHTML.slice(0,160),width:r.width};})()`,
    );
    assert.equal(
      point.hit,
      true,
      `Click is unobstructed: ${selector} ${JSON.stringify(point)}`,
    );
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
  };
  const layout = () =>
    evaluate(
      "new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))",
    );
  const viewport = async (width, height = 900) => {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await layout();
  };
  // A label opens its guide from its info button: a pointer click, or Enter
  // with keyboard focus. A chart has no info button: its hover readout card
  // opens the guide.
  const explain = async (selector, keyboard = false) => {
    await until(() => evaluate("!document.querySelector('#help-guide')"), "previous guide closes");
    await layout();
    const info = await evaluate(
      `(() => {const help=document.querySelector(${JSON.stringify(selector)}).closest('[data-help]');help.scrollIntoView({block:'center'});const button=help.querySelector(':scope > button.help-info');if(!button)return null;button.dataset.proofInfo='';return true;})()`,
    );
    if (info && keyboard) {
      await evaluate("document.querySelector('[data-proof-info]').focus()");
      await keypress("Enter");
    } else if (info) await click("[data-proof-info]");
    else {
      const point = await evaluate(
        `(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`,
      );
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      await until(
        () => evaluate("!!document.querySelector('.help-card .help-open-guide')"),
        "chart readout card",
      );
      await click(".help-card .help-open-guide");
    }
    await evaluate("document.querySelector('[data-proof-info]')?.removeAttribute('data-proof-info')");
    await until(
      () => evaluate("!!document.querySelector('#help-guide')"),
      "metric guide opens",
    );
  };
  await send("Page.navigate", { url: targetUrl });
  await until(
    () =>
      evaluate(
        "!!document.querySelector('#findings')?.textContent.includes('long-process-identity')",
      ),
    "long finding reaches the real page",
  );
  const widths = [];
  for (const theme of ["light", "dark"]) {
    await evaluate("document.querySelector('#theme').focus()");
    await keypress(theme === "dark" ? "End" : "Home");
    if (theme === "light") await keypress("ArrowDown");
    await until(
      () => evaluate(`document.documentElement.dataset.theme === '${theme}'`),
      `${theme} theme`,
    );
    await keypress("Escape");
    for (const width of [320, 390, 768, 1199, 1200, 1440]) {
      await viewport(width);
      await evaluate(
        "document.querySelector('#target-select').scrollIntoView({block:'center'});document.querySelector('#target-select').focus()",
      );
      const before = targetReads;
      if (width === 390)
        await until(
          () => targetReads >= before + 2,
          "selector survives two polls",
        );
      const facts = await evaluate(
        `(() => {const el=document.querySelector('#target-select'), r=el.getBoundingClientRect();return {width:innerWidth,page:document.documentElement.scrollWidth,left:r.left,right:r.right,focused:document.activeElement===el,visible:el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)),overflow:getComputedStyle(document.body).overflowX};})()`,
      );
      if (facts.page > facts.width + 1)
        facts.outliers = await evaluate(
          `(() => {const clipped=e=>{for(let p=e.parentElement;p;p=p.parentElement){if(['auto','scroll','hidden','clip'].includes(getComputedStyle(p).overflowX))return true;}return false};return [...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1&&!clipped(e)).slice(0,12).map(e=>({tag:e.tagName,id:e.id,cls:e.className,right:e.getBoundingClientRect().right,html:e.outerHTML.slice(0,160)}))})()`,
        );
      assert.ok(
        facts.page <= facts.width + 1,
        JSON.stringify({ theme, ...facts }),
      );
      assert.ok(
        facts.left >= 0 &&
          facts.right <= width + 1 &&
          facts.focused &&
          facts.visible,
        JSON.stringify(facts),
      );
      assert.notEqual(facts.overflow, "hidden");
      widths.push({ theme, ...facts });
      await keypress("Escape");
    }
  }
  await viewport(390);
  await click(".page-help > summary");
  assert.equal(
    await evaluate("document.querySelectorAll('.help-card').length"),
    0,
    "disclosure click cannot cover the guide button",
  );
  await click("#page-help");
  assert.equal(
    await evaluate("document.querySelectorAll('.help-topics button').length"),
    147,
  );
  assert.equal(await evaluate("document.querySelector('main').inert"), true);
  // Tab wraps inside the modal guide in both directions.
  await evaluate(
    "[...document.querySelectorAll('#help-guide button')].at(-1).focus()",
  );
  await keypress("Tab");
  assert.equal(
    await evaluate("document.activeElement.getAttribute('aria-label')"),
    "Close metric guide",
  );
  await keypress("Tab", 8);
  assert.equal(
    await evaluate(
      "document.activeElement === [...document.querySelectorAll('#help-guide button')].at(-1)",
    ),
    true,
  );
  for (const width of [759, 760, 1440, 390]) {
    await viewport(width);
    assert.equal(
      await evaluate(
        "document.querySelector('#help-guide').getAttribute('role')",
      ),
      width < 760 ? "dialog" : "complementary",
    );
    assert.equal(
      await evaluate("document.querySelector('main').inert"),
      width < 760,
    );
  }
  await viewport(390, 320);
  const short = await evaluate(
    "(()=>{const r=document.querySelector('#help-guide').getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight}})()",
  );
  assert.ok(
    short.top >= -1 && short.bottom <= short.height + 1,
    JSON.stringify(short),
  );
  await click("#help-guide [aria-label='Close metric guide']");
  assert.equal(await evaluate("document.activeElement.id"), "page-help");
  await viewport(1440);
  await explain("#chart-load");
  await click("#help-guide details > summary");
  await layout();
  const frozen = await evaluate(
    "({rows:document.querySelector('#help-guide .help-data')?.textContent,chart:document.querySelector('#chart-load svg')?.innerHTML})",
  );
  assert.ok(frozen.rows?.includes("Time"));
  const before = liveReads;
  await until(
    () => liveReads >= before + 2,
    "chart guide remains open during live reads",
  );
  assert.deepEqual(
    await evaluate(
      "({rows:document.querySelector('#help-guide .help-data')?.textContent,chart:document.querySelector('#chart-load svg')?.innerHTML})",
    ),
    frozen,
  );
  await keypress("Escape");
  const metricGuides = [];
  for (const [topic, heldId, liveId, valueId, label] of [
    ["rss", "chart-rss", "chart-vm", "overview-rss", "Resident (RSS)"],
    ["vmsize", "chart-vm", "chart-rss", "overview-vm", "Virtual size (VmSize)"],
  ]) {
    await until(() => evaluate(`document.querySelector('#${heldId} svg')?.textContent.includes('MiB')`), "distinct memory samples reach the chart");
    await explain(`#overview-memory .help-label[data-help='${topic}']`);
    await click("#help-guide details > summary");
    const snapshot = await evaluate(`(() => {const table=document.querySelector('#help-guide .help-data');return {headers:[...table.querySelectorAll('th')].map(n=>n.textContent),last:table.querySelector('tbody tr:last-child td:last-child').textContent,value:document.getElementById('${valueId}').textContent.replace('.0 ', ' '),rows:table.textContent,held:document.querySelector('#${heldId} svg').innerHTML,live:document.querySelector('#${liveId} svg').innerHTML}})()`);
    assert.deepEqual(snapshot.headers, ["Time", label]);
    assert.equal(snapshot.last, snapshot.value);
    const reads = liveReads;
    await until(async () => liveReads >= reads + 2 && await evaluate(`document.querySelector('#${liveId} svg').innerHTML!==${JSON.stringify(snapshot.live)}`), "other memory chart updates while the selected chart is held");
    assert.deepEqual(await evaluate(`({rows:document.querySelector('#help-guide .help-data').textContent,held:document.querySelector('#${heldId} svg').innerHTML})`), { rows: snapshot.rows, held: snapshot.held });
    await keypress("Escape");
    assert.notEqual(await evaluate(`document.querySelector('#${heldId} svg').innerHTML`), snapshot.held);
    metricGuides.push({ topic, headers: snapshot.headers, value: snapshot.last, selectedChartHeld: true, otherChartUpdated: true });
  }
  // A label also opens its guide from the keyboard.
  await explain("#overview-memory .help-label[data-help='rss']", true);
  assert.equal(
    await evaluate("document.querySelector('#help-guide-title').textContent"),
    "Memory (RSS)",
  );
  await keypress("Escape");
  await click("#threads tr[data-tid] td:first-child");
  await until(
    () =>
      evaluate(
        "document.querySelector('#drawer')?.classList.contains('open') && document.querySelector('#drawer').getBoundingClientRect().right<=innerWidth+1",
      ),
    "thread drawer animation completes",
  );
  if (await evaluate("!!document.querySelector('.help-card')"))
    await keypress("Escape");
  await click("#history button[data-range='3600']");
  if (await evaluate("!!document.querySelector('.help-card')"))
    await keypress("Escape");
  await evaluate("document.querySelector('.drawer-body').scrollTop=160");
  const saved = await evaluate(
    "({from:document.querySelector('#from').value,to:document.querySelector('#to').value,hash:location.hash,scroll:document.querySelector('.drawer-body').scrollTop})",
  );
  await explain("#history-title");
  assert.equal(
    await evaluate("document.querySelector('#drawer').hidden"),
    true,
  );
  await click("#help-guide-body > button[data-help='page']");
  await click("#help-back-thread");
  assert.equal(
    await evaluate("document.querySelector('#drawer').hidden"),
    false,
  );
  assert.deepEqual(
    await evaluate(
      "({from:document.querySelector('#from').value,to:document.querySelector('#to').value,hash:location.hash,scroll:document.querySelector('.drawer-body').scrollTop})",
    ),
    saved,
  );
  await keypress("Escape");
  await send("Fetch.disable");
  if (controlBase) {
    await viewport(390);
    await send("Page.navigate", { url: controlBase });
    await until(
      () => evaluate("!!document.querySelector('#fleet-add')"),
      "local Add target",
    );
    await click("#fleet-add");
    await until(
      () =>
        evaluate(
          "document.querySelector('#target-settings')?.matches(':modal')",
        ),
      "native Add target modal",
    );
    await explain("#target-id");
    assert.equal(
      await evaluate(
        "document.querySelector('#help-guide').closest('dialog').id",
      ),
      "target-settings",
    );
    assert.equal(
      await evaluate(
        "document.querySelector('#help-guide').closest('[inert]')===null",
      ),
      true,
    );
    await keypress("Escape");
    assert.equal(
      await evaluate(
        "document.querySelector('#target-settings').matches(':modal')",
      ),
      true,
    );
    assert.equal(
      await evaluate(
        "document.activeElement.closest('#target-settings')!==null",
      ),
      true,
    );
    await keypress("Escape");
    await until(
      () => evaluate("!document.querySelector('#target-settings')"),
      "native dialog closes after guide",
    );
  }
  await send("Emulation.clearDeviceMetricsOverride");
  const zoom = await proveZoom({ root, profile, targetUrl, stop, longName });
  return {
    widths,
    shortViewport: short,
    guideTopics: 147,
    guideResize: true,
    modalFocus: true,
    threadReturn: true,
    frozenChart: true,
    metricGuides,
    keyboardGuide: true,
    nativeDialog: !!controlBase,
    zoom,
  };
}

async function proveZoom({ root, profile, targetUrl, stop, longName }) {
  const directory = await mkdtemp(join(profile, "zoom-"));
  await mkdir(join(directory, "Default"));
  // Chromium stores browser zoom as powers of 1.2. This is a test-owned
  // profile. Assert its actual CSS viewport and DPR before trusting the case.
  await writeFile(
    join(directory, "Default/Preferences"),
    JSON.stringify({
      partition: { default_zoom_level: { x: Math.log(2) / Math.log(1.2) } },
    }),
  );
  const browser = spawn(
    process.env.CHROMIUM || "chromium",
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--remote-debugging-port=0",
      "--window-size=1440,900",
      `--user-data-dir=${directory}`,
      "about:blank",
    ],
    { cwd: root, stdio: ["ignore", "ignore", "ignore"] },
  );
  let socket;
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      try {
        port = (
          await readFile(join(directory, "DevToolsActivePort"), "utf8")
        ).split("\n")[0];
        break;
      } catch {}
      await delay(100);
    }
    assert.ok(port, "zoom browser started");
    const tabs = await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json();
    socket = new WebSocket(
      tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl,
    );
    await once(socket, "open");
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener("message", ({ data }) => {
      const m = JSON.parse(data);
      if (m.id) {
        const request = pending.get(m.id);
        if (request) {
          pending.delete(m.id);
          clearTimeout(request.timer);
          m.error
            ? request.reject(Error(JSON.stringify(m.error)))
            : request.resolve(m.result);
        }
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error(`Zoom CDP timeout: ${method}`));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      assert.equal(result.exceptionDetails, undefined);
      return result.result.value;
    };
    const errors = [];
    socket.addEventListener("message", ({ data }) => {
      const event = JSON.parse(data);
      if (event.method !== "Fetch.requestPaused") return;
      void (async () => {
        const { requestId, request } = event.params;
        const url = new URL(request.url);
        const body = await (await fetch(url)).json();
        const fleet = url.pathname === "/api/fleet";
        if (url.pathname !== "/api/targets")
          for (const view of fleet ? Object.values(body.live) : [body])
            if (view.threads?.[0]) {
              view.threads[0].name = longName;
              view.threads[0].cpu_pct = 99;
            }
        if (url.pathname !== "/api/live")
          for (const target of (fleet ? body.list : body).targets)
            target.host += "-" + "long-host".repeat(18);
        await send("Fetch.fulfillRequest", {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: "Content-Type", value: "application/json" },
          ],
          body: Buffer.from(JSON.stringify(body)).toString("base64"),
        });
      })().catch((error) => errors.push(error.message));
    });
    await send("Fetch.enable", {
      patterns: [
        { urlPattern: "*/api/live*" },
        { urlPattern: "*/api/targets" },
        { urlPattern: "*/api/fleet" },
      ],
    });
    await send("Page.navigate", { url: targetUrl });
    for (let i = 0; i < 100; i++) {
      if (
        await evaluate(
          "!!document.querySelector('#findings')?.textContent.includes('long-process-identity')",
        )
      )
        break;
      await delay(100);
    }
    assert.equal(
      await evaluate(
        "!!document.querySelector('#findings')?.textContent.includes('long-process-identity')",
      ),
      true,
    );
    const cases = [];
    for (const theme of ["light", "dark"]) {
      await evaluate("document.querySelector('#theme').focus()");
      const keys =
        theme === "light"
          ? [
              ["Home", 36],
              ["ArrowDown", 40],
            ]
          : [["End", 35]];
      for (const [key, windowsVirtualKeyCode] of keys) {
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key,
          code: key,
          windowsVirtualKeyCode,
        });
        await send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key,
          code: key,
          windowsVirtualKeyCode,
        });
      }
      await evaluate(
        "new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))",
      );
      assert.equal(
        await evaluate("document.documentElement.dataset.theme"),
        theme,
      );
      await evaluate("document.querySelector('#target-select').focus()");
      const facts = await evaluate(
        "({width:innerWidth,outer:outerWidth,dpr:devicePixelRatio,scale:visualViewport.scale,page:document.documentElement.scrollWidth,selector:document.querySelector('#target-select').getBoundingClientRect().right})",
      );
      assert.equal(facts.dpr, 2);
      assert.equal(facts.scale, 1);
      assert.equal(facts.width, 720);
      assert.equal(facts.outer, 1440);
      assert.ok(
        facts.page <= facts.width + 1 && facts.selector <= facts.width + 1,
        JSON.stringify(facts),
      );
      assert.equal(
        await evaluate("document.activeElement.id"),
        "target-select",
      );
      cases.push({ theme, ...facts });
    }
    await send("Fetch.disable");
    assert.deepEqual(errors, []);
    return { percent: 200, cases };
  } finally {
    socket?.close();
    await stop(browser);
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}
