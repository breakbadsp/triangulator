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
    const data = await (await fetch(url)).json();
    if (url.pathname === "/api/live") {
      liveReads++;
      if (data.threads[0]) {
        data.threads[0].name = longName;
        data.threads[0].cpu_pct = 99;
      }
      if (data.process) data.process.command = longName;
    } else {
      targetReads++;
      for (const target of data.targets) {
        target.host += "-" + "long-host".repeat(18);
      }
    }
    await send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: Buffer.from(JSON.stringify(data)).toString("base64"),
    });
  });
  await send("Fetch.enable", {
    patterns: [{ urlPattern: "*/api/live*" }, { urlPattern: "*/api/targets" }],
  });
  const keypress = async (key, modifiers = 0) => {
    const windowsVirtualKeyCode = {
      Escape: 27,
      Tab: 9,
      Home: 36,
      End: 35,
      ArrowDown: 40,
    }[key];
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code: key,
      modifiers,
      windowsVirtualKeyCode,
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
  const explain = async (selector) => {
    await evaluate(
      `(() => {const el=document.querySelector(${JSON.stringify(selector)}).closest('[data-help]');el.scrollIntoView({block:'center'});el.focus();})()`,
    );
    await until(
      () =>
        evaluate(
          `!!document.querySelector(${JSON.stringify(selector)}).closest('[data-help]').getAttribute('aria-describedby')`,
        ),
      "focused metric card",
    );
    const id = await evaluate(
      `document.querySelector(${JSON.stringify(selector)}).closest('[data-help]').getAttribute('aria-describedby')`,
    );
    assert.ok(id, "Focused source has a help card");
    await click(`[id=${JSON.stringify(id)}] .help-open-guide`);
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
    153,
  );
  assert.equal(await evaluate("document.querySelector('main').inert"), true);
  await keypress("Tab", 8);
  assert.equal(await evaluate("document.activeElement.id"), "hover-help");
  await keypress("Tab");
  assert.equal(
    await evaluate("document.activeElement.getAttribute('aria-label')"),
    "Close metric guide",
  );
  for (const width of [1199, 1200, 1440, 390]) {
    await viewport(width);
    assert.equal(
      await evaluate(
        "document.querySelector('#help-guide').getAttribute('role')",
      ),
      width < 1200 ? "dialog" : "complementary",
    );
    assert.equal(
      await evaluate("document.querySelector('main').inert"),
      width < 1200,
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
    guideTopics: 153,
    guideResize: true,
    modalFocus: true,
    threadReturn: true,
    frozenChart: true,
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
        if (url.pathname === "/api/live") {
          if (body.threads[0]) {
            body.threads[0].name = longName;
            body.threads[0].cpu_pct = 99;
          }
        } else {
          for (const target of body.targets)
            target.host += "-" + "long-host".repeat(18);
        }
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
