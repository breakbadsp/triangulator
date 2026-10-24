// Memory map parity: drives the pinned page's renderMemory (with its real
// state globals and its layout fetch) and the React port's reducer through
// the same random live stream, and compares every displayed value after
// each step. Called by check-pure-parity.mjs with the oracle source.
import assert from "node:assert/strict";
import { setImmediate } from "node:timers";
import { createContext, runInContext } from "node:vm";

// A seeded generator, so a failure repeats.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// A minimal DOM node: enough for the old render functions.
function el(tag = "div", text, className = "") {
  const node = {
    tag,
    own: text ?? "",
    // As in the DOM, setting the text drops the children.
    get textContent() {
      return this.own;
    },
    set textContent(value) {
      this.own = value;
      this.children = [];
    },
    className: className ?? "",
    children: [],
    dataset: {},
    attrs: {},
    hidden: false,
    style: {
      setProperty(key, value) {
        this[key] = value;
      },
    },
    classList: {
      add: (name) => {
        node.className = node.className ? `${node.className} ${name}` : name;
      },
    },
    append(...items) {
      for (const item of items)
        this.children.push(typeof item === "string" ? el("#text", item) : item);
    },
    replaceChildren(...items) {
      this.children = [];
      this.append(...items);
    },
    setAttribute(key, value) {
      this.attrs[key] = String(value);
    },
    matches: () => false,
    querySelectorAll: () => [],
    contains: () => false,
  };
  return node;
}
const text = (node) =>
  node.textContent + node.children.map((child) => text(child)).join("");
const plain = (value) =>
  JSON.parse(
    JSON.stringify(value, (_, item) =>
      typeof item === "bigint" ? `${item}n` : item,
    ),
  );

export async function memoryParity({ oracle, load, dashboard, resolve }) {
  const lib = (file) => load(resolve(dashboard, file));
  const view = lib("src/lib/memoryView.ts");
  const { assessMemory, rssTrend, asResourcePoints } = lib(
    "src/lib/assess/memory.ts",
  );
  const { memoryFaultRate } = lib("src/lib/assess/index.ts");
  const { emptySeries } = lib("src/lib/series.ts");

  let server = null; // the collector's latest /api/memory-map
  const elements = new Map();
  const context = createContext({
    element: (id) => {
      if (!elements.has(id)) elements.set(id, el());
      return elements.get(id);
    },
    node: (tag, value, className) => el(tag, value, className),
    svgNode: (tag, attrs = {}) => {
      const node = el(tag);
      Object.assign(node.attrs, attrs);
      return node;
    },
    helpButtonLabel: (value, id, className, tag) => el(tag, value, className),
    helpOwns: () => false,
    topicForText: () => "",
    apiFetch: async () => ({ ok: true, json: async () => server }),
    frozen: null,
    replayAt: null,
    replayResources: [],
    pressureScope: "cgroup",
    resourceHistory: { rows: [] },
    buffer: [],
    live: null,
    now: 0,
    viewNow: () => context.now,
  });
  runInContext(
    `${oracle}
var memoryLayout=null,memoryLayoutLoading=false,memoryPrevious=null,memoryRenderedLayout,memoryRenderedComm,memoryRenderedZoom,memoryZoomStale=false,memorySelected=null,memoryHeapSpan=null,memoryHistory=[],memoryHistoryKey=null,memoryPage=null,memoryGrowthCells=[];
Date.now=()=>now*1000;`,
    context,
  );
  const flush = () => new Promise((done) => setImmediate(done));
  const LEVEL_NAMES = {
    critical: "critical",
    serious: "serious",
    warning: "warning",
    info: "notice",
    good: "ok",
  };
  let steps = 0,
    values = 0,
    layoutsFetched = 0;

  for (let seed = 1; seed <= 40; seed++) {
    const rand = random(seed),
      pick = (list) => list[Math.floor(rand() * list.length)];
    let session = "s1",
      pid = 100,
      seq = 1,
      updated = 1000,
      comm = "app",
      stale = false,
      flags = {},
      layoutFlags = {},
      available = true,
      heapEnd = 0x5555_0080_0000n,
      stackLo = 0x7ffc_0000_0000n,
      extra = 0,
      lag = false,
      resources = { page: 4096, stale: false, otherPid: false, rss: 1 << 26 };
    let state = view.initialMemory;
    const regionList = () => {
      const list = [
        ["0x555500000000", 0x200000, "file", "r-xp", "/usr/bin/app"],
        [
          "0x555500400000",
          Number(heapEnd - 0x5555_0040_0000n),
          "heap",
          "rw-p",
          "",
        ],
        ["0x7f0000000000", 0x100000, "file", "r-xp", "/usr/lib/libc.so.6"],
        ["0x7f0000100000", 0x1000, "anonymous", "rw-p", ""],
        ["0x7f0000101000", 0x100000, "file", "r-xp", "/usr/lib/libm.so.6"],
        ["0x7f0000301000", 0x1000, "anonymous", "---p", ""],
      ];
      for (let index = 0; index < extra; index++)
        list.push([
          "0x" + (0x6000_0000_0000 + index * 0x8000_0000).toString(16),
          0x100000 + index * 4096,
          index % 3 ? "anonymous" : "file",
          "rw-p",
          index % 3 ? "" : `/data/f${index}`,
        ]);
      list.push(
        [
          "0x" + stackLo.toString(16),
          Number(0x7ffc_0002_1000n - stackLo),
          "stack",
          "rw-p",
          "",
        ],
        ["0xffffffffff600000", 0x1000, "kernel", "--xp", "[vsyscall]"],
      );
      return list.map(([start, size, kind, permissions, name]) => ({
        start,
        end: "0x" + (BigInt(start) + BigInt(size)).toString(16),
        size,
        vmas: 1 + (size % 3),
        kind,
        permissions,
        name,
      }));
    };
    const publish = () => {
      server = {
        available: true,
        id: `${session}:${seq}`,
        pid,
        updated,
        flags: layoutFlags,
        regions: regionList(),
      };
    };
    publish();
    for (let step = 0; step < 60; step++) {
      const kind = pick([
        "tick",
        "tick",
        "tick",
        "poll",
        "poll",
        "layout",
        "layout",
        "layout",
        "stale",
        "flags",
        "session",
        "pid",
        "comm",
        "select",
        "select",
        "resources",
        "resources",
        "unavailable",
        "many",
      ]);
      if (kind === "tick") updated += 30;
      if (kind === "layout" || kind === "many") {
        updated += 30;
        seq++;
        if (kind === "many") extra = extra ? 0 : 40;
        else if (rand() < 0.5)
          heapEnd += BigInt(4096 * Math.floor(rand() * 400));
        else stackLo -= BigInt(4096 * Math.floor(rand() * 8));
        lag = rand() < 0.3;
        if (!lag) publish();
      } else if (lag) {
        lag = false;
        publish();
      }
      if (kind === "stale") stale = !stale;
      if (kind === "flags") {
        const flag = pick([
          "maps_partial",
          "maps_hidden",
          "regions_truncated",
          "none",
        ]);
        if (flag === "regions_truncated")
          layoutFlags = rand() < 0.5 ? { regions_truncated: true } : {};
        else flags = flag === "none" ? {} : { [flag]: true };
        if (flag === "regions_truncated") {
          seq++;
          publish();
        }
      }
      if (kind === "session" || kind === "pid") {
        // The layout sequence is per sampler session (collector/memory.hpp).
        if (kind === "session") {
          session = `s${step}`;
          seq = 1;
        } else {
          pid++;
          seq++;
        }
        updated += 30;
        publish();
      }
      if (kind === "comm") comm = comm === "app" ? "other" : "app";
      if (kind === "unavailable") available = !available;
      if (kind === "resources")
        resources = {
          page: pick([4096, 65536, null]),
          stale: rand() < 0.2,
          otherPid: rand() < 0.2,
          rss: Math.floor(rand() * 2 ** 30),
        };
      const summary = {
        available,
        reason: available ? undefined : "No memory-map samples yet.",
        stale,
        pid,
        updated,
        interval_s: 30,
        flags,
        layout_id: `${session}:${seq}`,
        values: {
          vm_size_bytes: 2 ** 32 + seq,
          vm_peak_bytes: 2 ** 33,
          vm_data_bytes: 2 ** 28,
          vm_pte_bytes: 2 ** 20,
          vm_locked_bytes: 0,
          major_faults: step * 7,
          minor_faults: step * 70,
          vma_count: 900 + seq,
          max_map_count: pick([1000, 65530, null]),
          address_space_limit_bytes: pick([null, 2 ** 34]),
          stack_limit_bytes: pick([null, 8 << 20]),
          maps_reads: 3,
          maps_read_us: 1500,
          maps_read_max_us: pick([400, 1200, null]),
        },
      };
      const r = {
        available: true,
        stale: resources.stale,
        session,
        pid: resources.otherPid ? pid + 1 : pid,
        limits: resources.page ? { page_size: resources.page } : {},
        memory: {
          rss: resources.rss,
          anon: resources.rss / 2,
          file: 3 << 20,
          peak: 2 ** 30,
          swap: 0,
        },
        pressure: {
          host: { memory: { some: { pct: step % 7 }, full: { pct: 1 } } },
        },
      };
      const live = {
        health: { session, pid },
        threads: [{ tid: pid, name: comm }],
        memory: summary,
        resources: r,
      };
      const now = updated + 2;
      const rows = Array.from({ length: 12 }, (_, index) => ({
        ts: now - 120 + index * 10,
        pid,
        elapsed_s: 10,
        rss_bytes: (100 + index * (seed % 3)) * 2 ** 20,
      }));
      const buffer =
        seed % 2
          ? []
          : [
              { t: now - 700, mf: 3 },
              { t: now, mf: step % 4 ? null : 12 },
            ];
      // The old page.
      Object.assign(context, { live, now, buffer, resourceHistory: { rows } });
      if (kind === "select") {
        const bars = runInContext(
          "memoryRows(memoryRegions(memoryLayoutFor(live.memory)))",
          context,
        ).filter((row) => !row.gap);
        const key = bars.length ? pick(bars).key : null;
        if (key) {
          runInContext(
            `memorySelected=${JSON.stringify(key)};renderMemoryZoom(memoryRows(memoryRegions(memoryLayoutFor(live.memory))).find(row=>row.key===memorySelected))`,
            context,
          );
          state = view.memoryReducer(state, { type: "select", row: key });
        }
      }
      runInContext("renderMemory()", context);
      await flush();
      // The port: the hook's sample, then its layout fetch when the held
      // layout is not the one the summary names.
      const key = `target|${session}|${summary.pid ?? pid}`;
      state = view.memoryReducer(state, {
        type: "sample",
        key,
        live: {
          summary,
          session,
          comm,
          resources: view.memoryResources(summary, r, session),
        },
      });
      if (
        summary.available &&
        summary.layout_id &&
        state.layout?.id !== summary.layout_id
      ) {
        layoutsFetched++;
        state = view.memoryReducer(state, {
          type: "layout",
          key,
          layout: JSON.parse(JSON.stringify(server)),
        });
      }
      steps++;
      const where = `seed ${seed} step ${step} (${kind})`;
      const same = (actual, expected, what) => {
        assert.deepEqual(plain(actual), plain(expected), `${where}: ${what}`);
        values++;
      };
      const old = (id) => elements.get(id) ?? el();
      if (!summary.available) {
        same(summary.reason, old("memory-empty").textContent, "empty text");
        continue;
      }
      const model = view.memoryModel(state);
      same(state.history, runInContext("memoryHistory", context), "history");
      same(
        state.selected,
        runInContext("memorySelected", context),
        "selection",
      );
      same(
        view.memorySubtitle(summary, now),
        old("memory-sub").textContent,
        "subtitle",
      );
      // Tiles and findings.
      const series = { ...emptySeries, points: buffer };
      const trend = rssTrend(live, asResourcePoints(rows), now);
      const faults = memoryFaultRate({
        series,
        mode: { kind: "live" },
        memoryHistory: state.history,
      });
      same(
        view.memoryTiles(summary, r, trend, faults, buffer, "cgroup"),
        old("memory-tiles").children.map((box) => [
          box.children[0].textContent,
          box.children[1].textContent,
          box.children[2].textContent,
          box.children[2].className.includes("bad"),
        ]),
        "tiles",
      );
      same(
        assessMemory(summary, model.regions, r, faults, trend, "cgroup").map(
          (item) => [LEVEL_NAMES[item.level], item.title, item.detail],
        ),
        old("memory-findings").children.map((row) => [
          row.children[0].textContent,
          row.children[1].children[0].textContent,
          row.children[1].children[1].textContent,
        ]),
        "findings",
      );
      // Limits, facts and notes.
      same(
        view
          .memoryLimits(
            summary,
            model.regions.find((region) => region.cat === "stack"),
          )
          .map((meter) => [meter.label, meter.sub, meter.text]),
        old("memory-limits").children.map((row) => [
          row.children[0].textContent,
          row.children[0].children[0]?.textContent ?? "",
          row.children[2].textContent,
        ]),
        "limits",
      );
      same(
        view.memoryFacts(summary),
        old("memory-facts").children.map((item) =>
          item.children.map((child) => child.textContent),
        ),
        "facts",
      );
      same(
        view.memoryNotes(summary, model.layout, model.regions.length),
        old("memory-notes").textContent,
        "notes",
      );
      same(
        view.memoryRegionCount(model.layout, model.regions.length, now),
        old("memory-region-count").textContent,
        "region count",
      );
      // The address map.
      const amap = old("memory-amap").children;
      same(
        model.rows.length
          ? view
              .memoryMapItems(model.rows)
              .flatMap((item) =>
                item.gap
                  ? [["⋮"], [item.text]]
                  : [
                      [item.address],
                      [
                        item.name,
                        item.meta,
                        item.color,
                        item.onDark,
                        `${item.height}px`,
                        item.band,
                        `${item.name}\n${item.range}\n${item.members}`,
                      ],
                    ],
              )
          : [["No layout yet. It arrives with the next memory-map sample."]],
        amap.map((node) =>
          node.tag === "button"
            ? [
                node.children[1].textContent,
                node.children[2].textContent,
                node.style["--kind"],
                node.className.includes("on-dark"),
                node.style.height,
                node.children[0].style.width,
                node.dataset.hint,
              ]
            : [node.textContent],
        ),
        "address map",
      );
      // The zoom.
      const row = model.selected;
      same(
        row ? view.memoryRowName(row) : "—",
        old("memory-zoom-name").textContent,
        "zoom name",
      );
      const charts = view.memoryCharts(state.history, model.complete);
      same(
        charts.map((chart) => [
          chart.title,
          chart.trend,
          "empty" in chart
            ? chart.empty
            : chart.lines.map((line) => [line.points, line.dot ? "5" : "2"]),
          "empty" in chart ? null : chart.range,
        ]),
        old("memory-charts").children.map((box) => {
          const [cap, body, range] = box.children;
          return [
            cap.children[0].textContent,
            cap.children[1].textContent,
            body.tag === "svg"
              ? body.children.map((line) => [
                  line.attrs.points,
                  String(line.attrs["stroke-width"]),
                ])
              : body.textContent,
            range ? range.textContent : null,
          ];
        }),
        "charts",
      );
      if (!row) {
        same(
          "No layout yet.",
          old("memory-grid-caption").textContent,
          "empty caption",
        );
        continue;
      }
      same(
        view.memoryZoomFacts(
          row,
          summary,
          model.complete,
          state.history,
          state.page,
        ),
        old("memory-zoom-facts").children.map((item) =>
          item.children.map((child) => child.textContent),
        ),
        "zoom facts",
      );
      const display = view.displaySpan(row, state.heapSpan, model.complete);
      const grid = view.memoryGrid(
        row,
        display,
        model.regions,
        state.previous,
        model.complete,
        state.page,
      );
      same(
        grid.caption + (grid.margin ? "Heap display margin" + grid.margin : ""),
        text(old("memory-grid-caption")),
        "caption",
      );
      same(
        grid.cells.map((cell) =>
          cell.kind === "pad"
            ? ["pad"]
            : cell.kind === "region"
              ? [
                  [
                    cell.cat === "guard" ? "cell-guard" : "",
                    cell.isNew ? "cell-new" : "",
                  ]
                    .filter(Boolean)
                    .join(" "),
                  view.kindColor(cell.cat),
                  `${cell.name}\n${cell.address}`,
                ]
              : [`cell-${cell.kind}`, undefined, cell.label],
        ),
        old("memory-grid").children.map((square) =>
          square.className === "pad"
            ? ["pad"]
            : [square.className, square.style["--kind"], square.dataset.hint],
        ),
        "grid",
      );
      same(
        grid.legend.map((item) => [
          item.label,
          `sw ${item.className}`,
          item.color,
        ]),
        old("memory-grid-legend").children.map((item) => [
          item.children[1].textContent,
          item.children[0].className,
          item.children[0].style.background,
        ]),
        "legend",
      );
      same(
        view
          .memoryRegionRows(row)
          .map((item) => [
            item.name,
            item.path,
            item.start,
            item.size,
            item.permissions,
            item.vmas,
          ]),
        old("memory-regions").children.map((tr) => [
          tr.children[0].textContent,
          tr.children[0].dataset.hint,
          ...tr.children.slice(1).map((cell) => cell.textContent),
        ]),
        "member regions",
      );
    }
  }
  return { steps, values, layoutsFetched };
}
