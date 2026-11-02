// Run from the repository root: node scripts/verify-process-header.mjs <baseline-ref>.
// Requires npm ci in dashboard/ and Chromium. No screenshots or API service needed.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "../dashboard/node_modules/vite/dist/node/index.js";

const baseline = execFileSync(
  "git",
  ["show", `${process.argv[2]}:dashboard/src/style.css`],
  { encoding: "utf8" },
);
const current = await readFile("dashboard/src/style.css", "utf8");
const server = await createServer({
  root: resolve("dashboard"),
  server: { port: 0 },
  plugins: [
    {
      name: "header-verification",
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url, "http://localhost");
          if (url.pathname === "/__header.css") {
            res.setHeader("Content-Type", "text/css");
            return res.end(
              url.searchParams.has("baseline") ? baseline : current,
            );
          }
          if (url.pathname !== "/__header") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/__header.css${url.searchParams.has("baseline") ? "?baseline" : ""}"></head><body><div id="root"></div><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { TopBar } from '/src/components/TopBar.tsx';
import { SectionTabs } from '/src/components/SectionTabs.tsx';
import { ErrorBanner } from '/src/components/ErrorBanner.tsx';
import { HelpGuideProvider } from '/src/help/HelpGuide.tsx';
const params = new URLSearchParams(location.search);
const warnings = params.has('warnings');
const long = params.has('long');
const fleet = params.has('fleet');
const target = { key: 'host/orders', host: long ? 'production-host-' + 'x'.repeat(80) : 'host', id: 'orders', pid: 123, status: 'live', process: null, ...(warnings ? {access:'limited',throttled:true,effective_rate_hz:2,sampler_cpu_pct:0.9,cpu_budget_pct:1} : {}) };
const health = { pid:123, last_seen:1700000000, sampler_silent:warnings, target_absent:false };
function Fixture() {
 const [recorded, setRecorded] = React.useState(params.has('recorded'));
 return React.createElement(React.Fragment, null,
  React.createElement('header', {className:'topbar'},
   React.createElement(TopBar, {page:fleet ? {kind:'fleet'} : {kind:'target',key:params.get('target') ?? target.key}, targets:params.has('single') ? [target] : [target,{...target,key:'host/billing',id:'billing',status:'absent'}],live:{health,process:{command:long ? 'worker-'+'y'.repeat(100) : 'orders',comm:'orders'},threads:[{tid:123,name:long ? 'worker-'+'y'.repeat(100) : 'orders'}]},mode:{kind:recorded?'recorded':'live'},now:1700000000,onLive:()=>setRecorded(false)}),
   !fleet && React.createElement(SectionTabs)),
  !fleet && React.createElement(ErrorBanner,{health}),
  React.createElement('main',null,React.createElement('section',{id:'timeline'},'Fixture content')));
}
createRoot(document.getElementById('root')).render(React.createElement(HelpGuideProvider,null,React.createElement(Fixture)));
</script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
const profile = await mkdtemp(join(tmpdir(), "process-header-"));
let chrome;
let ws;
try {
  await server.listen();
  const origin = server.resolvedUrls.local[0].replace(/\/$/, "");
  chrome = spawn(
    process.env.CHROMIUM ?? "chromium",
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      port = (
        await readFile(join(profile, "DevToolsActivePort"), "utf8")
      ).split("\n")[0];
      break;
    } catch {
      await delay(100);
    }
  }
  assert(port, "Chromium did not start");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl);
  await once(ws, "open");
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener("message", ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
    if (m.method === "Runtime.exceptionThrown")
      errors.push(m.params.exceptionDetails);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  const key = async (key) => {
    const windowsVirtualKeyCode = { Enter: 13, Tab: 9, End: 35, ArrowUp: 38 }[
      key
    ];
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      windowsVirtualKeyCode,
      text: key === "Enter" ? "\r" : undefined,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      windowsVirtualKeyCode,
    });
    await delay(80);
  };
  const load = async (query, width) => {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url: `${origin}/__header?${query}` });
    for (let i = 0; i < 100; i++) {
      if (
        await evaluate(
          `location.search === ${JSON.stringify(query ? "?" + query : "")} && !!document.querySelector('#theme') && document.documentElement.dataset.page === ${JSON.stringify(query.includes("fleet") ? "fleet" : "target")}`,
        )
      )
        break;
      await delay(100);
    }
    await delay(150);
    return evaluate(`(() => {
      const header = document.querySelector('header');
      const controls = [...header.querySelectorAll('select,button,a')].filter(e => e.getClientRects().length);
      const boxes = controls.map(e => {
        const b = e.getBoundingClientRect();
        const clip = e.closest('nav.tabs')?.getBoundingClientRect();
        return {left:clip ? Math.max(b.left,clip.left) : b.left,right:clip ? Math.min(b.right,clip.right) : b.right,top:b.top,bottom:b.bottom};
      });
      return {height:header.getBoundingClientRect().height, overflow:document.documentElement.scrollWidth > innerWidth,
        outside:controls.some((e,i)=>!e.closest('nav.tabs') && (boxes[i].left < 0 || boxes[i].right > innerWidth)),
        overlap:boxes.flatMap((a,i)=>boxes.flatMap((b,j)=>j>i && Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1 ? [[controls[i].outerHTML,controls[j].outerHTML]] : [])),
        text:header.innerText};
    })()`);
  };
  for (const query of [
    "",
    "single",
    "recorded",
    "warnings&long&recorded",
    "warnings&long&single",
    "fleet",
  ]) {
    for (const width of [1440, 768, 375]) {
      const before = await load(`${query}&baseline`, width);
      const after = await load(query, width);
      assert(
        !after.overflow && !after.outside && !after.overlap.length,
        `${query} at ${width}: ${JSON.stringify(after)}`,
      );
      if (width === 1440 && !query.includes("fleet"))
        assert(after.height < before.height, "Header must be shorter");
      if (query === "fleet")
        assert.equal(after.height, before.height, "Fleet height changed");
      if (query.includes("warnings"))
        for (const text of [
          "Limited access",
          "Sampler throttled",
          ...(query.includes("single") ? [] : ["other target"]),
          query.includes("recorded") ? "Historical" : "Sampler silent",
        ])
          assert(after.text.includes(text), text);
      console.log(
        JSON.stringify({
          query,
          width,
          before: before.height,
          after: after.height,
          overflow: after.overflow,
          overlap: after.overlap,
        }),
      );
    }
  }
  await load("recorded", 1440);
  await evaluate(`document.querySelector('#theme').focus()`);
  await key("End");
  await key("Tab");
  assert.equal(
    await evaluate("document.documentElement.dataset.theme"),
    "dark",
  );
  await evaluate(`document.querySelector('#history-pill').focus()`);
  await key("Enter");
  assert(
    await evaluate(
      `!document.querySelector('#history-pill') && document.querySelector('#target-meta').textContent.includes('Live')`,
    ),
  );
  await evaluate(`document.querySelector('#target-select').focus()`);
  await key("ArrowUp");
  await key("Enter");
  await delay(200);
  assert((await evaluate("location.search")).includes("target=host%2Fbilling"));
  await evaluate(`document.querySelector('#fleet-back').focus()`);
  await key("Enter");
  await delay(200);
  assert(!(await evaluate("location.search")).includes("target="));
  await load("", 375);
  await evaluate(
    `document.querySelector('button[data-help="target-switch"]').focus()`,
  );
  await key("Enter");
  assert(
    await evaluate(`!!document.querySelector('[role="dialog"]')`),
    "Keyboard help did not open",
  );
  assert.deepEqual(errors, [], "Browser runtime errors");
  console.log(
    "PASS: layout, keyboard navigation, theme, return to live, and contextual help.",
  );
} finally {
  ws?.close();
  if (chrome) {
    chrome.kill();
    await once(chrome, "exit");
  }
  await server.close();
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
