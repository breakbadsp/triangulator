// Run after make check: node tests/prove_severity_styles.mjs [new-evidence-directory].
// Needs Chromium and Node 24+. Uses the built collector, own ports, and own profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.argv[2]
  ? resolve(process.argv[2])
  : await mkdtemp(join(root, "build/severity-styles-"));
if (process.argv[2]) await mkdir(output); // Never replace previous evidence.
const profile = await mkdtemp(join(output, "browser-"));
const probe = createServer().listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const fixture = spawn(
  "python3",
  ["tests/fleet_fixture.py", "--targets", "6", "--http-port", String(port)],
  {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
  },
);
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
let diagnostics = "",
  socket,
  sequence = 0,
  dropNoData = async () => undefined;
const pending = new Map(),
  failures = [],
  cases = [],
  exceptions = [];
for (const child of [fixture, browser])
  child.stderr.on("data", (data) => {
    diagnostics += data;
  });
async function until(check, description) {
  for (let attempt = 0; attempt < 150; ++attempt) {
    if (await check()) return;
    if (
      [fixture, browser].some(
        (child) => child.exitCode !== null || child.signalCode !== null,
      )
    )
      throw Error(`Proof process exited: ${diagnostics}`);
    await delay(100);
  }
  throw Error(`Timed out: ${description}\n${diagnostics}`);
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error(`CDP timeout: ${method}`));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const value = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  assert.equal(
    value.exceptionDetails,
    undefined,
    JSON.stringify(value.exceptionDetails),
  );
  return value.result.value;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
function check(actual, expected, label) {
  try {
    assert.deepEqual(actual, expected, label);
  } catch (error) {
    failures.push(error.message);
  }
}
async function screenshot(name) {
  await evaluate(
    "document.fonts.ready.then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))))",
  );
  const { data } = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await writeFile(join(output, name + ".png"), Buffer.from(data, "base64"));
}
async function portSpacing(theme, target) {
  for (const width of [1440, 390]) {
    const label = `${theme} ${width} port spacing`;
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: width === 390 ? 844 : 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", {
      url: `${base}/?target=${encodeURIComponent(target)}&q=rack&status=critical#overview`,
    });
    await until(
      () =>
        evaluate(
          "!!document.querySelector('.card.tile') && !!document.querySelector('#fleet-back')",
        ),
      label,
    );
    await evaluate("scrollTo(0,0)");
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
    const facts = await evaluate(`(()=>{
      const back=document.querySelector('#fleet-back'),s=getComputedStyle(back),r=back.getBoundingClientRect();
      const tiles=[...document.querySelectorAll('.card.tile')].map(e=>{
        const s=getComputedStyle(e),r=e.getBoundingClientRect();
        return {padding:s.padding,inside:r.left>=0&&r.right<=innerWidth};
      });
      const x=r.left+r.width/2,y=r.top+r.height/2;
      return {weight:s.fontWeight,padding:s.padding,border:[s.borderTopWidth,s.borderTopStyle,s.borderTopColor],radius:s.borderRadius,color:s.color,decoration:s.textDecorationLine,href:back.getAttribute('href'),linkHeight:r.height,linkWidth:r.width,x,y,hit:back.contains(document.elementFromPoint(x,y)),overflow:document.documentElement.scrollWidth>innerWidth,tiles};
    })()`);
    check(facts.weight, "600", label + " return link weight");
    check(facts.padding, "4px 10px", label + " return link padding");
    check(
      facts.border,
      [
        "1px",
        "solid",
        theme === "light" ? "rgb(220, 227, 237)" : "rgb(36, 36, 40)",
      ],
      label + " return link border",
    );
    check(facts.radius, "999px", label + " return link radius");
    check(
      facts.color,
      theme === "light" ? "rgb(28, 92, 171)" : "rgb(134, 182, 239)",
      label + " inherited link color",
    );
    check(facts.decoration, "none", label + " link decoration");
    check(
      facts.linkHeight >= 25 && facts.linkWidth >= 60,
      true,
      label + " link hit area",
    );
    check(facts.hit, true, label + " unobscured link");
    check(facts.overflow, false, label + " page overflow");
    for (const tile of facts.tiles) {
      check(
        tile.padding,
        width === 390 ? "14px 12px" : "16px 20px 12px",
        label + " Summary tile padding",
      );
      check(tile.inside, true, label + " tile fits viewport");
    }
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: facts.x,
      y: facts.y,
    });
    await delay(200);
    const hover = await evaluate(
      "getComputedStyle(document.querySelector('#fleet-back')).backgroundColor",
    );
    check(
      hover,
      theme === "light" ? "rgb(234, 240, 248)" : "rgb(28, 28, 32)",
      label + " return link hover",
    );
    await screenshot(`${theme}-port-spacing-${width}`);
    // Use native input to verify both keyboard access and the retained filter URL.
    await evaluate("document.querySelector('#fleet-back').focus()");
    check(
      await evaluate("document.activeElement.id"),
      "fleet-back",
      label + " keyboard focus",
    );
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
    await until(
      () => evaluate("document.documentElement?.dataset.page==='fleet'"),
      label + " return navigation",
    );
    const destination = await evaluate("location.pathname+location.search");
    check(destination, "/?q=rack&status=critical", label + " retained filters");
    cases.push({
      theme,
      width,
      surface: "port-spacing",
      ...facts,
      hover,
      destination,
    });
  }
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
}
let result = { cases, failures, exceptions, output };
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
  }, "owned Chromium CDP endpoint");
  const tabs = await (
    await fetch(`http://127.0.0.1:${debugPort}/json/list`)
  ).json();
  socket = new WebSocket(
    tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl,
  );
  await once(socket, "open");
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      if (request) {
        clearTimeout(request.timer);
        pending.delete(message.id);
        if (message.error) request.reject(Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
      }
    }
    if (message.method === "Runtime.exceptionThrown")
      exceptions.push(message.params.exceptionDetails);
    if (message.method === "Fetch.requestPaused")
      void dropNoData(message.params).catch((error) => exceptions.push(error));
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await until(async () => {
    try {
      return (
        (await (await fetch(base + "/api/targets")).json()).targets.length === 6
      );
    } catch {
      return false;
    }
  }, "six collector targets");
  const html = Buffer.from(await (await fetch(base + "/")).arrayBuffer());
  assert.deepEqual(
    html,
    await readFile(join(root, "dashboard/dist/index.html")),
    "collector serves this dashboard build",
  );
  result = {
    ...result,
    browser: await send("Browser.getVersion"),
    htmlSha256: createHash("sha256").update(html).digest("hex"),
  };

  // Fail the silent target read to exercise the real No data / Waiting for data UI.
  const targets = (await (await fetch(base + "/api/targets")).json()).targets;
  const noDataKey = targets.find((target) => target.host === "rack05").key;
  await send("Network.enable");
  await send("Network.setBlockedURLs", {
    urls: [base + "/api/live?target=" + encodeURIComponent(noDataKey)],
  });
  // The overview reads every live view in one reply; drop the silent one.
  dropNoData = async ({ requestId }) => {
    const reply = await send("Fetch.getResponseBody", { requestId });
    const fleet = JSON.parse(
      reply.base64Encoded
        ? Buffer.from(reply.body, "base64").toString()
        : reply.body,
    );
    delete fleet.live[noDataKey];
    await send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: Buffer.from(JSON.stringify(fleet)).toString("base64"),
    });
  };
  await send("Fetch.enable", {
    patterns: [{ urlPattern: "*/api/fleet", requestStage: "Response" }],
  });
  const colors = {
    critical: "rgb(208, 59, 59)",
    serious: "rgb(236, 131, 90)",
    warning: "rgb(250, 178, 25)",
    good: "rgb(22, 131, 75)",
    info: "rgb(22, 131, 75)",
  };
  let themeScript;
  for (const theme of ["light", "dark"]) {
    if (themeScript)
      await send("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: themeScript,
      });
    themeScript = (
      await send("Page.addScriptToEvaluateOnNewDocument", {
        source: `localStorage.setItem('triangulator:theme',${JSON.stringify(theme)});localStorage.setItem('triangulator:hover-help','off')`,
      })
    ).identifier;
    await send("Page.navigate", { url: base + "/" });
    await until(
      () =>
        evaluate(
          "document.querySelectorAll('.fleet-tile').length===6 && ['critical','serious','warning','good','unknown'].every(level=>document.querySelector('.fleet-tile[data-level='+level+']')) && document.querySelectorAll('.fleet-tile[data-level=unknown]').length===1",
        ),
      "fleet assessments including No data",
    );
    const fleet =
      await evaluate(`([...document.querySelectorAll('.fleet-tile')].map(tile=>{
      const dot=tile.querySelector('[role=img]'), style=getComputedStyle(dot);
      return { level:tile.dataset.level, key:new URL(tile.querySelector('.ft-name').href).searchParams.get('target'), label:dot.getAttribute('aria-label'), color:style.backgroundColor, width:style.width, height:style.height };
    }))`);
    check(
      [...new Set(fleet.map((tile) => tile.level))].sort(),
      ["critical", "good", "serious", "unknown", "warning"],
      theme + " rendered severity levels",
    );
    for (const dot of fleet) {
      check(
        dot.color,
        colors[dot.level] ||
          (theme === "light" ? "rgb(154, 160, 168)" : "rgb(107, 115, 128)"),
        theme + " fleet " + dot.level,
      );
      check(
        [dot.width, dot.height],
        ["10px", "10px"],
        theme + " fleet dot size",
      );
    }
    cases.push({ theme, surface: "fleet", values: fleet });
    await screenshot(theme + "-fleet");
    // The current assessor adds a good finding with every info finding. Check
    // the supported info alias on a rendered healthy tile without changing CSS.
    const infoDot = await evaluate(`(()=>{
      const tile=document.querySelector('.fleet-tile[data-level=good]');tile.dataset.level='info';
      const color=getComputedStyle(tile.querySelector('[role=img]')).backgroundColor;tile.dataset.level='good';return color;
    })()`);
    check(infoDot, colors.info, theme + " fleet info alias");
    cases.push({ theme, surface: "fleet-info-alias", color: infoDot });
    await portSpacing(
      theme,
      fleet.find((tile) => tile.level === "critical").key,
    );
    for (const level of ["critical", "serious", "warning", "good", "unknown"]) {
      const tile = fleet.find((tile) => tile.level === level);
      await send("Page.navigate", {
        url: base + "/?target=" + encodeURIComponent(tile.key) + "#overview",
      });
      await until(
        () =>
          evaluate(
            `document.querySelector('#assessment-card') && ${
              level === "unknown"
                ? "document.querySelector('#verdict')?.textContent==='Waiting for data'"
                : `document.querySelector('#assessment-card').dataset.level===${JSON.stringify(level)}`
            }`,
          ),
        theme + " Assessment " + level,
      );
      await evaluate(
        "document.querySelector('#assessment-card').scrollIntoView({block:'center',behavior:'instant'})",
      );
      const card = await evaluate(`(()=>{
        const card=document.querySelector('#assessment-card'),style=getComputedStyle(card);
        return {level:card.dataset.level||'unknown',verdict:document.querySelector('#verdict').textContent,left:[style.borderLeftWidth,style.borderLeftStyle,style.borderLeftColor],otherWidths:[style.borderTopWidth,style.borderRightWidth,style.borderBottomWidth],headerDot:getComputedStyle(document.querySelector('.topbar .status-dot')).backgroundColor};
      })()`);
      check(
        card.left,
        [
          "3px",
          "solid",
          colors[level] ||
            (theme === "light" ? "rgb(189, 201, 217)" : "rgb(65, 81, 106)"),
        ],
        theme + " Assessment " + level,
      );
      check(card.otherWidths, ["1px", "1px", "1px"], theme + " other borders");
      cases.push({ theme, surface: "assessment", ...card });
      await screenshot(theme + "-assessment-" + level);
      await send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const narrow = await evaluate(`(()=>{
        const card=document.querySelector('#assessment-card'),style=getComputedStyle(card);
        const heading=card.querySelector('.assessment-heading').getBoundingClientRect();
        const bodyElement=card.querySelector('.assessment-body'),body=bodyElement.getBoundingClientRect();
        return {bodyVisible:getComputedStyle(bodyElement).display!=='none',headingAboveBody:heading.bottom<=body.top,left:[style.borderLeftWidth,style.borderLeftStyle,style.borderLeftColor]};
      })()`);
      check(
        narrow.bodyVisible,
        level !== "unknown",
        theme + " Assessment body visibility",
      );
      if (level !== "unknown")
        check(
          narrow.headingAboveBody,
          true,
          theme + " narrow Assessment stacks",
        );
      check(narrow.left, card.left, theme + " narrow Assessment border");
      cases.push({ theme, surface: "assessment-narrow", level, ...narrow });
      await screenshot(theme + "-assessment-" + level + "-390");
      await send("Emulation.setDeviceMetricsOverride", {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      if (level === "good") {
        const infoBorder = await evaluate(`(()=>{
          const card=document.querySelector('#assessment-card');card.dataset.level='info';
          const style=getComputedStyle(card),left=[style.borderLeftWidth,style.borderLeftColor];card.dataset.level='good';return left;
        })()`);
        check(
          infoBorder,
          ["3px", colors.info],
          theme + " Assessment info alias",
        );
        cases.push({
          theme,
          surface: "assessment-info-alias",
          left: infoBorder,
        });
      }
    }
  }
  check(exceptions, [], "browser exceptions");
  assert.equal(failures.length, 0, failures.join("\n\n"));
  console.log(
    `PASS: severity dots, Assessment borders, return link and Summary spacing, Light and Dark. Evidence: ${output}`,
  );
} catch (error) {
  result.error = String(error.stack || error);
  console.error(result.error);
  process.exitCode = 1;
} finally {
  socket?.close();
  for (const request of pending.values()) clearTimeout(request.timer);
  await stop(browser);
  await stop(fixture);
  await rm(profile, { recursive: true, force: true });
  result.stopped = true;
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  await writeFile(join(output, "process.log"), diagnostics);
}
