'use strict';
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {test} = require('node:test');
const vm = require('node:vm');
const html = readFileSync(new URL('../collector/dashboard.html', `file://${__filename}`), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

test('section navigation follows viewport position and layout changes', () => {
  const ids = ['overview', 'threads-section', 'resources', 'socket-panel', 'memory-map', 'monitor'];
  const links = ids.map(id => ({hash: '#' + id, attrs: {},
    setAttribute(key, value) {this.attrs[key] = value;},
    removeAttribute(key) {delete this.attrs[key];}}));
  let tops = [100, 1000, 2000, 3000, 4000, 5000];
  const sections = new Map(ids.map((id, index) => [id, {hasBox: true, getClientRects() {return this.hasBox ? [{}] : [];}, getBoundingClientRect: () => ({top: tops[index]})}]));
  const listeners = new Map(), frames = [], observed = [], offsets = {};
  let layoutChanged, position = 'sticky', headerBottom = 60;
  const topbar = {getBoundingClientRect: () => ({bottom: headerBottom})}, main = {};
  const context = vm.createContext({
    document: {querySelectorAll: () => links, getElementById: id => sections.get(id),
      querySelector: selector => selector === '.topbar' ? topbar : main,
      documentElement: {scrollHeight: 6000, style: {setProperty(name, value) {offsets[name] = value;}}}},
    getComputedStyle: () => ({position, scrollPaddingTop: position === 'sticky' ? '80px' : '16px'}), scrollY: 0, innerHeight: 800,
    addEventListener: (name, callback) => listeners.set(name, callback),
    requestAnimationFrame: callback => frames.push(callback),
    ResizeObserver: class {constructor(callback) {layoutChanged = callback;} observe(target) {observed.push(target);}},
  });
  const source = script.slice(script.indexOf('function initSectionNavigation(){'), script.indexOf('function targetName(){'));
  vm.runInContext(source + '\ninitSectionNavigation();', context);
  function current(id) {
    assert.deepEqual(links.filter(link => link.attrs['aria-current'] === 'location').map(link => link.hash), ['#' + id]);
  }
  function update(event) {listeners.get(event)(); frames.shift()();}
  current('overview');
  assert.equal(offsets['--header-offset'], '76px');
  assert.deepEqual(observed, [main, topbar]);
  tops = [-900, 79.9, 1000, 2000, 3000, 4000]; context.scrollY = 1000;
  update('hashchange'); current('threads-section');
  tops = [-1900, -1000, 0, 1000, 2000, 3000]; context.scrollY = 2000;
  update('scroll'); current('resources');
  // A restored hash can be unrelated to the section visible after manual scroll.
  tops = [-900, 0, 1000, 2000, 3000, 4000]; context.scrollY = 1000;
  update('hashchange'); current('threads-section');
  tops = [-5100, -4200, -3200, -2200, -1200, 400]; context.scrollY = 5200;
  update('scroll'); current('monitor');
  // A wrapped sticky header changes the activation boundary.
  context.scrollY = 2000; tops = [-1900, -1000, 100, 1000, 2000, 3000];
  headerBottom = 120; update('resize'); current('resources');
  assert.equal(offsets['--header-offset'], '136px', 'anchors clear a wrapped sticky header');
  position = 'static'; update('resize'); current('threads-section');
  assert.equal(offsets['--header-offset'], '16px', 'a static header does not reserve scroll space');
  tops[2] = 10; layoutChanged(); frames.shift()(); current('resources');
  tops = [100, 1000, 2000, 3000, 4000, 5000]; context.scrollY = 0;
  update('pageshow'); current('overview');
  // A hidden section reports top 0 and must not win.
  const sockets = sections.get('socket-panel');
  sockets.hasBox = false; tops = [-900, 0, 1000, 2000, 3000, 4000]; context.scrollY = 1000;
  update('scroll'); current('threads-section');
  sockets.hasBox = true;
  listeners.get('scroll')(); listeners.get('scroll')();
  assert.equal(frames.length, 1, 'scroll updates use one animation frame');
});

// Execute the shipped dashboard script, with network polling paused and a
// small DOM substitute. Keep ingestion, storage, overview and drawer controls
// real; unrelated visual panels are suppressed below.
function dashboard(storage = new Map(), respond = () => undefined, {resourceFetch,target='',local} = {}) {
  const elements = new Map();
  function element() {
    return {value: '', dataset: {}, textContent: '', attrs: {}, children: [],
      get firstChild() {return this.children[0];}, parentElement: {},
      style: {setProperty() {}}, classList: {add() {}, remove() {}},
      setAttribute(key, value) {this.attrs[key] = value;},
      append(...items) {for (const item of items) if (item && typeof item === 'object') item.parent = this; this.children.push(...items);},
      remove() {if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null;},
      replaceChildren(...items) {
        for (const old of this.children) if (old && typeof old === 'object') old.parent = null;
        this.children = []; this.append(...items);
      },
      // Connected means reachable from a document.getElementById element.
      get isConnected() {return this.attached || !!this.parent?.isConnected;},
      contains(other) {return other === this || this.children.some(child => child?.contains?.(other));},
      getBoundingClientRect() {return {top: 10, bottom: 30, left: 10, right: 100, width: 90, height: 20};},
      matches() {return false;}, focus() {}, addEventListener() {},
      showModal() {this.open = true;}, close() {this.open = false;}};
  }
  const ranges = [900, 3600, 21600, 86400].map(seconds => {
    const button = element(); button.dataset.range = String(seconds); return button;
  });
  const resourceRanges = [900, 3600, 21600, 86400].map(seconds => {
    const button = element(); button.dataset.resRange = String(seconds); return button;
  });
  const timers = new Map();
  let timerId = 0, timerNow = 0;
  const requests = [], navigation = [];
  const context = vm.createContext({
    document: {getElementById(id) {
      if (!elements.has(id)) elements.set(id, Object.assign(element(), {attached: true}));
      return elements.get(id);
    }, createElement: element, createElementNS: element, documentElement: {dataset: {}},
    querySelectorAll(selector) {return selector === '[data-range]' ? ranges : selector === '[data-res-range]' ? resourceRanges : [];},
    addEventListener() {}},
    sessionStorage: {getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    localStorage: local || {getItem() {return null;}, setItem() {}},
    history: {replaceState(state, title, url) {
      const next = new URL(url, 'http://dashboard.test' + context.location.pathname + context.location.search);
      Object.assign(context.location, {pathname: next.pathname, search: next.search, hash: next.hash});
    }},
    location: {hash: '', pathname: '/',search:target===null?'':'?target='+encodeURIComponent(target),assign(url){navigation.push(url);}},
    addEventListener() {},
    setTimeout(callback, delay) {const id = ++timerId; timers.set(id, {callback, delay, due: timerNow + delay}); return id;},
    clearTimeout(id) {timers.delete(id);}, URLSearchParams,
    fetch(url) {
      requests.push(url);
      if (resourceFetch && url.startsWith('/api/resources?')) return resourceFetch(url);
      const response = respond(url); if (response !== undefined) return response;
      return url.startsWith('/api/history?')
        ? Promise.resolve({ok: true, json: async () => ({rows: []})})
        : new Promise(() => {});
    },
  });
  vm.runInContext(script, context);
  vm.runInContext(`
    realRenderTiles=renderTiles; realRenderAssessment=renderAssessment; realRenderWchans=renderWchans;
    timeChart=()=>{}; renderAssessment=()=>{}; renderTiles=()=>{};
    renderCores=()=>{}; renderMosaic=()=>{}; renderFamilies=()=>{};
    renderWchans=()=>{}; renderThreads=()=>{}; renderDrawerLive=()=>{};
  `, context);
  return {run: source => vm.runInContext(source, context), elements, ranges, resourceRanges, timers, requests, storage, navigation,
    setFetch: callback => {context.fetch = callback;},
    advance(ms) {
      const until = timerNow + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, timer] = next; timers.delete(id); timerNow = timer.due; timer.callback();
      }
      timerNow = until;
    }};
}

test('target editor loads the selector and sends one validated dashboard write', async () => {
  const app = dashboard(new Map(), () => undefined, {target: null});
  app.setFetch(async () => ({ok: true, json: async () => ({enabled: true, target: 'worker'})}));
  await app.run('openTargetDialog()');
  assert.equal(app.elements.get('fleet-add').hidden, false);
  assert.equal(app.elements.get('target-settings').open, true);
  app.run('refreshFleet=async()=>{}');
  assert.equal(app.elements.get('target-input').value, 'worker');
  app.elements.get('target-input').value = ' 1234 ';
  const writes = [];
  let finish;
  app.setFetch((url, options) => {
    writes.push({url, options});
    return new Promise(resolve => {finish = resolve;});
  });
  const applying = app.run('saveTarget({preventDefault(){}})');
  assert.equal(app.elements.get('target-save').disabled, true);
  await app.run('saveTarget({preventDefault(){}})');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, '/api/target');
  assert.equal(writes[0].options.method, 'POST');
  assert.equal(writes[0].options.headers['X-Triangulator'], '1');
  assert.deepEqual(JSON.parse(writes[0].options.body), {target: '1234'});
  finish({ok: true, json: async () => ({target: '1234', message: 'Reload requested.'})});
  await applying;
  assert.equal(app.elements.get('target-save').disabled, false);
  assert.equal(app.elements.get('target-input').disabled, false);
  assert.equal(app.elements.get('target-status').textContent, 'Reload requested.');
});

test('target editor reports rejection and can retry; unavailable control stays hidden', async () => {
  const app = dashboard(new Map(), () => undefined, {target: null});
  app.setFetch(async () => ({ok: true, json: async () => ({enabled: false})}));
  await app.run('loadTarget()');
  assert.equal(app.elements.get('fleet-add').hidden, true);
  app.run("element('target-input').value='worker'");
  app.setFetch(async () => ({ok: false, json: async () => ({error: 'multiple processes named worker'})}));
  await app.run('saveTarget({preventDefault(){}})');
  assert.equal(app.elements.get('target-status').className, 'bad');
  assert.equal(app.elements.get('target-status').textContent, 'multiple processes named worker');
  assert.equal(app.elements.get('target-input').value, 'worker');
  assert.equal(app.elements.get('target-save').disabled, false);
  app.setFetch(async () => {throw Error('Connection lost');});
  await app.run('saveTarget({preventDefault(){}})');
  assert.equal(app.elements.get('target-status').textContent, 'Connection lost');
  assert.equal(app.elements.get('target-save').disabled, false);
});

function tick(app, time, cpu, session = 'session-1', state = 'sleep', delay = 0) {
  app.run(`live={health:{session:${JSON.stringify(session)}},threads:[{
    tid:1,generation:1,name:'worker',last_sample:${time},
    cpu_pct:${cpu},run_delay_pct:${delay},state:${JSON.stringify(state)}
  }]};ingest()`);
}
function close(actual, expected) {assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);}

// A long idle interval must keep decaying the initial load after that sample
// expires from the chart, including the saved one-minute overlay values.
test('load averages continue smoothly after chart eviction and redraws', () => {
  const app = dashboard();
  tick(app, 1000, 100);
  for (let time = 1001; time <= 1900; time++) tick(app, time, 0);
  close(app.run('loadState.averages[2]'), Math.exp(-1));
  tick(app, 1901, 0);
  assert.equal(app.run('buffer[0].t'), 1001);
  for (const [index, seconds] of [60, 300, 900].entries()) {
    close(app.run(`loadState.averages[${index}]`), Math.exp(-901 / seconds));
  }
  close(app.run('buffer.at(-1).l1'), Math.exp(-901 / 60));
  const before = app.run('JSON.stringify(loadState)');
  app.run('renderOverview();windowSecs=900;renderOverview();ingest()');
  assert.equal(app.run('JSON.stringify(loadState)'), before);
  assert.equal(app.elements.get('hero-load15').textContent, '0.37');
});

test('saved averages survive reload and reset for a new sampler session', () => {
  const app = dashboard();
  tick(app, 1000, 100);
  for (let time = 1001; time <= 1901; time++) tick(app, time, 0);
  app.run('saveBuffer()');
  const restored = dashboard(app.storage);
  tick(restored, 1901, 0);
  assert.equal(restored.run('JSON.stringify(loadState)'), app.run('JSON.stringify(loadState)'));
  tick(restored, 1902, 0);
  close(restored.run('loadState.averages[2]'), Math.exp(-902 / 900));
  tick(restored, 2000, 0, 'session-2');
  assert.equal(restored.run('loadState.averages[2]'), 0);
  assert.equal(restored.run('buffer.length'), 1);
});

// The Summary memory charts keep the latest RSS and VmSize per tick; stale,
// unavailable or other-session samples are gaps, never zero.
test('summary points record RSS and VmSize only from current samples', () => {
  const app = dashboard();
  const feed = (time, resources, memory) => app.run(`live={health:{session:'s',pid:7},threads:[{tid:1,generation:1,name:'w',last_sample:${time},cpu_pct:5,state:'sleep'}],
    resources:${JSON.stringify(resources)},memory:${JSON.stringify(memory)}};ingest();[buffer.at(-1).rss,buffer.at(-1).vm]`);
  assert.deepEqual([...feed(1, {available: true, session: 's', pid: 7, memory: {rss: 3 << 20}}, {available: true, pid: 7, values: {vm_size_bytes: 9 << 20}})], [3 << 20, 9 << 20]);
  assert.deepEqual([...feed(2, {available: true, stale: true, session: 's', pid: 7, memory: {rss: 1}}, {available: true, stale: true, pid: 7, values: {vm_size_bytes: 1}})], [null, null]);
  assert.deepEqual([...feed(3, {available: true, session: 'old', pid: 7, memory: {rss: 1}}, {available: false})], [null, null]);
  // A name target that restarted inside one session: samples for the old PID
  // must not be plotted against the new process.
  assert.deepEqual([...feed(4, {available: true, session: 's', pid: 6, memory: {rss: 1}}, {available: true, pid: 6, values: {vm_size_bytes: 1}})], [null, null]);
  assert.deepEqual([...feed(5, undefined, undefined)], [null, null]);
  assert.equal(app.run('niceBytes(300*2**20)'), 500 * 2 ** 20);
  assert.equal(app.run('niceBytes(3*2**30)'), 5 * 2 ** 30);
  assert.equal(app.run('niceBytes(800)'), 1024);
  assert.equal(app.run('niceBytes(900*2**20)'), 2 ** 30);
  assert.equal(app.run('axisBytes(2**30)'), '1 GiB');
  // A 2.5 top would put 1.25 GiB at the midpoint, labelled 1.3 GiB.
  assert.equal(app.run('niceBytes(2.2*2**30)'), 5 * 2 ** 30);
  assert.equal(app.run('axisBytes(niceBytes(2.2*2**30)/2)'), '2.5 GiB');
});

test('thread state charts keep Other and No access separate, including historical data', () => {
  const app = dashboard();
  app.run(`timeChart=(host,options)=>{host.chart=options};
    live={health:{session:'s'},threads:[]};
    buffer=[{t:1,s:{running:1,sleep:4,other:2,no_access:3}},{t:2,s:{running:1,sleep:4}}];
    renderOverview()`);
  const chart = app.elements.get('chart-states').chart;
  for (const [label, state, count] of [['Running','running',1], ['Sleep','sleep',4], ['Other','other',2], ['No access','no_access',3]]) {
    const series = chart.series.find(item => item.label === label);
    assert.ok(series, label);
    assert.equal(series.color, `var(--s-${state})`);
    assert.equal(series.get(chart.points[0]), count);
    const legend = app.elements.get('states-legend').children.find(item => item.children[1] === label);
    assert.ok(legend, `${label} remains in the legend when only earlier samples contain it`);
    assert.equal(legend.children[0].className, 'sw ' + state);
  }
});

test('wait channels use thread state colors and neutral colors for mixed groups', () => {
  const app = dashboard();
  const states = ['futex','poll','socket','pipe','sleep','stopped','kernel','other','no_access'];
  const threads = states.map(state => ({state, wchan: state + '-wait'}));
  threads.push({state:'running',wchan:''});
  const render = items => {
    app.run(`realRenderWchans(${JSON.stringify(items)})`);
    return app.elements.get('wchan-bars').children.map(row => ({
      label: row.children[0].textContent, color: row.children[1].children[0].style.background,
    }));
  };
  const bars = render(threads);
  assert.equal(bars.length, states.length, 'running threads are not waiting');
  for (const state of states) assert.equal(bars.find(bar => bar.label === state + '-wait').color, `var(--s-${state})`);
  assert.equal(render([{state:'sleep',wchan:'shared'}, {state:'kernel',wchan:'shared'}])[0].color, 'var(--s-other)');
  const many = Array.from({length:12}, (_, i) => ({state:'sleep',wchan:'timer-' + i}));
  const collapsed = render(many);
  assert.equal(collapsed.length, 10);
  assert.equal(collapsed.at(-1).color, 'var(--s-other)', 'combined channels do not imply one state');
});

test('each theme gives every thread state a distinct color', () => {
  const palettes = [...html.matchAll(/\{([^{}]*--s-running:[^{}]*)\}/g)];
  assert.equal(palettes.length, 3, 'light, system dark, and explicit dark');
  for (const [, declarations] of palettes) {
    const colors = [...declarations.matchAll(/--s-([\w_]+):([^;]+)/g)];
    assert.equal(colors.length, 10);
    assert.equal(new Set(colors.map(([, , color]) => color.trim().toLowerCase())).size, 10,
      'Running, Sleep, and every other state must have distinct colors');
  }
});

// With memory sampling off the load chart still supplies points, so the
// memory charts must get no points and a reason instead of drawing bare axes.
test('summary memory charts explain sampling that is off or missing', () => {
  const app = dashboard();
  app.run('timeChart=(host,options)=>{host.chart=options}');
  const render = (resources, memory) => {
    app.run(`live={health:{session:'s',pid:7},threads:[],resources:${JSON.stringify(resources)},memory:${JSON.stringify(memory)}};
      buffer.length=0;for(const t of [1,2,3])buffer.push({t,cpu:5,s:{},rss:null,vm:null});renderOverview()`);
    const chart = id => app.elements.get(id).chart;
    return ['chart-rss', 'chart-vm'].map(id => [chart(id).points.length, chart(id).empty]);
  };
  assert.deepEqual(render({available: false, reason: 'Resource sampling is off.'}, undefined),
    [[0, 'Resource sampling is off.'], [0, 'This collector does not report memory-map samples.']]);
  assert.deepEqual(render({available: true, stale: true}, {available: true, stale: true}),
    [[0, 'Waiting for resource samples…'], [0, 'Waiting for memory samples…']]);
  app.run('buffer[1].rss=2**20');
  app.run('renderOverview()');
  assert.equal(app.elements.get('chart-rss').chart.points.length, 3);
});

test('unknown rates stay gaps and resumed samples keep bounded decay', () => {
  const app = dashboard();
  tick(app, 1000, 100);
  tick(app, 1010, null);
  assert.equal(app.run('buffer.at(-1).l1'), null);
  assert.equal(app.run('loadState.t'), 1000);
  tick(app, 1100, 0);
  close(app.run('loadState.averages[2]'), Math.exp(-30 / 900));
});

test('load includes CPU demand and uninterruptible waits', () => {
  const app = dashboard();
  tick(app, 1000, 100, 'session-1', 'kernel', 50);
  assert.equal(app.run('loadState.averages[0]'), 2.5);
});

test('old or invalid saved average state is seeded from retained points', () => {
  for (const loadState of [undefined, {t: 1001, averages: [0]}, {t: 9999, averages: [0, 0, 0]}]) {
    const storage = new Map([['triangulator:buffer', JSON.stringify({session: 'session-1',
      points: [{t: 1000, cpu: 100, rd: 0, s: {}}, {t: 1001, cpu: 0, rd: 0, s: {}}], loadState})]]);
    const app = dashboard(storage);
    app.run("loadBuffer('session-1')");
    close(app.run('loadState.averages[2]'), Math.exp(-1 / 900));
    tick(app, 1002, 0);
    close(app.run('loadState.averages[2]'), Math.exp(-2 / 900));
  }
});

test('custom history interval survives closing and opening another thread', async () => {
  const app = dashboard();
  tick(app, 1000, 0);
  app.run('openThread(live.threads[0])');
  app.elements.get('from').value = '2026-10-05T10:00:00';
  app.elements.get('to').value = '2026-10-05T11:00:00';
  app.elements.get('load-history').onclick();
  app.run("closeThread();openThread({tid:2,name:'other'});closeThread();openThread(live.threads[0])");
  const queries = app.requests.filter(url => url.startsWith('/api/history?')).slice(1);
  assert.equal(queries.length, 3);
  for (const url of queries) {
    const params = new URLSearchParams(url.split('?')[1]);
    assert.equal(Number(params.get('end')) - Number(params.get('start')), 3600);
    assert.equal(Number(params.get('start')), new Date('2026-10-05T10:00:00').getTime() / 1000);
  }
  assert.equal(new URLSearchParams(queries[1].split('?')[1]).get('tid'), '2');
  assert.ok(app.ranges.every(button => button.attrs['aria-pressed'] === 'false'));
  assert.equal(app.elements.get('from').value, '2026-10-05T10:00:00');
  assert.equal(app.elements.get('to').value, '2026-10-05T11:00:00');
  await Promise.resolve();
});

test('a preset replaces a custom range and stays positive on reopen', () => {
  const app = dashboard();
  tick(app, 1000, 0);
  app.run('openThread(live.threads[0])');
  app.elements.get('load-history').onclick();
  app.ranges[0].onclick();
  app.run("closeThread();openThread({tid:2,name:'other'})");
  const params = new URLSearchParams(app.requests.at(-1).split('?')[1]);
  assert.equal(Number(params.get('end')) - Number(params.get('start')), 900);
  assert.equal(app.ranges[0].attrs['aria-pressed'], 'true');
});

// A resource sample as /api/live sends it, with everything healthy.
function resources(overrides = {}) {
  const stall = (some, full = 0) => ({some: {pct: some, avg10: some}, full: {pct: full, avg10: full}});
  return {available: true, stale: false, updated: Date.now() / 1000, sequence: 3, interval_s: 5,
    pressure: {cgroup: {cpu: stall(1), memory: stall(0), io: stall(0)}, host: {cpu: stall(2), memory: stall(0), io: stall(0)}},
    fds: {open: 10, soft_limit: 1024, hard_limit: 4096, sockets: 2},
    io: {read_bps: 0, write_bps: 0},
    sockets: {tcp: {sockets: 2}, tcp_states: {close_wait: 0}, top: [], matched: 2, unmatched: 0, complete: true},
    network: {tcp_out_segs: {delta: 1000, per_s: 200, total: 9}, tcp_retrans_segs: {delta: 0, per_s: 0, total: 1}},
    sockstat: {tcp_mem: 10}, limits: {tcp_mem: [100, 200, 300]}, flags: {}, ...overrides};
}
const findingsOf = (app, sample) => app.run(`assessResources(${JSON.stringify(sample)})`);

test('healthy resources add no findings and missing ones add none', () => {
  const app = dashboard();
  // Arrays from the page's context: compare lengths, not identity.
  assert.equal(findingsOf(app, resources()).length, 0);
  assert.equal(findingsOf(app, {available: false, reason: 'none yet'}).length, 0);
  assert.equal(app.run('assessResources(undefined).length'), 0);
});

test('pressure, descriptor and TCP memory rules use the cgroup when it reports', () => {
  const app = dashboard();
  const sample = resources();
  sample.pressure.cgroup.io = {some: {pct: 40}, full: {pct: 12}};
  sample.pressure.host.memory = {some: {pct: 50}, full: {pct: 50}};  // host only: ignored
  sample.fds.open = 1000;
  sample.network.tcp_memory_pressures = {delta: 1, per_s: .2, total: 3};
  const findings = findingsOf(app, sample);
  const titles = findings.map(item => `${item.level}: ${item.title}`);
  assert.ok(titles.includes('serious: I/O is stalling all work 12.0% of the time'), titles.join('\n'));
  assert.ok(titles.includes('critical: 97.7% of file descriptors in use'), titles.join('\n'));
  assert.ok(titles.includes('serious: TCP is under memory pressure'), titles.join('\n'));
  assert.ok(!titles.some(title => title.includes('memory')&&title.includes('thrashing')), 'host memory is not the cgroup');
  // A first sample has no interval yet: the kernel's 10 s average stands in.
  const first = resources();
  first.pressure.cgroup.memory = {some: {pct: null, avg10: 8}, full: {pct: null, avg10: 0}};
  assert.equal(findingsOf(app, first)[0].title, 'Tasks wait for memory 8.0% of the time');
});

test('cgroup CPU pressure names the quota only when cpu.max may set one', () => {
  const app = dashboard();
  const detail = cpu => {
    const sample = resources();
    sample.pressure.cgroup.cpu = {some: {pct: 40}, full: {pct: 0}};
    sample.cgroup_limits = {cpu};
    return findingsOf(app, sample).find(item => item.title.startsWith('Runnable tasks wait for CPU')).detail;
  };
  assert.equal(detail({quota_us: null, period_us: 100000}),
               'More tasks are runnable than the cores can run. The cgroup has no CPU quota (cpu.max is max).');
  assert.match(detail({quota_us: 50000, period_us: 100000}), /CPU quota \(cpu\.max\)/);
  assert.match(detail({}), /CPU quota \(cpu\.max\)/);
});

test('socket rules name the slow reader, the slow peer and overflowing listeners', () => {
  const app = dashboard();
  const sample = resources();
  sample.sockets.top = [
    {fd: 3, kind: 'tcp4', state: 'LISTEN', listener: true, local: '0.0.0.0:8080', rx_queue: 5, tx_queue: 4, accept_fill_pct: 125},
    {fd: 5, kind: 'tcp4', state: 'ESTAB', listener: false, local: '10.0.0.1:8080', remote: '10.0.0.9:5000',
      rx_queue: 120000, tx_queue: 0, rx_fill_pct: 95, tx_fill_pct: 0, drops: 9, drops_delta: 3, tcp: {retrans: 0}},
    {fd: 6, kind: 'tcp4', state: 'ESTAB', listener: false, local: '10.0.0.1:41000', remote: '10.0.0.7:5432',
      rx_queue: 0, tx_queue: 500000, rx_fill_pct: 0, tx_fill_pct: 40, tcp: {peer_window: 0, probes: 2, retrans: 1}}];
  sample.sockets.tcp_states.close_wait = 12;
  sample.network.listen_overflows = {delta: 4, per_s: .8, total: 9};
  sample.network.listen_drops = {delta: 4, per_s: .8, total: 9};
  sample.network.udp_rcvbuf_errors = {delta: 7, per_s: 1.4, total: 70};
  sample.network.tcp_retrans_segs = {delta: 50, per_s: 10, total: 60};
  const titles = findingsOf(app, sample).map(item => `${item.level}: ${item.title}`);
  for (const expected of [
    'serious: 4 incoming connections dropped',
    'serious: The app is not keeping up reading 10.0.0.1:8080 → 10.0.0.9:5000',
    'warning: 10.0.0.7:5432 is not taking data',
    'serious: 7 UDP datagrams dropped: receive buffers full',
    'warning: 5.0% of TCP segments retransmitted',
    'warning: 12 connections in CLOSE-WAIT']) {
    assert.ok(titles.includes(expected), `${expected}\n--\n${titles.join('\n')}`);
  }
  const notes = app.run(`socketNotes(${JSON.stringify(sample.sockets.top[2])}).map(note=>note[0])`);
  assert.ok(notes.includes('Peer window is zero: the peer is not reading'), notes.join('\n'));
  assert.ok(notes.includes('Zero-window probing (2)'), notes.join('\n'));
});

test('TCP retransmissions become a finding at 2% of segments sent', () => {
  const app = dashboard();
  const sample = resources();
  const retransmitted = delta => {
    sample.network.tcp_retrans_segs = {delta, per_s: delta / 5, total: delta};
    return findingsOf(app, sample).filter(item => item.title.includes('TCP segments retransmitted'))
      .map(item => `${item.level}: ${item.title}`).join('\n');
  };
  assert.equal(retransmitted(15), '');
  assert.equal(retransmitted(20), 'warning: 2.0% of TCP segments retransmitted');
});

test('a socket that is not transferring data is never called a zero-window peer', () => {
  const app = dashboard();
  const sample = resources();
  const syn = {fd: 4, kind: 'tcp4', state: 'SYN-SENT', listener: false, local: '127.0.0.1:46242', remote: '127.0.0.1:49947',
    rx_queue: 0, tx_queue: 1, rx_fill_pct: 0, tx_fill_pct: 0, tcp: {peer_window: 0, rwnd_limited_pct: 50}};
  const unreported = {...syn, state: 'ESTAB', tcp: {peer_window: null}};
  sample.sockets.top = [syn, {...syn, fd: 5, state: 'SYN-RECV'}, unreported];
  assert.ok(!findingsOf(app, sample).some(item => /not taking data/.test(item.title)));
  const notes = item => app.run(`socketNotes(${JSON.stringify(item)}).map(note=>note[0])`);
  const syn_notes = notes(syn);
  assert.ok(syn_notes.some(text => /Connect unanswered: check accept queue/.test(text)), syn_notes.join('\n'));
  assert.ok(!syn_notes.some(text => /window/i.test(text)), syn_notes.join('\n'));
  assert.ok(notes(sample.sockets.top[1]).some(text => /Handshake not finished/.test(text)));
  assert.ok(!notes(unreported).some(text => /window/i.test(text)));
  for (const state of ['ESTAB', 'CLOSE-WAIT']) {
    const open = {...syn, state, tcp: {peer_window: 0}};
    assert.ok(notes(open).includes('Peer window is zero: the peer is not reading'), state);
    sample.sockets.top = [open];
    assert.ok(findingsOf(app, sample).some(item => /not taking data/.test(item.title)), state);
  }
});

test('full send buffers still produce findings outside TCP data states', () => {
  const app = dashboard();
  for (const [kind, state] of [['udp4', 'UNCONN'], ['unix-stream', 'ESTAB'], ['tcp4', 'SYN-SENT']]) {
    const socket = {fd: 8, kind, state, listener: false, local: 'local', remote: 'peer',
      tx_queue: 4096, tx_fill_pct: 95, tcp: {peer_window: 0}};
    const finding = findingsOf(app, resources({sockets: {top: [socket]}})).find(item => /not taking data/.test(item.title));
    assert.ok(finding, `${kind} ${state}`);
    assert.match(finding.detail, /send buffer 95.0% full/);
    assert.doesNotMatch(finding.detail, /zero window/);
  }
});

test('hidden or unreachable sockets are explained, not reported as zero', () => {
  const app = dashboard();
  const hidden = findingsOf(app, resources({flags: {descriptors_hidden: true}}));
  assert.equal(hidden.at(-1).title, 'Socket details hidden');
  const other = findingsOf(app, resources({flags: {other_network_namespace: true}}));
  assert.equal(other.at(-1).title, 'Socket queues unavailable');
  const stale = findingsOf(app, resources({stale: true, updated: Date.now() / 1000 - 120}));
  assert.equal(stale[0].title, 'Resource samples are stale');
  assert.match(stale[0].detail, /since 2 min ago/);
  // A recorded view measures the age from its own time, not the browser clock.
  app.run('replayAt=1000');
  assert.match(findingsOf(app, resources({stale: true, updated: 880}))[0].detail, /since 2 min ago/);
  app.run('replayAt=null');
});

test('socket queue tiles preserve unavailable values and measured zeroes', () => {
  const app = dashboard();
  const queues = (rx, tx) => ({rx_queue: rx, tx_queue: tx});
  const tile = sockets => {
    app.run(`renderResourceTiles(${JSON.stringify(resources({sockets}))},[])`);
    return app.elements.get('resource-tiles').children.find(item => item.children[0].textContent === 'Queued in sockets');
  };
  for (const sockets of [{}, {tcp: queues(null, null), udp: queues(null, null), unix: queues(null, null)},
    {tcp: queues(10, 20), udp: queues(null, null), unix: queues(0, 0)}]) {
    const item = tile(sockets);
    assert.equal(item.children[1].textContent, '—');
    assert.equal(item.children[2].textContent, 'unread — · unsent —');
  }
  const empty = tile({tcp: queues(0, 0), udp: queues(0, 0), unix: queues(0, 0)});
  assert.equal(empty.children[1].textContent, '0 B');
  assert.equal(empty.children[2].textContent, 'unread 0 B · unsent 0 B');
  const full = tile({tcp: queues(10, 20), udp: queues(30, 40), unix: queues(50, 60)});
  assert.equal(full.children[1].textContent, '210 B');
  assert.equal(full.children[2].textContent, 'unread 90 B · unsent 120 B');
  const partial = tile({tcp: queues(10, null), udp: queues(0, 0), unix: queues(0, 0)});
  assert.equal(partial.children[1].textContent, '—');
  assert.equal(partial.children[2].textContent, 'unread 10 B · unsent —');
});

test('resource range changes keep one polling loop, including overlapping requests and failures', async () => {
  const response = {ok: true, json: async () => ({rows: []})};
  const app = dashboard(new Map(), undefined, {resourceFetch: async () => response});
  await new Promise(setImmediate);
  assert.equal(app.timers.size, 1);
  const pending = [];
  const requests = [];
  app.setFetch(url => {
    requests.push(url);
    return new Promise(resolve => pending.push(resolve));
  });
  app.resourceRanges[1].onclick();
  app.resourceRanges[2].onclick();
  assert.equal(app.timers.size, 1, 'range refreshes leave the existing poll timer alone');
  for (const [index, url] of requests.entries()) {
    const params = new URLSearchParams(url.split('?')[1]);
    assert.equal(Number(params.get('end')) - Number(params.get('start')), [3600, 21600][index]);
  }
  const firePoll = async () => {
    assert.equal(app.timers.size, 1);
    const [id, timer] = [...app.timers][0];
    assert.equal(timer.delay, 5000);
    app.timers.delete(id);
    await timer.callback();
    assert.equal(app.timers.size, 1);
  };
  app.setFetch(async () => response);
  await firePoll();
  pending.forEach(resolve => resolve(response));
  await new Promise(setImmediate);
  assert.equal(app.timers.size, 1, 'overlapping range responses do not create more timers');
  app.setFetch(async () => {throw Error('Connection lost');});
  await firePoll();
  app.setFetch(async () => response);
  await firePoll();
});

// Checks that a saturated thread is called a polling or yield loop only when
// most of its CPU is system time and it switches context often, and stays a
// plain "saturating a core" for user-space spins, buffer-copying syscall users
// and collectors that send no system_pct.
test('saturated threads are told apart by kernel share and switch rate', () => {
  const app = dashboard();
  const describe = fields => {
    const thread = {tid: 7, name: 'worker-1', cpu_pct: 99, system_pct: 0, switches_per_s: 0,
      run_delay_pct: 0, state: 'running', ...fields};
    app.run(`live={health:{session:'s'},threads:[${JSON.stringify(thread)}]}`);
    return app.run(`assess(live.threads,[]).find(item=>item.title.includes('saturating'))`);
  };
  const yielding = describe({system_pct: 97, switches_per_s: 250});
  assert.equal(yielding.title, 'worker-1 is saturating a core in the kernel');
  assert.match(yielding.detail, /99\.0% of one core, 98\.0% of it in the kernel, with 250 context switches\/s/);
  assert.match(yielding.detail, /polling or yield loop/);
  assert.equal(describe({system_pct: 0.1, switches_per_s: 190}).title,
    'worker-1 is saturating a core', 'a user-space spin stays plain');
  assert.equal(describe({system_pct: 95, switches_per_s: 5}).title,
    'worker-1 is saturating a core', 'kernel time without frequent switching stays plain');
  assert.equal(describe({system_pct: 30, switches_per_s: 250}).title,
    'worker-1 is saturating a core', 'mostly user time stays plain');
  assert.equal(describe({system_pct: 55, switches_per_s: 3000}).title,
    'worker-1 is saturating a core in the kernel', 'a contended yield loop measures about half');
  assert.equal(describe({system_pct: undefined, switches_per_s: 250}).title,
    'worker-1 is saturating a core', 'older collectors send no system_pct');
  app.run("live={health:{session:'s'},threads:[]}");
});

test('resource assessment joins the overview assessment', () => {
  const app = dashboard();
  const sample = resources();
  sample.fds.open = 1000;
  app.run(`live={health:{session:'s'},threads:[],resources:${JSON.stringify(sample)}}`);
  const titles = app.run('assess([],[]).map(item=>item.title)');
  assert.ok(titles.includes('97.7% of file descriptors in use'), titles.join('\n'));
  app.run(`live.resources=${JSON.stringify(resources())}`);
  assert.equal(app.run('assess([],[])[0].detail'),
    'No saturated threads, CPU waiting, kernel stalls, paging, resource pressure, exhausted limits or full socket buffers right now.');
});

// The latest exit stays in /api/live after the target changes, so the
// Assessment must tie it to the absence it describes.
test('an exit describes only the absence that followed it', () => {
  const exit = {pid: 100, process_start: 5, name: 'app', ended_at: 1000, reason: 'segfault',
    kernel_log: 'read', error: null, messages: [], session: 'a', next_session: 'x'};
  const app = dashboard();
  const absent = session => app.run(`live={health:{session:${JSON.stringify(session)},target_absent:true,pid:0},
    threads:[],exit:${JSON.stringify(exit)}}`);
  absent('x');
  const titles = () => JSON.parse(app.run('JSON.stringify(assess([],[]).map(item=>item.title))'));
  assert.deepEqual(titles(), ['Target process ended · Segmentation fault']);
  assert.equal(app.run('targetName()'), 'app');
  // A target selected afterwards and never found: the session is another one.
  absent('y');
  assert.deepEqual(titles(), ['Target process is absent']);
  assert.equal(app.run('targetName()'), 'the target');
  // A running target is not described by the old exit.
  app.run(`live.health.target_absent=false;live.health.session='x'`);
  assert.equal(app.run('endedTarget()'), null);
  assert.ok(!titles().some(title => /absent|ended/.test(title)));
});

// abort() and a crash handler leave no kernel message, so the reason comes
// from the exit status. Once another process runs, the card folds to one line
// so an old crash does not look current; a reader's own toggle is kept.
test('the exit status names unlogged crashes and an earlier exit folds', () => {
  const exit = {pid: 100, process_start: 5, name: 'app', ended_at: 1000, reason: 'crashed', signal: 6,
    signal_name: 'SIGABRT', core_dumped: true, exit_code: null, kernel_log: 'unreadable',
    error: 'Operation not permitted', messages: [], session: 'a', next_session: 'x', count: 3};
  const app = dashboard();
  const reason = value => JSON.parse(app.run(`JSON.stringify(exitReason(${JSON.stringify({...exit, ...value})}).slice(0,2))`));
  assert.deepEqual(reason({}), ['Crashed: SIGABRT', 'critical']);
  assert.deepEqual(reason({reason: 'killed', signal: 9, signal_name: 'SIGKILL', core_dumped: false}),
    ['Killed by SIGKILL', 'warning']);
  assert.deepEqual(reason({reason: 'exited', signal: null, exit_code: 3}), ['Exited with code 3', 'warning']);
  assert.deepEqual(reason({reason: 'exited', signal: null, exit_code: 0}), ['Exited normally', 'good']);
  assert.deepEqual(reason({reason: 'segfault'}), ['Segmentation fault', 'critical']);

  app.run(`live={health:{session:'x',target_absent:true,pid:0},threads:[],exit:${JSON.stringify(exit)}};renderExit()`);
  const card = app.elements.get('exit-card');
  assert.equal(card.open, true);
  assert.equal(app.elements.get('exit-reason').textContent, 'Crashed: SIGABRT');
  assert.equal(app.elements.get('exit-status').textContent, 'Exit status: SIGABRT (signal 6), core dumped.');
  assert.match(app.elements.get('exit-explain').textContent, /abort\(\).*kernel log was not readable/);
  assert.match(app.elements.get('exit-sub').textContent, /3 exits since the collector started/);
  // The restarted process is the target now.
  app.run(`live.health={session:'y',target_absent:false,pid:200};renderExit()`);
  assert.equal(card.open, false);
  assert.match(app.elements.get('exit-brief').textContent, /^app · PID 100 · .* · 3 exits since the collector started$/);
  card.open = true;
  app.run('renderExit()');
  assert.equal(card.open, true);
  // The next crash opens it again while its process is absent.
  app.run(`live={health:{session:'z',target_absent:true,pid:0},threads:[],
    exit:${JSON.stringify({...exit, pid: 200, next_session: 'z', count: 4})}};renderExit()`);
  assert.equal(card.open, true);
});

// Threads as the live API reports them. A thread sat in `state` for the whole
// window, used `cpu` percent of a core, and switched `sw` times a second.
function lockThread(tid, name, state, {cpu = 0, sw = 0} = {}) {
  return {tid, name, state, wchan: state === 'futex' ? 'futex_do_wait' : '', cpu_pct: cpu, switches_per_s: sw,
    state_mix: {[state]: 20}, run_delay_pct: 0, read_bps: 0, write_bps: 0, major_faults_per_s: 0,
    last_sample: 1000, stale: false, generation: 0};
}

// Show `threads` to the dashboard with `seen` seconds of observed history.
function lockHints(threads, seen) {
  const app = dashboard();
  app.run(`live={health:{session:'s'},threads:${JSON.stringify(threads)}};lastTick=1000;
    for(const thread of live.threads)threadSeen.set(thread.tid,{first:${1000 - seen},active:null,futexSince:${1000 - seen},generation:0})`);
  return [...app.run('lockHints(live.threads).map(item=>item.title+"|"+item.detail)')];
}

test('threads stuck on a futex while others run raise a hint, not a verdict', () => {
  const beat = lockThread(1, 'misc-heartbeat', 'sleep', {cpu: 0.2, sw: 2});
  const stuck = [lockThread(2, 'worker-a', 'futex'), lockThread(3, 'worker-b', 'futex')];
  const hints = lockHints([beat, ...stuck], 45);
  assert.equal(hints.length, 1, hints.join('\n'));
  assert.match(hints[0], /^2 threads have waited on a futex for over 45 s while other threads are active\|Possible deadlock/);
  assert.match(hints[0], /worker-a \(2\), worker-b \(3\)/);
  const app = dashboard();
  app.run(`live={health:{session:'s'},threads:${JSON.stringify([beat, ...stuck])}};lastTick=1000;
    for(const thread of live.threads)threadSeen.set(thread.tid,{first:955,active:null,futexSince:955,generation:0})`);
  assert.deepEqual([...app.run('assess(live.threads,[]).map(item=>item.level)')], ['good', 'info']);
  // Not long enough yet, or only one thread, or nothing else running: quiet.
  assert.deepEqual(lockHints([beat, ...stuck], 20), []);
  assert.deepEqual(lockHints([beat, stuck[0]], 45), []);
  assert.deepEqual(lockHints(stuck, 45), []);
});

test('futex duration excludes earlier sleep and resets after a state change', () => {
  const app = dashboard();
  const threads = [lockThread(1, 'heartbeat', 'running', {cpu: 5}),
    lockThread(2, 'worker-a', 'sleep'), lockThread(3, 'worker-b', 'sleep')];
  app.run(`live={health:{session:'s'},threads:${JSON.stringify(threads)}}`);
  const feed = (time, state) => app.run(`for(const thread of live.threads){thread.last_sample=${time};if(thread.tid!==1){thread.state='${state}';thread.state_mix={${state}:20}}}ingest()`);
  feed(1000, 'sleep');
  feed(1060, 'sleep');
  feed(1061, 'futex');
  feed(1080, 'futex');
  assert.equal(app.run('lockHints(live.threads).length'), 0);
  feed(1091, 'futex');
  assert.equal(app.run('lockHints(live.threads).length'), 1);
  feed(1092, 'sleep');
  feed(1093, 'futex');
  assert.equal(app.run('lockHints(live.threads).length'), 0);
});

test('idle pool workers on a futex stay quiet', () => {
  const main = lockThread(1, 'main', 'running', {cpu: 30, sw: 50});
  // A pool with one busy worker: the idle ones are spare capacity.
  const busyPool = [lockThread(2, 'pool-1', 'running', {cpu: 5, sw: 40}),
    ...[3, 4, 5, 6].map(tid => lockThread(tid, `pool-${tid}`, 'futex'))];
  assert.deepEqual(lockHints([main, ...busyPool], 600), []);
  // A pool that is wholly idle next to an active thread looks like an idle pool.
  const idlePool = [2, 3, 4, 5].map(tid => lockThread(tid, `pool-${tid}`, 'futex'));
  assert.deepEqual(lockHints([main, ...idlePool], 600), []);
  // Idle workers that wake now and then are not parked; a thread that is not
  // in a futex is never reported.
  const sleepers = [2, 3].map(tid => lockThread(tid, `timer-${tid}x`, 'sleep'));
  assert.deepEqual(lockHints([main, ...sleepers], 600), []);
  // No history in the tab (for example in replay) means no claim.
  const app = dashboard();
  app.run(`live={health:{session:'s'},threads:${JSON.stringify([main, lockThread(7, 'a', 'futex'), lockThread(8, 'b', 'futex')])}};lastTick=1000`);
  assert.equal(app.run('lockHints(live.threads).length'), 0);
});

test('many futex waiters that keep waking with little CPU raise a convoy hint', () => {
  const convoy = [...Array(8).keys()].map(index => {
    const thread = lockThread(10 + index, `worker-${index}`, index ? 'futex' : 'sleep', {cpu: 0.2, sw: 15});
    thread.state_mix = {futex: 17, sleep: 3};
    return thread;
  });
  const hints = lockHints(convoy, 45);
  assert.equal(hints.length, 1, hints.join('\n'));
  assert.match(hints[0], /^8 of 8 “worker” threads mostly wait on a futex but keep waking\|Together they used 1\.6% of one core and switched 120 times\/s/);
  // Waiting workers that do not wake (an idle pool), busy workers, and small families are quiet.
  assert.deepEqual(lockHints(convoy.map(thread => ({...thread, switches_per_s: 0, cpu_pct: 0})), 45), []);
  assert.deepEqual(lockHints(convoy.map(thread => ({...thread, cpu_pct: 20})), 45), []);
  assert.deepEqual(lockHints(convoy.slice(0, 3), 45), []);
  assert.deepEqual(lockHints(convoy.map(thread => ({...thread, state_mix: {running: 15, futex: 5}})), 45), []);
});

// A memory summary as /api/live sends it; limits far away unless overridden.
const memorySummary = (values = {}, extra = {}) => ({available: true, stale: false, pid: 1, updated: 1,
  values: {vma_count: 100, max_map_count: 65530, vm_size_bytes: 1e9, address_space_limit_bytes: 0, stack_limit_bytes: 8 << 20, ...values}, ...extra});
const levelsOf = app => [...app.run('assess(live.threads,buffer).map(item=>item.level+": "+item.title)')];

test('memory-map warnings join the overview assessment and set the verdict', () => {
  const app = dashboard();
  const verdict = () => app.elements.get('verdict').textContent;
  const render = () => app.run('realRenderAssessment(live.threads)');
  // vm-bloat: the address space is almost at RLIMIT_AS.
  const bloated = memorySummary({vm_size_bytes: 950e6, address_space_limit_bytes: 1000e6});
  app.run(`live={health:{session:'s'},threads:[],memory:${JSON.stringify(bloated)}}`);
  assert.deepEqual(levelsOf(app), ['critical: Address space is close to RLIMIT_AS']);
  render();
  assert.equal(verdict(), 'Needs attention now');
  // A warning alone makes it "Worth a look".
  app.run(`live.memory=${JSON.stringify(memorySummary({vma_count: 50000}))}`);
  render();
  assert.equal(verdict(), 'Worth a look');
  assert.deepEqual(levelsOf(app), ['warning: Mapping count is close to the limit']);
});

test('the assessment lists 8 findings and shows the rest on request', () => {
  const app = dashboard();
  const titles = () => app.elements.get('findings').children.map(row => row.children[1].children[0].textContent);
  const more = () => app.elements.get('findings-more');
  const findings = count => JSON.stringify(Array.from({length: count}, (_, index) => ({level: index ? 'warning' : 'critical', title: 'F' + index, detail: ''})));
  app.run(`renderAssessment=realRenderAssessment;live={health:{session:'s'},threads:[]};assess=()=>${findings(10)};renderAssessment([])`);
  assert.deepEqual(titles(), ['F0', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7']);
  assert.equal(more().hidden, false);
  assert.equal(more().textContent, 'Show 2 more findings');
  assert.equal(more().attrs['aria-expanded'], 'false');
  more().onclick();
  assert.equal(titles().length, 10);
  assert.equal(more().textContent, 'Show fewer findings');
  assert.equal(more().attrs['aria-expanded'], 'true');
  // A poll keeps the choice.
  app.run('realRenderAssessment([])');
  assert.equal(titles().length, 10);
  more().onclick();
  assert.equal(titles().length, 8);
  app.run(`assess=()=>${findings(9)};realRenderAssessment([])`);
  assert.equal(more().textContent, 'Show 1 more finding');
  app.run(`assess=()=>${findings(8)};realRenderAssessment([])`);
  assert.equal(more().hidden, true);
});

test('growing resident memory joins the overview assessment', () => {
  const app = dashboard();
  const now = Date.now() / 1000;
  const rows = Array.from({length: 8}, (_, index) => ({ts: now - 70 + index * 10, pid: 1, rss_bytes: 100e6 + index * 50e6}));
  app.run(`live={health:{session:'s',pid:1},threads:[],memory:${JSON.stringify(memorySummary())},resources:${JSON.stringify(resources())}};resourceHistory={rows:${JSON.stringify(rows)}}`);
  assert.deepEqual(levelsOf(app), ['warning: Resident memory grows without a plateau']);
});

test('info and good memory findings stay out of the overview assessment', () => {
  const app = dashboard();
  // The main stack at half of its limit is only an info finding in the Memory section.
  const layout = {id: 's:1', pid: 1, regions: [{start: '0x7ffc00000000', end: '0x7ffc00400000', size: 4 << 20, vmas: 1, kind: 'stack', permissions: 'rw-p', name: ''}]};
  app.run(`live={health:{session:'s'},threads:[],memory:${JSON.stringify(memorySummary({}, {layout_id: 's:1'}))}};memoryLayout=${JSON.stringify(layout)}`);
  assert.ok(app.run('assessMemory(live.memory,memoryRegions(memoryLayout),[]).some(item=>item.level==="info")'));
  assert.deepEqual(levelsOf(app), ['good: No problems detected']);
  assert.equal(app.run('assess([],[])[0].detail'), 'No saturated threads, CPU waiting, kernel stalls or paging right now. No memory-map warnings detected in the available samples.');
  // The stack rule works from the layout when it matches.
  layout.regions[0].end = '0x7ffc00700000'; layout.regions[0].size = 0x700000;
  app.run(`memoryLayout=${JSON.stringify(layout)}`);
  assert.deepEqual(levelsOf(app), ['warning: Main stack is at 87.5% of its limit']);
});

test('without usable memory samples the overview ignores the memory map', () => {
  const app = dashboard();
  const bloated = memorySummary({vm_size_bytes: 950e6, address_space_limit_bytes: 1000e6});
  const healthy = 'No saturated threads, CPU waiting, kernel stalls or paging right now.';
  for (const memory of [undefined, {available: false, reason: 'memory sampling is off'}, {...bloated, stale: true}]) {
    app.run(`live={health:{session:'s'},threads:[],memory:${JSON.stringify(memory)}}`);
    assert.equal(app.run('memoryOverviewFindings()'), null);
    assert.equal(app.run('assess([],[])[0].detail'), healthy);
  }
});

test('an older stack layout cannot supply a current overview finding', () => {
  const app = dashboard();
  const memory = memorySummary({}, {layout_id: 's:2'});
  const layout = {id: 's:1', pid: 1, regions: [{start: '0x7ffc00000000', end: '0x7ffc00700000',
    size: 0x700000, vmas: 1, kind: 'stack', permissions: 'rw-p', name: ''}]};
  app.run(`live={health:{session:'s',pid:1},threads:[],memory:${JSON.stringify(memory)}};memoryLayout=${JSON.stringify(layout)}`);
  assert.deepEqual(levelsOf(app), ['good: No problems detected']);
  app.run("memoryLayout.id='s:2'");
  assert.deepEqual(levelsOf(app), ['warning: Main stack is at 87.5% of its limit']);
});

test('a memory fault finding replaces the thread one only when it is more severe', () => {
  const app = dashboard();
  const thread = {tid: 7, name: 'worker', state: 'running', major_faults_per_s: 80};
  const load = memoryPressure => {
    const sample = resources();
    for (const scope of ['host', 'cgroup']) sample.pressure[scope].memory = {some: {pct: memoryPressure}, full: {pct: 0}};
    app.run(`live={health:{session:'s'},threads:[${JSON.stringify(thread)}],memory:${JSON.stringify(memorySummary())},resources:${JSON.stringify(sample)}};buffer=[{t:1,mf:80}]`);
  };
  // Faults and pressure: the serious memory finding replaces the warning and keeps the thread link.
  load(20);
  assert.equal(levelsOf(app).filter(title => /fault/.test(title)).join(), 'serious: Major page faults and memory pressure rise together');
  assert.equal(app.run('assess(live.threads,buffer).find(item=>item.topic==="faults").action.tid'), 7);
  // Faults without pressure at 80/s: both rules are warnings; one line remains, the thread one.
  load(0);
  assert.deepEqual(levelsOf(app), ['warning: 80.0 major page faults/s']);
});

test('memory, CPU quota, process count and interface rules', () => {
  const app = dashboard();
  const sample = resources({
    memory: {rss: 900e6, peak: 950e6, swap: 0},
    cgroup_limits: {memory: {current: 950e6, max: 1e9, oom_kill_delta: 0, max_events_delta: 0},
      cpu: {quota_us: 50000, period_us: 100000, throttled_pct: 30}, pids: {current: 95, max: 100}}});
  sample.network.if_rx_dropped = {delta: 4}; sample.network.if_tx_dropped = {delta: 0};
  sample.network.if_rx_errors = {delta: 1}; sample.network.if_tx_errors = {delta: 0};
  let titles = findingsOf(app, sample).map(item => `${item.level}: ${item.title}`);
  for (const expected of ['warning: Cgroup memory is 95.0% of its limit', 'serious: CPU quota throttled 30.0% of periods',
    'warning: 95 of 100 processes and threads in use', 'warning: Network interfaces dropped 4 and reported 1 errors']) {
    assert.ok(titles.includes(expected), `${expected}\n--\n${titles.join('\n')}`);
  }
  sample.cgroup_limits.memory.max_events_delta = 3;
  titles = findingsOf(app, sample).map(item => item.title);
  assert.ok(titles.includes('Memory limit reached') && !titles.some(title => title.startsWith('Cgroup memory is')));
  sample.cgroup_limits.memory.oom_kill_delta = 1;
  assert.equal(findingsOf(app, sample)[0].title, '1 process killed by the OOM killer');
  // No limits (all null) and a healthy cgroup add nothing.
  const quiet = resources({cgroup_limits: {memory: {current: 5e8, max: null}, cpu: {quota_us: null, throttled_pct: null}, pids: {current: 3, max: null}}});
  assert.equal(findingsOf(app, quiet).length, 0);
});

// Thread counts at one sample per second from t=1000, as {t, n} points.
const countsAt = (seconds, count) => Array.from({length: seconds}, (_, i) => ({t: 1000 + i, n: count(i)}));
// Whether the growth rule fires at any moment while the counts arrive.
const growthEver = (app, points) => app.run(`(()=>{const all=${JSON.stringify(points)};
  for(let i=1;i<=all.length;i++)if(threadGrowth(all.slice(0,i)))return i;return 0})()`);

test('a steady thread leak is flagged with its rate, count and cgroup headroom', () => {
  const app = dashboard();
  const points = countsAt(180, i => 4 + Math.floor(i * 4));
  app.run("live={health:{session:'s'},threads:[]}");
  const findings = app.run(`assess([],${JSON.stringify(points)})`);
  const finding = findings.find(item => item.title === 'Thread count keeps growing');
  assert.equal(finding.level, 'warning');
  assert.match(finding.detail, /\d+ to \d{3} threads in \d\.\d min, \+2\d\d threads\/min, and still rising/);
  assert.match(finding.detail, /No cgroup pids\.max is known/);
  assert.ok(!findings.some(item => item.level === 'good'));
  // The rule needs about two minutes of data: it fires in the third minute, not the first.
  const first = growthEver(app, points);
  assert.ok(first >= 120 && first <= 150, `fired after ${first} s`);
  // A slow leak (one thread every 4 s, 15 threads/min) shows over five minutes.
  const slow = countsAt(330, i => 40 + Math.floor(i / 4));
  assert.ok(growthEver(app, slow) > 0);
});

test('thread growth needs two minutes of continuous observations', () => {
  const app = dashboard();
  const sparse = countsAt(250, i => 4 + i * 4).filter((_, i) => i % 30 === 0);
  assert.equal(app.run(`threadGrowth(${JSON.stringify(sparse)})`), null);
  assert.equal(growthEver(app, countsAt(120, i => 4 + i * 4)), 0);
  const points = countsAt(180, i => 4 + i * 4);
  const growth = app.run(`threadGrowth(${JSON.stringify(points)})`);
  close(growth.rate, 240);
  assert.ok(growth.minutes >= 2);
});

test('thread growth escalates when the cgroup limit is close', () => {
  const app = dashboard();
  const points = JSON.stringify(countsAt(150, i => 4 + i * 4));
  const run = pids => {
    app.run(`live={health:{session:'s'},threads:[],resources:${JSON.stringify(resources({cgroup_limits: {pids}}))}}`);
    return app.run(`assess([],${points}).find(item=>item.title==='Thread count keeps growing')`);
  };
  assert.equal(run({current: 604, max: 100000}).level, 'warning');
  assert.match(run({current: 604, max: 100000}).detail, /full in about \d+ min/);
  const soon = run({current: 604, max: 1000});
  assert.equal(soon.level, 'serious');
  assert.match(soon.detail, /allows 1000 processes and threads \(604 in use\); at this rate it is full in about 2 min/);
  assert.equal(run({current: 800, max: 1000}).level, 'serious');
  assert.match(run({current: 3, max: null}).detail, /No cgroup pids\.max is known/);
});

test('pools warming up, restarts, churn and noise are not thread growth', () => {
  const app = dashboard();
  // A pool that ramps from 8 to 200 threads in 40 s, then stays there.
  assert.equal(growthEver(app, countsAt(600, i => Math.min(200, 8 + i * 5))), 0);
  // A slower ramp that stops after a minute.
  assert.equal(growthEver(app, countsAt(600, i => Math.min(300, 20 + i * 5))), 0);
  // Growth for less than two minutes.
  assert.equal(growthEver(app, countsAt(100, i => 4 + i * 4)), 0);
  // A restart: 300 threads, then 2, rebuilt to 100 within 25 s, then steady.
  assert.equal(growthEver(app, countsAt(600, i => i < 200 ? 300 : Math.min(100, 2 + (i - 200) * 4))), 0);
  // A steady count, and one that bursts with short-lived threads.
  assert.equal(growthEver(app, countsAt(400, () => 50)), 0);
  assert.equal(growthEver(app, countsAt(400, i => 50 + (i % 20 < 5 ? 30 : 0))), 0);
  // A pool that scales in and out around the same level, never settling higher.
  assert.equal(growthEver(app, countsAt(600, i => 100 + 40 * Math.sin(i / 20))), 0);
  // Missing counts do not matter.
  assert.equal(app.run('threadGrowth([])'), null);
  assert.equal(app.run('threadGrowth([{t:1,n:null},{t:2,n:null}])'), null);
});

function frame(time, session = 'old-session', tid = 9) {
  return {recorded_at: time, health: {session, pid: tid, last_seen: time, sample_interval_ms: 1000},
    groups: {workers: 1}, threads: [{tid, name: 'old-worker', generation: 1, group: 'workers',
      last_sample: time, state: 'futex', wchan: 'futex_wait', cpu: 3, cpu_pct: 25,
      run_delay_pct: 0, switches_per_s: 2, read_bps: 0, write_bps: 0}]};
}
const jsonResponse = data => Promise.resolve({ok: true, json: async () => data});

test('historical inspection freezes the process and restores saved live trends', async () => {
  const saved = frame(1000);
  const app = dashboard(new Map(), url => url.startsWith('/api/replay?')
    ? jsonResponse({first: 900, last: 1100, interval_s: 1, snapshot: saved}) : undefined);
  tick(app, 2000, 100);
  tick(app, 2001, 0);
  app.run('latestLive=live');
  const before = app.run('JSON.stringify(buffer)');
  await app.run('inspectTime(1000)');
  assert.equal(app.run('replayAt'), 1000);
  assert.equal(app.run('live.health.session'), 'old-session');
  assert.equal(app.run('buffer.length'), 1);
  assert.equal(app.elements.get('socket-panel').hidden, true);
  assert.equal(app.elements.get('hero-load').textContent, '—');
  assert.equal(app.elements.get('hero-cpu').textContent, '0.25 cores');
  app.run('openThread(live.threads[0])');
  const query = new URLSearchParams(app.requests.at(-1).split('?')[1]);
  assert.equal(query.get('session'), 'old-session');
  assert.equal(query.get('tid'), '9');
  assert.equal(Number(query.get('end')), 1000);
  app.run('saveBuffer()');
  assert.equal(JSON.parse(app.storage.get('triangulator:buffer')).session, 'session-1');
  app.run('returnLive()');
  assert.equal(app.run('replayAt'), null);
  assert.equal(app.run('selected'), null);
  assert.equal(app.run('live.health.session'), 'session-1');
  assert.equal(app.run('JSON.stringify(buffer)'), before);
  assert.equal(app.elements.get('socket-panel').hidden, false);
});

test('late replay replies cannot overwrite a newer selection or a return to live', async () => {
  const pending = [];
  const app = dashboard(new Map(), url => url.startsWith('/api/replay?')
    ? new Promise(resolve => pending.push(resolve)) : undefined);
  tick(app, 2000, 0);
  app.run('latestLive=live');
  const older = app.run('inspectTime(900)');
  const newer = app.run('inspectTime(1000)');
  pending[1]({ok: true, json: async () => ({first: 900, last: 1000, snapshot: frame(1000)})});
  await newer;
  pending[0]({ok: true, json: async () => ({first: 900, last: 1000, snapshot: frame(900)})});
  await older;
  assert.equal(app.run('replayAt'), 1000);
  const abandoned = app.run('inspectTime(900)');
  app.run('returnLive()');
  pending[2]({ok: true, json: async () => ({first: 900, last: 1000, snapshot: frame(900)})});
  await abandoned;
  assert.equal(app.run('replayAt'), null);
  assert.equal(app.run('live.health.session'), 'session-1');
});

test('missing recordings and gaps are explicit and never replace a successful view', async () => {
  let snapshot = frame(1000);
  const app = dashboard(new Map(), url => url.startsWith('/api/replay?')
    ? jsonResponse({first: 1000, last: 1000, interval_s: 1, snapshot}) : undefined);
  tick(app, 2000, 0);
  await app.run('inspectTime(1500)');
  assert.match(app.elements.get('replay-note').textContent, /recording gap/);
  snapshot = null;
  await app.run('inspectTime(900)');
  assert.equal(app.run('replayAt'), 1000);
  assert.match(app.elements.get('replay-note').textContent, /No recording at or before/);
  await app.run('inspectTime(NaN)');
  assert.match(app.elements.get('replay-note').textContent, /valid time/);
});


test('slow live polling cannot overwrite the historical process view', async () => {
  let resolveLive;
  const app = dashboard(new Map(), url => url.startsWith('/api/replay?')
    ? jsonResponse({first: 1000, last: 1000, snapshot: frame(1000)})
    : url === '/api/live' ? new Promise(resolve => {resolveLive = resolve;}) : undefined);
  await app.run('inspectTime(1000)');
  resolveLive({ok: true, json: async () => frame(2000, 'current-session', 10)});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.run('live.health.session'), 'old-session');
  assert.equal(app.run('latestLive.health.session'), 'current-session');
  assert.equal(app.run('replayAt'), 1000);
  app.run('returnLive()');
  assert.equal(app.run('live.health.session'), 'current-session');
});

test('a recorded view shows no live socket totals', async () => {
  const app = dashboard(new Map(), url => url.startsWith('/api/replay?')
    ? jsonResponse({first: 1000, last: 1000, snapshot: frame(1000)}) : undefined);
  tick(app, 2000, 0);
  app.run('socketData={available:true,totals:{input:{current:5},output:{current:6}},history:[]}');
  app.run('sparkline=()=>({})');
  const labels = () => app.run('realRenderTiles(live.threads,[]);element("tiles").children')
    .map(tile => tile.children[0].textContent);
  assert.ok(labels().includes('Socket received'));
  await app.run('inspectTime(1000)');
  assert.ok(!labels().includes('Socket received'));
  assert.ok(!labels().includes('Socket sent'));
});

test('recordings ahead of the browser clock can still be inspected', async () => {
  const ahead = Math.floor(Date.now() / 1000) + 30;
  const app = dashboard(new Map(), url => url.startsWith('/api/replay?')
    ? jsonResponse({first: ahead, last: ahead, snapshot: frame(ahead)}) : undefined);
  tick(app, 2000, 0);
  await app.run(`inspectTime(${ahead})`);
  assert.equal(app.run('replayAt'), ahead);
  await app.run('inspectTime(-1)');
  assert.match(app.elements.get('replay-note').textContent, /valid time/);
});

test('returning to live restores the chosen thread map window', async () => {
  const app = dashboard(new Map(), url => url.startsWith('/api/replay?')
    ? jsonResponse({first: 900, last: 1000, snapshot: frame(1000)}) : undefined);
  tick(app, 2000, 0);
  app.run('latestLive=live;setMapWindow(300)');
  await app.run('inspectTime(1000)');
  assert.equal(app.run('mapWindow'), 0);
  await app.run('inspectTime(1000,"previous")');
  await app.run('returnLive()');
  assert.equal(app.run('mapWindow'), 300);
});

// Assessment history filters by the area a rule looks at.
test('findings carry the type that Assessment history filters by', () => {
  const app = dashboard();
  const sample = resources();
  sample.fds.open = 1000;
  app.run(`live={health:{session:'s',packet_loss_pct:5},threads:[{tid:7,name:'spin',cpu_pct:99,state:'running'}],
    resources:${JSON.stringify(sample)}}`);
  const types = JSON.parse(app.run('JSON.stringify(Object.fromEntries(assess(live.threads,[]).map(item=>[item.title,item.type])))'));
  assert.equal(types['Packet loss 5.0%'], 'monitor');
  assert.equal(types['spin is saturating a core'], 'threads');
  assert.equal(types['97.7% of file descriptors in use'], 'resources');
});

// One finding in consecutive scanned views is one row: its worst level, and
// the time and wording of that worst view. A view with no recording ends it.
test('history episodes join consecutive findings and end at a recording gap', () => {
  const app = dashboard();
  const finding = (level, title, tid) => ({type: 'threads', level, title, detail: title, action: tid ? {tid} : undefined});
  const samples = [
    {at: 10, findings: [finding('warning', '2 threads in uninterruptible kernel wait'), {level: 'good', title: 'No problems detected'}]},
    {at: 20, findings: [finding('serious', '3 threads in uninterruptible kernel wait'), finding('serious', 'a-1 is saturating a core', 1)]},
    {at: 30, findings: [finding('warning', '2 threads in uninterruptible kernel wait'), finding('serious', 'a-2 is saturating a core', 2)]},
    null,
    {at: 50, findings: [finding('warning', '1 thread in uninterruptible kernel wait')]},
  ];
  const episodes = JSON.parse(app.run(`JSON.stringify(historyEpisodes(${JSON.stringify(samples)}))`));
  assert.deepEqual(episodes.map(episode => [episode.item.title, episode.level, episode.at, episode.first, episode.last, episode.count]), [
    ['1 thread in uninterruptible kernel wait', 'warning', 50, 50, 50, 1],
    ['a-2 is saturating a core', 'serious', 30, 30, 30, 1],
    ['a-1 is saturating a core', 'serious', 20, 20, 20, 1],
    ['3 threads in uninterruptible kernel wait', 'serious', 20, 10, 30, 3],
  ]);
});

// A dashboard whose collector has recordings from `first` to `last` (one a
// second); snapshotAt(at) gives the view for a request and resourcesIn(start,
// end) the stored resource rows. Patch the checkbox query the DOM substitute
// does not answer.
function historyApp(snapshotAt, bounds = {first: 1000, last: 1900}, resourcesIn = () => []) {
  const app = dashboard(new Map(), url => {
    if (url === '/api/replay') return jsonResponse({...bounds, interval_s: 1, snapshot: null});
    if (url.startsWith('/api/resources?')) {
      const query = new URLSearchParams(url.split('?')[1]);
      return jsonResponse({rows: resourcesIn(Number(query.get('start')), Number(query.get('end')))});
    }
    if (!url.startsWith('/api/replay?')) return undefined;
    const query = new URLSearchParams(url.split('?')[1]);
    return jsonResponse({...bounds, interval_s: 1, snapshot: snapshotAt(Number(query.get('at')), query.get('direction'))});
  });
  app.bounds = bounds;
  app.run(`var boxes=${JSON.stringify(['critical', 'serious', 'warning', 'info'].map(value => ({value, checked: value !== 'info'})))};
    document.querySelectorAll=(original=>selector=>selector==="#history-levels input"?boxes:original(selector))(document.querySelectorAll);
    element("history-list").scrollTop=0;element("history-list").clientHeight=100;element("history-list").scrollHeight=100;`);
  return app;
}
const settle = async () => {for (let i = 0; i < 200; i++) await new Promise(resolve => setImmediate(resolve));};
const historyRows = app => app.elements.get('history-list').children.map(row => row.children?.[1]?.children[0].textContent ?? row.textContent);
const scanTimes = app => app.requests.filter(url => url.startsWith('/api/replay?') && url.includes('direction=at'))
  .map(url => Number(new URLSearchParams(url.split('?')[1]).get('at')));
// A thread is saturated from 1300 to 1500; recordings stop between 1600 and 1700.
const spinView = at => {
  const recorded = at >= 1600 && at < 1700 ? 1599 : Math.floor(at);
  const view = frame(recorded);
  view.threads[0].cpu_pct = recorded >= 1300 && recorded <= 1500 ? 99 : 5;
  return view;
};

test('past thread findings end when a TID has a new generation or sampler session', async () => {
  const app = historyApp(at => {
    const view = frame(at, at < 1004 ? 'first-session' : 'second-session');
    view.threads[0].generation = at < 1002 ? 1 : 2;
    view.threads[0].cpu_pct = 99;
    return view;
  }, {first: 1000, last: 1004});
  await settle();
  const episodes = JSON.parse(app.run('JSON.stringify(past.episodes)'));
  assert.deepEqual(episodes.map(episode => [episode.first, episode.last, episode.count,
    episode.item.action.tid, episode.item.action.session, episode.item.action.generation]), [
    [1004, 1004, 1, 9, 'second-session', 2],
    [1002, 1003, 2, 9, 'first-session', 2],
    [1000, 1001, 2, 9, 'first-session', 1],
  ]);
  assert.equal(new Set(episodes.map(episode => episode.key)).size, 3);
});

test('past assessments check the latest recordings when the page opens and leave the live view alone', async () => {
  const app = historyApp(spinView);
  tick(app, 2000, 0);
  app.run('latestLive=live');
  const before = app.run('JSON.stringify({buffer,live,lastTick,bufferSession})');
  await settle();
  assert.equal(app.run('JSON.stringify({buffer,live,lastTick,bufferSession})'), before, 'the live view and trends are untouched');
  assert.equal(app.run('replayAt'), null);
  const times = scanTimes(app).sort((a, b) => a - b);
  assert.equal(times.length, 120, 'at most 120 recordings per period');
  assert.deepEqual([times[0], times.at(-1)], [1000, 1900], 'the first period ends at the newest recording');
  assert.deepEqual(historyRows(app), ['old-worker is saturating a core']);
  const episode = JSON.parse(app.run('JSON.stringify(past.episodes[0])'));
  assert.equal(episode.type, 'threads');
  assert.ok(episode.first >= 1300 && episode.first < 1308 && episode.last <= 1500 && episode.last > 1492, JSON.stringify(episode));
  assert.match(app.elements.get('history-status').textContent,
    /^Checked 108 recordings back to .* \(the oldest recording\)\. 12 checked times had no recording\. Showing 1 of 1 finding\.$/);
  assert.equal(app.elements.get('history-more').hidden, true, 'nothing earlier to load');
  // The timeline spans the checked period and marks the finding.
  const range = app.elements.get('timeline-range');
  assert.deepEqual([Number(range.min), Number(range.max), Number(range.value)], [1000, 1900, 1900], 'live sits at the right end');
  const mark = app.elements.get('timeline-marks').children[0];
  assert.ok(Math.abs(parseFloat(mark.style.left) - 100 * (episode.first - 1000) / 900) < 1e-9);
  // Filters hide rows and marks without checking again.
  app.run('boxes[1].checked=false;renderHistory();renderTimeline()');
  assert.deepEqual(historyRows(app), ['No findings match these filters.']);
  assert.equal(app.elements.get('timeline-marks').children.length, 0);
  app.run('boxes[1].checked=true;element("history-type").value="memory";renderHistory()');
  assert.deepEqual(historyRows(app), ['No findings match these filters.']);
  app.run('element("history-type").value="threads";renderHistory()');
  assert.equal(scanTimes(app).length, 120);
  // A row moves the whole dashboard to the time it was worst and stays selected.
  app.elements.get('history-list').children[0].onclick();
  await settle();
  assert.equal(app.run('replayAt'), episode.at);
  assert.ok(app.run('assess(live.threads,buffer)').some(item => item.title === 'old-worker is saturating a core'));
  const row = app.elements.get('history-list').children[0];
  assert.equal(row.attrs['aria-current'], 'true');
  assert.equal(row.children[1].children.length, 3, 'the selected row shows the detail');
  const pill = app.elements.get('history-pill');
  assert.equal(pill.hidden, false);
  assert.match(pill.textContent, / · Back to live$/);
  assert.match(pill.attrs['aria-label'], /^Viewing the recording at .*\. Back to live$/);
  assert.equal(Number(range.value), episode.at);
  pill.onclick();
  assert.equal(app.run('replayAt'), null);
  assert.equal(pill.hidden, true);
});

// RSS grows 8 MB/s from 1300 to 1500 and is flat before and after.
const leakRss = at => 100e6 + 8e6 * Math.min(200, Math.max(0, at - 1300));
const leakView = at => {
  const view = frame(Math.floor(at));
  view.threads[0].cpu_pct = 1;
  view.memory = {available: true, stale: false, pid: 9, updated: view.recorded_at, values: {vma_count: 100, max_map_count: 65530}};
  view.resources = {available: true, stale: false, pid: 9, session: 'old-session', memory: {rss: leakRss(view.recorded_at)}};
  return view;
};
const leakRows = (start, end) => {
  const rows = [];
  for (let at = Math.max(1000, Math.ceil(start)); at <= end; at++) rows.push({ts: at, pid: 9, rss_bytes: leakRss(at)});
  return rows;
};

test('past assessments find RSS growth from the stored resource samples', async () => {
  const app = historyApp(leakView, {first: 1000, last: 1900}, leakRows);
  await settle();
  assert.deepEqual(historyRows(app), ['Resident memory grows without a plateau']);
  const episode = JSON.parse(app.run('JSON.stringify(past.episodes[0])'));
  assert.equal(episode.type, 'memory');
  assert.ok(episode.first > 1300 && episode.first < 1360 && episode.last > 1500 && episode.last < 1700, JSON.stringify(episode));
  const periodReads = app.requests.filter(url => url.startsWith('/api/resources?') && Number(new URLSearchParams(url.split('?')[1]).get('end')) === 1900);
  assert.equal(periodReads.length, 1, 'one resource read for the period');
  assert.equal(app.run('replayResources.length'), 0, 'the live view keeps no recorded samples');
  // The row opens the recording, and the Assessment there shows the same finding.
  app.elements.get('history-list').children[0].onclick();
  await settle();
  assert.equal(app.run('replayAt'), episode.at);
  assert.ok(app.run('assess(live.threads,buffer)').some(item => item.title === 'Resident memory grows without a plateau'));
  // Without stored resource samples there is no trend.
  const bare = historyApp(leakView);
  await settle();
  assert.deepEqual(historyRows(bare), ['The Assessment found nothing in the checked recordings.']);
});

test('scrolling to the end of the list or the start of the timeline checks an earlier period', async () => {
  const app = historyApp(at => frame(Math.floor(at)), {first: 0, last: 1900});
  await settle();
  assert.equal(scanTimes(app).length, 120);
  assert.equal(app.run('past.oldest'), 1000);
  const more = app.elements.get('history-more');
  assert.equal(more.hidden, false);
  // The list's end is in view: the next period is twice as long, back to the oldest recording.
  app.elements.get('history-list').onscroll();
  assert.equal(more.textContent, 'Loading…');
  app.elements.get('history-list').onscroll();
  await settle();
  const earlier = scanTimes(app).slice(120);
  assert.equal(earlier.length, 119, 'one load at a time; the period stops before the time already checked');
  assert.ok(Math.min(...earlier) === 0 && Math.max(...earlier) < 1000, `${Math.min(...earlier)}..${Math.max(...earlier)}`);
  assert.equal(app.run('past.oldest'), 0);
  assert.equal(more.hidden, true);
  assert.match(app.elements.get('history-status').textContent, /\(the oldest recording\)/);
  assert.equal(Number(app.elements.get('timeline-range').min), 0);

  // Releasing the handle at the left end opens that moment and loads earlier;
  // at the right end it returns to live.
  const other = historyApp(at => frame(Math.floor(at)), {first: 0, last: 1900});
  await settle();
  other.run('latestLive=live={health:{session:"session-1",last_seen:1900},threads:[]}');
  other.run('renderTimeline()');
  const range = other.elements.get('timeline-range');
  range.value = range.min; range.onchange();
  await settle();
  assert.equal(other.run('replayAt'), 1000);
  assert.equal(other.run('past.oldest'), 0);
  range.value = range.max; range.onchange();
  assert.equal(other.run('replayAt'), null);
});

test('a long timeline opens recent past times and one step before Live', async () => {
  const app = historyApp(at => frame(Math.floor(at)), {first: 0, last: 86400});
  await settle();
  app.run('past.oldest=0;latestLive=live={health:{session:"session-1",last_seen:86400},threads:[]};renderTimeline()');
  const range = app.elements.get('timeline-range');
  assert.equal(Number(range.max) - Number(range.min), 86400);
  for (const secondsBeforeLive of [300, 1]) {
    range.value = String(Number(range.max) - secondsBeforeLive);
    range.oninput();
    assert.match(app.elements.get('timeline-cursor').textContent, /^Release to view /);
    range.onchange();
    await settle();
    assert.equal(app.run('replayAt'), 86400 - secondsBeforeLive);
    app.run('returnLive()');
  }
  range.value = range.max;
  range.oninput();
  assert.equal(app.elements.get('timeline-cursor').textContent, 'Release for live');
  range.onchange();
  assert.equal(app.run('replayAt'), null);
});

test('a fractional timeline returns to Live only from its last selectable step', async () => {
  // A native range input selects these endpoints with min=1000.2 and step=1.
  for (const [liveEnd, lastSelectable] of [[1900.9, 1900.2], [1901.2, 1901.2]]) {
    const app = historyApp(at => frame(at), {first: 1000.2, last: 1900.2});
    await settle();
    app.run(`latestLive=live={health:{session:"session-1",last_seen:${liveEnd}},threads:[]};renderTimeline()`);
    await app.run('inspectTime(1800.2)');
    const range = app.elements.get('timeline-range');
    assert.deepEqual([Number(range.min), Number(range.max)], [1000.2, liveEnd]);
    range.value = String(lastSelectable - 1);
    range.oninput();
    assert.match(app.elements.get('timeline-cursor').textContent, /^Release to view /);
    range.onchange();
    await settle();
    assert.equal(app.run('replayAt'), lastSelectable - 1);
    range.value = String(lastSelectable);
    range.oninput();
    assert.equal(app.elements.get('timeline-cursor').textContent, 'Release for live');
    range.onchange();
    assert.equal(app.run('replayAt'), null);
  }
});

test('while live the newest recordings join the list, and errors can be retried', async () => {
  const bounds = {first: 1000, last: 1900};
  const app = historyApp(at => frame(Math.floor(at)), bounds);
  await settle();
  const step = app.run('past.step');
  bounds.last = 1960;
  app.advance(15000);
  await settle();
  const added = scanTimes(app).slice(120);
  assert.equal(added.length, Math.floor(60 / step));
  assert.ok(Math.abs(added[0] - (1900 + step)) < 1e-9);
  assert.ok(Math.abs(app.run('past.newest') - (1900 + added.length * step)) < 1e-9);

  const failing = historyApp(() => frame(1000));
  failing.setFetch(url => url === '/api/replay' ? jsonResponse({first: 1000, last: 1900, interval_s: 1})
    : Promise.resolve({ok: false, json: async () => ({error: 'bad at'})}));
  failing.run('loadReplayBounds().then(loadOlder)');
  await settle();
  assert.equal(failing.elements.get('history-status').textContent, 'bad at Select Load earlier to try again.');
  assert.equal(failing.elements.get('history-more').hidden, false);
  failing.setFetch(url => jsonResponse({first: 1000, last: 1900, interval_s: 1, snapshot: url.includes('?') ? frame(1000) : null}));
  failing.elements.get('history-more').onclick();
  await settle();
  assert.match(failing.elements.get('history-status').textContent, /^Checked /);

  const empty = historyApp(() => null, {first: null, last: null});
  await settle();
  assert.equal(empty.elements.get('history-status').textContent, 'No recordings to check.');
  assert.equal(empty.elements.get('timeline-range').disabled, true);
});


test('replay preserves live CPU samples without depending on session storage', async () => {
  for (const unavailable of [false, true]) {
    const app = dashboard(new Map(), url => url.startsWith('/api/replay?')
      ? jsonResponse({first: 900, last: 1000, snapshot: frame(1000)}) : undefined);
    if (unavailable) app.run('sessionStorage.setItem=()=>{throw Error("storage unavailable")}');
    for (let time = 2000; time < 2100; time++) tick(app, time, time % 100);
    app.run('latestLive=live');
    const before = app.run('JSON.stringify({buffer,cpu:[...threadCpu],avg:[...threadAvg],seen:[...threadSeen],loadState})');
    await app.run('inspectTime(1000)');
    await app.run('inspectTime(900)');
    await app.run('returnLive()');
    assert.equal(app.run('JSON.stringify({buffer,cpu:[...threadCpu],avg:[...threadAvg],seen:[...threadSeen],loadState})'), before);
    tick(app, 2100, 50);
    assert.equal(app.run('threadCpu.get(1).length'), 101);
    assert.equal(app.run('threadCpu.get(1).at(-1).v'), 50);
    assert.equal(app.run('buffer.at(-1).born'), 0);
    assert.equal(app.run('buffer.at(-1).died'), 0);
  }
});

test('returning from replay discards CPU history from an earlier live session', async () => {
  const app = dashboard(new Map(), url => url.startsWith('/api/replay?')
    ? jsonResponse({first: 1000, last: 1000, snapshot: frame(1000)}) : undefined);
  tick(app, 2000, 100);
  await app.run('inspectTime(1000)');
  app.run('latestLive=' + JSON.stringify(frame(2100, 'session-2', 1)));
  await app.run('returnLive()');
  assert.equal(app.run('bufferSession'), 'session-2');
  assert.equal(app.run('threadCpu.get(1).length'), 1);
  assert.equal(app.run('threadCpu.get(1)[0].t'), 2100);
  assert.equal(app.run('buffer.length'), 1);
});

// A live poll that answers /api/live with p_view and /api/last-target with
// p_kept.
function polls(view, kept = {available: false}) {
  return url => url === '/api/live' ? jsonResponse(view())
    : url === '/api/last-target' ? jsonResponse(kept) : undefined;
}
const absent = (session = 'session-2', lastTarget) =>
  ({health: {session, target_absent: true, pid: 0, ...(lastTarget ? {last_target: lastTarget} : {})}, threads: []});

test('a target that stops reporting leaves its final view and trends on screen until Show live', async () => {
  let view = absent();
  const app = dashboard(new Map(), polls(() => view));
  for (let time = 1000; time <= 1100; time++) tick(app, time, 50);
  await app.run('refresh()');
  assert.equal(app.run('frozen.at'), 1100);
  assert.equal(app.run('live.health.session'), 'session-1');
  assert.equal(app.run('buffer.length'), 101);
  assert.equal(app.run('liveNow()'), 1100);
  assert.equal(app.elements.get('exited').hidden, false);
  assert.match(app.elements.get('exited-text').textContent, /stopped reporting/);
  assert.match(app.elements.get('exited-text').textContent, /trends this tab kept/);
  assert.match(app.elements.get('target-meta').textContent, /Stopped reporting/);
  // A new process does not replace the final view by itself.
  view = {health: {session: 'session-3', target_absent: false, pid: 77}, threads: []};
  await app.run('refresh()');
  assert.equal(app.run('live.health.session'), 'session-1');
  assert.match(app.elements.get('exited-text').textContent, /new process \(PID 77\)/);
  app.run('showLive()');
  assert.equal(app.run('frozen'), null);
  assert.equal(app.run('live.health.session'), 'session-3');
  assert.equal(app.run('buffer.length'), 0);
  assert.equal(app.elements.get('exited').hidden, true);
  assert.equal(app.storage.has('triangulator:frozen'), false);
});

test('a new session without threads keeps the view until its absence is known', async () => {
  // The collector clears threads before the new session's first tick says
  // whether the target is absent.
  let view = {health: {session: 'session-2', target_absent: false, pid: 0}, threads: []};
  const app = dashboard(new Map(), polls(() => view));
  for (let time = 1000; time <= 1100; time++) tick(app, time, 50);
  await app.run('refresh()');
  assert.equal(app.run('live.health.session'), 'session-1');
  assert.equal(app.run('buffer.length'), 101);
  assert.equal(app.run('frozen'), null);
  view = absent();
  await app.run('refresh()');
  assert.equal(app.run('frozen.at'), 1100);
  // A session that never reports threads or absence is accepted after a while.
  const slow = dashboard(new Map(), polls(() => ({health: {session: 'session-2', target_absent: false, pid: 5}, threads: []})));
  tick(slow, 1000, 50);
  await slow.run('refresh()');
  assert.equal(slow.run('live.health.session'), 'session-1');
  slow.run('settleSince-=SETTLE_SECS');
  await slow.run('refresh()');
  assert.equal(slow.run('live.health.session'), 'session-2');
  assert.equal(slow.run('frozen'), null);
});

test('a reloaded tab restores the final view and its saved trends', async () => {
  const app = dashboard(new Map(), polls(() => absent()));
  for (let time = 1000; time <= 1100; time++) tick(app, time, 50);
  await app.run('refresh()');
  const restored = dashboard(app.storage, polls(() => absent()));
  await restored.run('refresh()');
  assert.equal(restored.run('frozen.at'), 1100);
  assert.equal(restored.run('live.health.session'), 'session-1');
  assert.equal(restored.run('buffer.length'), 101);
});

test('a tab opened after the exit uses the collector view once, and Show live keeps it closed', async () => {
  const app = dashboard(new Map(), polls(() => absent('session-2', {session: 'old-session'}), frame(1000)));
  // The dashboard's own first poll fetches the view; let it finish.
  await app.run('refresh()');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.run('frozen.at'), 1000);
  assert.equal(app.run('live.health.session'), 'old-session');
  assert.match(app.elements.get('exited-text').textContent, /no earlier trends/);
  app.run('showLive()');
  await app.run('refresh()');
  assert.equal(app.run('frozen'), null);
  assert.equal(app.requests.filter(url => url === '/api/last-target').length, 1);
});

test('a collector view from another session or without threads is ignored', async () => {
  for (const kept of [frame(1000, 'other-session'), {...frame(1000), threads: []}, {available: false}]) {
    const app = dashboard(new Map(), polls(() => absent('session-2', {session: 'old-session'}), kept));
    await app.run('refresh()');
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(app.requests.includes('/api/last-target'));
    assert.equal(app.run('frozen'), null);
  }
});

test('returning from a recording goes back to the final view', async () => {
  const app = dashboard(new Map(), url => url.startsWith('/api/replay?')
    ? jsonResponse({first: 900, last: 1000, snapshot: frame(1000)}) : polls(() => absent())(url));
  for (let time = 1000; time <= 1100; time++) tick(app, time, 50);
  await app.run('refresh()');
  await app.run('inspectTime(1000)');
  assert.equal(app.run('live.health.session'), 'old-session');
  await app.run('returnLive()');
  assert.equal(app.run('live.health.session'), 'session-1');
  assert.equal(app.run('buffer.length'), 101);
  assert.ok(app.run('frozen') !== null);
});

test('an exit during a recording returns to the final view, not the next process', async () => {
  let view = {health: {session: 'session-1', target_absent: false, pid: 1},
    threads: [{tid: 1, generation: 1, name: 'worker', last_sample: 1100, cpu_pct: 50, state: 'sleep'}]};
  const app = dashboard(new Map(), url => url.startsWith('/api/replay?')
    ? jsonResponse({first: 900, last: 1000, snapshot: frame(1000)}) : polls(() => view)(url));
  for (let time = 1000; time <= 1100; time++) tick(app, time, 50);
  await app.run('inspectTime(1000)');
  view = absent();
  await app.run('refresh()');
  assert.equal(app.run('frozen.at'), 1100);
  assert.equal(app.run('live.health.session'), 'old-session');
  // The target restarts before the user selects Live.
  view = {health: {session: 'session-3', target_absent: false, pid: 77}, threads: []};
  await app.run('refresh()');
  await app.run('returnLive()');
  assert.equal(app.run('live.health.session'), 'session-1');
  assert.equal(app.run('buffer.length'), 101);
  assert.equal(app.elements.get('exited').hidden, false);
});

test('a failed request for the collector view is retried', async () => {
  let fail = true;
  const app = dashboard(new Map(), url => url === '/api/live'
    ? jsonResponse(absent('session-2', {session: 'old-session'}))
    : url === '/api/last-target' ? (fail ? Promise.resolve({ok: false, json: async () => ({})}) : jsonResponse(frame(1000)))
    : undefined);
  await app.run('refresh()');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.run('frozen'), null);
  fail = false;
  await app.run('refresh()');
  assert.equal(app.run('frozen.at'), 1000);
  assert.ok(app.requests.filter(url => url === '/api/last-target').length >= 2);
});

test('the final view keeps its memory layout across a reload', async () => {
  const memory = {available: true, pid: 1, layout_id: 'session-1:4'};
  const layout = {id: 'session-1:4', pid: 1, available: true, regions: []};
  const app = dashboard(new Map(), polls(() => absent()));
  for (let time = 1000; time <= 1100; time++) tick(app, time, 50);
  app.run(`live.memory=${JSON.stringify(memory)};memoryLayout=${JSON.stringify(layout)}`);
  await app.run('refresh()');
  assert.equal(app.run('frozen.layout.id'), 'session-1:4');
  const restored = dashboard(app.storage, url => url === '/api/memory-map'
    ? jsonResponse({id: 'session-3:1', pid: 77, available: true, regions: []}) : polls(() => absent())(url));
  await restored.run('refresh()');
  assert.equal(restored.run('memoryLayout.id'), 'session-1:4');
  assert.equal(restored.run('memoryLayoutFor(live.memory).id'), 'session-1:4');
  assert.ok(!restored.requests.includes('/api/memory-map'));
});

test('the final view shows the exit report that arrives after it', async () => {
  let view = absent();
  const app = dashboard(new Map(), polls(() => view));
  for (let time = 1000; time <= 1100; time++) tick(app, time, 50);
  app.run('live.health.pid=1');
  await app.run('refresh()');
  assert.equal(app.elements.get('process-exit').hidden, true);
  const ended = {pid: 1, session: 'session-1', next_session: 'session-2', name: 'worker', ended_at: 1101,
    reason: 'segfault', kernel_log: 'read', messages: ['worker[1]: segfault']};
  // An exit of another process is not this view's.
  view = {...absent(), exit: {...ended, session: 'session-0'}};
  await app.run('refresh()');
  assert.equal(app.run('frozenExit()'), null);
  view = {...absent(), exit: ended};
  await app.run('refresh()');
  assert.equal(app.run('frozen.exit.reason'), 'segfault');
  assert.equal(app.elements.get('process-exit').hidden, false);
  assert.match(app.elements.get('exited-text').textContent, /Segmentation fault/);
  assert.ok(app.run('assess(live.threads,buffer)').some(item => /Target process ended/.test(item.title)));
  // A later exit of another process does not replace it, and a reload keeps it.
  view = {...absent('session-5'), exit: {...ended, pid: 9, session: 'session-4'}};
  await app.run('refresh()');
  assert.equal(app.run('shownExit().pid'), 1);
  const restored = dashboard(app.storage, polls(() => absent('session-5')));
  await restored.run('refresh()');
  assert.equal(restored.run('frozen.exit.reason'), 'segfault');
});

test('a final view too large for session storage says a reload loses it', async () => {
  const storage = new Map();
  const app = dashboard(storage, polls(() => absent()));
  for (let time = 1000; time <= 1100; time++) tick(app, time, 50);
  storage.set = (key, value) => {if (key === 'triangulator:frozen') throw Error('QuotaExceededError'); Map.prototype.set.call(storage, key, value);};
  await app.run('refresh()');
  assert.ok(app.run('frozen') !== null);
  assert.match(app.elements.get('exited-text').textContent, /too large to keep across a reload/);
});

test('memory map rows join neighbours, shorten gaps and stay few', () => {
  const app = dashboard();
  const region = (start, size, kind, permissions, name = '') =>
    ({start: '0x' + start.toString(16), end: '0x' + (start + size).toString(16), size, vmas: 1, kind, permissions, name});
  const layout = {regions: [
    region(0x555500000000, 0x200000, 'file', 'r-xp', '/usr/bin/app'),
    region(0x555500400000, 0x800000, 'heap', 'rw-p'),
    region(0x7f0000000000, 0x100000, 'file', 'r-xp', '/usr/lib/libc.so.6'),
    region(0x7f0000100000, 0x1000, 'anonymous', 'rw-p'),
    region(0x7f0000101000, 0x100000, 'file', 'r-xp', '/usr/lib/libm.so.6'),
    region(0x7ffc00000000, 0x21000, 'stack', 'rw-p'),
    // Above 2^53: the addresses must not lose precision.
    {start: '0xffffffffff600000', end: '0xffffffffff601000', size: 0x1000, vmas: 1, kind: 'kernel', permissions: '--xp', name: '[vsyscall]'},
  ]};
  app.run('live={health:{pid:42},threads:[{tid:42,name:"app"}]}');
  const rows = app.run(`memoryRows(memoryRegions(${JSON.stringify(layout)})).map(row=>row.gap?'gap':memoryRowName(row))`);
  assert.deepEqual([...rows], ['[vsyscall]', 'gap', '[stack]', 'gap', 'libc, libm (2 libraries)', 'gap', '[heap]', 'app (program image)']);

  // Hundreds of small anonymous runs between gaps merge down to the cap.
  const many = {regions: Array.from({length: 300}, (_, index) =>
    region(0x100000000000 + index * 0x80000000, 0x100000, index % 2 ? 'file' : 'anonymous', 'rw-p', index % 2 ? '/data/f' + index : '[anon:gc]'))};
  const count = app.run(`memoryRows(memoryRegions(${JSON.stringify(many)})).filter(row=>!row.gap).length`);
  assert.ok(count <= 18, String(count));
});

test('memory findings flag mapping limits, deleted libraries and the main stack', () => {
  const app = dashboard();
  const summary = {available: true, pid: 1, updated: 1, values: {vma_count: 950, max_map_count: 1000, stack_limit_bytes: 8 << 20}};
  const layout = {regions: [
    {start: '0x7f0000000000', end: '0x7f0000100000', size: 0x100000, vmas: 3, kind: 'file', permissions: 'r-xp', name: '/usr/lib/libssl.so.3 (deleted)'},
    {start: '0x7ffc00000000', end: '0x7ffc00700000', size: 0x700000, vmas: 1, kind: 'stack', permissions: 'rw-p', name: ''},
  ]};
  app.run('live={health:{session:"s"},threads:[]}');
  const findings = app.run(`(()=>{const regions=memoryRegions(${JSON.stringify(layout)});return assessMemory(${JSON.stringify(summary)},regions,memoryRows(regions)).map(item=>item.level+': '+item.title)})()`);
  assert.deepEqual([...findings], [
    'critical: Mapping count is close to the limit',
    'warning: Main stack is at 87.5% of its limit',
    'info: Library replaced on disk',
  ]);
});

test('memory history follows the layout the summary names and the sampler session', () => {
  const app = dashboard();
  const heapLayout = size => ({regions: [{start: '0x1000000', end: '0x' + (0x1000000 + size).toString(16), size, vmas: 1, kind: 'heap', permissions: 'rw-p', name: ''}]});
  app.run(`live={health:{session:'a'},threads:[]}`);
  const summary = (updated, pid = 1) => JSON.stringify({pid, updated, values: {major_faults: 10}});
  // The summary names a layout that is still loading: the heap waits for it.
  app.run(`recordMemory(${summary(1)},memoryRegions(${JSON.stringify(heapLayout(1 << 20))}),false)`);
  assert.equal(app.run('memoryHistory.at(-1).heap'), null);
  app.run(`recordMemory(${summary(1)},memoryRegions(${JSON.stringify(heapLayout(2 << 20))}),true)`);
  assert.equal(app.run('memoryHistory.length'), 1);
  assert.equal(app.run('memoryHistory.at(-1).heap'), 2 << 20);
  // The same PID in a new sampler session starts a new history.
  app.run(`live.health.session='b';resetMemoryTarget({pid:1});recordMemory(${summary(2)},[],true)`);
  assert.equal(app.run('memoryHistory.length'), 1);
});

test('memory history backfills resident bytes from a later resource sample', () => {
  const app = dashboard();
  app.run(`live={health:{session:'a'},threads:[],memory:{pid:1,updated:5,values:{}}}`);
  app.run('recordMemory(live.memory,[],false)');
  assert.equal(app.run('memoryHistory.at(-1).anon'), null);
  app.run(`live.resources={available:true,session:'a',pid:1,memory:{rss:300,anon:200}};recordMemory(live.memory,[],false)`);
  assert.equal(app.run('memoryHistory.length'), 1);
  assert.equal(app.run('memoryHistory.at(-1).anon'), 200);
  assert.equal(app.run('memoryHistory.at(-1).rss'), 300);
});

test('memory fault rate uses the recording in replay and never live history', () => {
  const app = dashboard();
  app.run(`live={health:{session:'a'},threads:[]};memoryHistory=[{t:1,mf:0},{t:2,mf:0}]`);
  app.run('replayAt=100;buffer=[{t:100,mf:200}]');
  assert.equal(app.run('memoryFaultRate()'), 200);
  app.run('buffer=[{t:100,mf:null}]');
  assert.equal(app.run('memoryFaultRate()'), null);
  // Live, a counter that went down (another process) gives no rate.
  app.run('replayAt=null;buffer=[];memoryHistory=[{t:1,mf:50},{t:2,mf:10}]');
  assert.equal(app.run('memoryFaultRate()'), null);
});

test('a data file below the executable is not the program image', () => {
  const app = dashboard();
  const file = (start, permissions, name) => ({start: '0x' + start.toString(16), end: '0x' + (start + 0x1000).toString(16), size: 0x1000, vmas: 1, kind: 'file', permissions, name});
  const layout = JSON.stringify({regions: [file(0x40e58000, 'rw-p', '/tmp/data (deleted)'), file(0x55e558c1c000, 'r-xp', '/usr/bin/python3.14')]});
  app.run('live={health:{session:"a",pid:7},threads:[{tid:7,name:"python3"}]}');
  assert.deepEqual([...app.run(`memoryRegions(${layout}).map(region=>region.cat+(region.certain?'!':''))`)], ['code!', 'file']);
  const titles = app.run(`(()=>{const regions=memoryRegions(${layout});return assessMemory({values:{}},regions,memoryRows(regions)).map(item=>item.title)})()`);
  assert.ok(!titles.some(title => /replaced on disk/.test(title)), titles.join('\n'));
  // Without a name match the program is only a guess, and a deleted guess is
  // not reported as the program.
  const guess = JSON.stringify({regions: [file(0x55e558c1c000, 'r-xp', '/usr/bin/other (deleted)')]});
  const guessed = app.run(`(()=>{const regions=memoryRegions(${guess});return assessMemory({values:{}},regions,memoryRows(regions)).map(item=>item.title)})()`);
  assert.ok(guessed.includes('Executable file replaced on disk'), guessed.join('\n'));
});

// Resource history rows, one per `step` seconds, ending now. Each part is
// [pid, seconds, start MiB, MiB per second]; `wobble` adds a small saw-tooth
// and `dip` lowers every sixth sample (a step that does not rise).
function rssHistory(app, parts, {step = 5, wobble = 0, dip = 0} = {}) {
  const total = parts.reduce((sum, part) => sum + part[1], 0), start = Date.now() / 1000 - total;
  const rows = [];
  let at = 0;
  for (const [pid, seconds, mib, rate] of parts) {
    for (let t = 0; t < seconds; t += step, at += step)
      rows.push({ts: start + at, pid, rss_bytes: (mib + rate * t + (rows.length % 2 ? wobble : 0) - (rows.length % 6 === 5 ? dip : 0)) * 2 ** 20});
  }
  app.run(`live={health:{session:'s',pid:${parts.at(-1)[0]}},threads:[],resources:{available:true,memory:{rss:${rows.at(-1).rss_bytes},anon:1,rss_growth_per_s:${rate0(parts)}}}};` +
    `resourceHistory={rows:${JSON.stringify(rows)}}`);
}
const rate0 = parts => parts.at(-1)[3] * 2 ** 20;
const trendOf = app => JSON.parse(app.run('JSON.stringify(rssTrend())'));
const growthFindings = app => [...app.run("assessMemory({values:{}},[],[]).map(item=>item.title)")];
const GROWS = 'Resident memory grows without a plateau';

test('a leak that started a minute ago is reported at its own rate', () => {
  const app = dashboard();
  // Eight flat minutes, then 60 s at 8 MiB/s (480 MiB/min).
  rssHistory(app, [[7, 480, 100, 0], [7, 60, 100, 8]]);
  const trend = trendOf(app);
  assert.ok(trend.steady);
  assert.ok(Math.abs(trend.slope / 2 ** 20 - 480) < 25, String(trend.slope / 2 ** 20));
  assert.ok(growthFindings(app).includes(GROWS));
  // The same leak three minutes in is still found, and the flat time before it does not matter.
  rssHistory(app, [[7, 400, 100, 0], [7, 180, 100, 8]]);
  assert.ok(Math.abs(trendOf(app).slope / 2 ** 20 - 480) < 25);
});

test('an earlier, smaller process in the window does not change the RSS trend', () => {
  const app = dashboard();
  // PID 4 ran at 50 MiB (and shrank); PID 7 started 90 s ago and leaks 8 MiB/s.
  rssHistory(app, [[4, 300, 400, -1], [7, 90, 40, 8]]);
  const trend = trendOf(app);
  assert.ok(trend.steady);
  assert.ok(Math.abs(trend.slope / 2 ** 20 - 480) < 25, String(trend.slope / 2 ** 20));
  assert.ok(growthFindings(app).includes(GROWS));
  // The new process is still too young to judge: nothing is reported.
  rssHistory(app, [[4, 300, 50, 0], [7, 20, 40, 8]]);
  assert.equal(trendOf(app), null);
  assert.ok(!growthFindings(app).includes(GROWS));
  // A previous process that was bigger does not make the new one look like it shrinks.
  rssHistory(app, [[4, 300, 2000, 0], [7, 120, 100, 0]]);
  assert.ok(!trendOf(app).steady);
  assert.ok(Math.abs(trendOf(app).slope) < 1);
});

test('RSS growth does not use another target, stale resources, or live history in replay', () => {
  const app = dashboard();
  rssHistory(app, [[7, 120, 100, 8]]);
  assert.ok(trendOf(app).steady);
  app.run('live.health.pid=8');
  assert.equal(trendOf(app), null);
  assert.ok(!growthFindings(app).includes(GROWS));
  app.run('live.health.pid=7;live.resources.stale=true');
  assert.equal(trendOf(app), null);
  app.run('live.resources.stale=false;live.resources.available=false');
  assert.equal(trendOf(app), null);
  app.run('live.resources.available=true;replayAt=Date.now()/1000-300');
  assert.equal(trendOf(app), null);
  assert.ok(!growthFindings(app).includes(GROWS));
});

test('unavailable RSS rows preserve process boundaries', () => {
  const app = dashboard();
  rssHistory(app, [[7, 120, 100, 8]]);
  app.run('resourceHistory.rows.splice(-1,0,{ts:resourceHistory.rows.at(-1).ts-1,pid:8,rss_bytes:null})');
  assert.equal(trendOf(app), null);
});

test('flat, noisy and slowly growing RSS do not raise the growth finding', () => {
  const app = dashboard();
  rssHistory(app, [[7, 600, 300, 0]], {wobble: 0.3});
  assert.ok(!trendOf(app).steady);
  assert.ok(!growthFindings(app).includes(GROWS));
  // A few non-rising steps are tolerated, but 0.1 MiB/s over three minutes is not a leak.
  rssHistory(app, [[7, 600, 300, 0.01]], {wobble: 0.3});
  assert.ok(!growthFindings(app).includes(GROWS));
  // Growth that stalls: the last minutes are flat, so it does not qualify.
  rssHistory(app, [[7, 120, 100, 4], [7, 300, 580, 0]]);
  assert.ok(!growthFindings(app).includes(GROWS));
});

test('a leak with a few non-rising steps is still found, and the tile uses the same trend', () => {
  const app = dashboard();
  rssHistory(app, [[7, 300, 100, 2]], {dip: 15});
  assert.ok(trendOf(app).steady);
  assert.ok(growthFindings(app).includes(GROWS));
  const tile = JSON.parse(app.run(`(()=>{renderMemoryTiles({values:{}});return JSON.stringify(element('memory-tiles').children.map(box=>box.children.map(child=>child.textContent)))})()`));
  const resident = tile.find(box => box[0] === 'Resident (RSS)');
  assert.match(resident[2], /^▲ 1[12][0-9](\.[0-9])? MiB \/ min$/);
});

function helpClock() {
  const app = dashboard();
  app.run("var helpEvents=[];var dwell=createHelpTimer(value=>helpEvents.push(value),()=>helpEvents.push('closed'))");
  return app;
}

test('help waits the full dwell time and never warms up subsequent targets', () => {
  const app = helpClock();
  app.run("dwell.request('cpu','CPU')");
  app.advance(1199);
  assert.equal(app.run('helpEvents.length'), 0);
  app.advance(1);
  assert.equal(app.run('helpEvents[0]'), 'CPU');
  app.run("dwell.request('delay','Run delay')");
  app.advance(1199);
  assert.equal(app.run('helpEvents.at(-1)'), 'closed');
  app.advance(1);
  assert.equal(app.run('helpEvents.at(-1)'), 'Run delay');
});

test('leaving cancels pending help; focus and pointer entry preserve it', () => {
  const app = helpClock();
  app.run("dwell.request('cpu','CPU')");
  app.advance(700);
  app.run('dwell.leave()');
  app.advance(1200);
  assert.equal(app.run('helpEvents.length'), 0);
  app.run("dwell.request('cpu','CPU')");
  app.advance(800);
  app.run('dwell.leave(()=>true)');
  app.advance(400);
  assert.equal(app.run('helpEvents.at(-1)'), 'CPU');
  app.run('dwell.leave()');
  app.advance(249);
  assert.equal(app.run('helpEvents.at(-1)'), 'CPU');
  app.run("dwell.request('cpu','CPU')");
  app.advance(1000);
  assert.equal(app.run('helpEvents.length'), 1, 'entering the card cancels its close timer');
  app.run('dwell.leave()');
  app.advance(250);
  assert.equal(app.run('helpEvents.at(-1)'), 'closed');
});

test('Escape suppresses the same target until it is left', () => {
  const app = helpClock();
  app.run("dwell.request('cpu','CPU')");app.advance(1200);
  app.run("dwell.cancel(true);dwell.request('cpu','CPU')");app.advance(2000);
  assert.equal(app.run('helpEvents.length'), 2);
  app.run("dwell.leave();dwell.request('cpu','CPU')");app.advance(1200);
  assert.equal(app.run('helpEvents.length'), 3);
});

test('chart dwell resets for a different point or significant pointer motion', () => {
  const app = helpClock();
  app.run("dwell.request('chart:100','first',{x:10,y:10})");app.advance(900);
  app.run("dwell.request('chart:100','latest',{x:14,y:12})");app.advance(300);
  assert.equal(app.run('helpEvents[0]'), 'latest');
  app.run("dwell.request('chart:101','next',{x:14,y:12})");app.advance(900);
  app.run("dwell.request('chart:101','moved',{x:30,y:12})");app.advance(1199);
  assert.equal(app.run('helpEvents.at(-1)'), 'closed');
  app.advance(1);assert.equal(app.run('helpEvents.at(-1)'), 'moved');
});

test('an open explanation is frozen and removed targets never open', () => {
  const app = helpClock();
  app.run("dwell.request('cpu','first')");app.advance(1200);
  app.run("dwell.request('cpu','changed')");app.advance(1200);
  assert.equal(app.run('helpEvents.length'), 1);
  app.run('var rejected=createHelpTimer(()=>false,()=>helpEvents.push("wrong close"));rejected.request("gone",{})');
  app.advance(1200);
  assert.equal(app.run('rejected.visible'), null);
  assert.equal(app.run('helpEvents.length'), 1);
});

test('help topics keep metric denominators separate and all related links resolve', () => {
  const app = dashboard();
  assert.notEqual(app.run("topicForText('Waiting for CPU')"), app.run("topicForText('Run delay')"));
  assert.notEqual(app.run("topicForText('Socket wait')"), app.run("topicForText('Socket')"));
  assert.match(app.run('HELP.throttle.scope'), /CPU periods/);
  assert.equal(app.run('Object.values(HELP).flatMap(t=>t.related.filter(key=>!HELP[key])).length'), 0);
  assert.ok(app.run('Object.keys(HELP).length') > 80);
  assert.ok(!/\stitle=/.test(html.split('<script>')[0]), 'native title tooltips must not bypass the delay');
});

// Users must be able to see where each value comes from: a /proc file, a
// collector computation, or this page. Only controls and display settings
// may lack a source.
test('every data help topic names its source', () => {
  const app = dashboard();
  const controls = ['appearance', 'fleet-density', 'section-navigation', 'historyfilters', 'alerts', 'watchprefix', 'watchwake',
    'watchremove', 'watchadd', 'watchsave', 'watchreload', 'watchreset'];
  const missing = app.run(`Object.values(HELP).filter(t=>!t.source||!t.sourceDetail).map(t=>t.id)`);
  assert.deepEqual([...missing].sort(), [...controls].sort());
  assert.match(app.run('HELP.delay.source'), /schedstat/);
  assert.match(app.run("HELP['net-listen_overflows'].source"), /TcpExt: ListenOverflows/);
  // An odd number of backticks would set the rest of the text as code.
  const unbalanced = app.run(`Object.values(HELP).filter(t=>t.source&&((t.source+t.sourceDetail).split('\`').length%2===0)).map(t=>t.id)`);
  assert.deepEqual([...unbalanced], []);
  const text = app.run("codeText('p','Read `/proc/PID/io` with `cat`.')");
  assert.deepEqual(text.children.map(child => typeof child === 'string' ? child : '<code>' + child.textContent),
    ['Read ', '<code>/proc/PID/io', ' with ', '<code>cat', '.']);
});

test('every help name selects exactly one topic', () => {
  const app = dashboard();
  const clashes = app.run(`Object.values(HELP).flatMap(t=>[t.title,...t.aliases]
    .filter(name=>helpNames.get(name.toLowerCase())!==t.id).map(name=>name+': '+t.id+' vs '+helpNames.get(name.toLowerCase())))`);
  assert.deepEqual([...clashes], []);
  for (const name of ['Now', 'Total', 'In range', 'Drops', 'Time', '5 min', '15 min'])
    assert.equal(app.run(`topicForText(${JSON.stringify(name)})`), undefined, `${name} is too generic for a global alias`);
  assert.equal(app.run("topicForText('Thread map time window')"), 'map');
});

// Every section, card, chart, column and disclosure needs a help topic, so new
// dashboard features cannot ship without one. See docs/contextual-help-design.md.
test('Timeline step and Live buttons connect to the replay help topic', () => {
  const app = dashboard();
  for (const id of ['replay-previous', 'replay-next', 'replay-live']) {
    const attrs = html.match(new RegExp('<button\\b[^>]*\\bid="' + id + '"[^>]*>'))[0];
    const target = {
      dataset: {help: /data-help="([^"]+)"/.exec(attrs)?.[1]},
      closest(selector) {return selector.startsWith('[data-help]') && this.dataset.help ? this : null;},
      classList: {contains() {return false;}},
    };
    assert.equal(app.run('helpTarget')(target)?.id, 'replay', id);
  }
});

test('every static heading, column and summary has a help topic', () => {
  const app = dashboard();
  const page = html.split('<script>')[0].replace(/<aside id="help-guide"[\s\S]*?<\/aside>/, '');
  const missing = [];
  for (const [, tag, attrs, inner] of page.matchAll(/<(h2|h3|th|summary)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    // Counts and other values filled in at runtime sit in spans after the title.
    const text = inner.replace(/<span[^>]*>[^<]*<\/span>/g, '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim();
    const id = /data-help="([^"]+)"/.exec(attrs)?.[1] ?? app.run(`topicForText(${JSON.stringify(text)})`);
    if (!app.run(`!!HELP[${JSON.stringify(id ?? '')}]`)) missing.push(`<${tag}> ${text}`);
  }
  assert.deepEqual(missing, []);
});

// Static check on the shipped markup: a card or section with a table needs a
// heading that resolves a topic (data-help or title), and every full-width
// message cell (colSpan above 1) renders into a table whose card heading has an
// explicit data-help, the fallback that helpTarget uses for such cells.
// It reads the markup and script text; it does not run helpTarget on a real DOM.
function cardsWithTables() {
  const page = html.split('<script>')[0];
  const starts = [...page.matchAll(/<(?:div\b[^>]*class="card[" ]|section\b)/g)].map(m => m.index);
  return starts.map((start, i) => ({start, text: page.slice(start, starts[i + 1] ?? page.length)}))
    .map(card => ({...card, heading: /<(h[23])\b([^>]*)>([\s\S]*?)<\/\1>/.exec(card.text)}));
}
function headingTopic(app, heading, strict = false) {
  if (!heading) return undefined;
  const text = heading[3].replace(/<span[^>]*>[^<]*<\/span>/g, '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim();
  const explicit = /data-help="([^"]+)"/.exec(heading[2])?.[1];
  return explicit ?? (strict ? undefined : app.run(`topicForText(${JSON.stringify(text)})`));
}
test('every card with a table has a help-resolvable heading', () => {
  const app = dashboard();
  const bad = cardsWithTables().filter(card => /<table\b/.test(card.text))
    .filter(card => !app.run(`!!HELP[${JSON.stringify(headingTopic(app, card.heading) ?? '')}]`))
    .map(card => card.text.slice(0, 80));
  assert.deepEqual(bad, []);
});

test('every full-width message cell sits in a card whose heading resolves help', () => {
  const app = dashboard();
  const cards = cardsWithTables();
  const page = html.split('<script>')[0];
  const bad = [], found = [];
  for (const line of script.split('\n')) {
    if (!/\.colSpan=(?:[2-9]|\d\d)/.test(line) || /dataset\.help/.test(line)) continue;
    const ids = [...line.matchAll(/element\('([\w-]+)'\)/g)].map(m => m[1]).filter(id => page.includes(`<tbody id="${id}"`));
    // The tbody is named earlier in the same function when not on the line itself.
    const at = script.indexOf(line);
    const id = ids[0] ?? [...script.slice(0, at).matchAll(/element\('([\w-]+)'\)/g)].map(m => m[1]).reverse().find(x => page.includes(`<tbody id="${x}"`));
    const position = page.indexOf(`<tbody id="${id}"`);
    const card = cards.filter(c => c.start < position).pop();
    found.push(id);
    if (!id || !card || !app.run(`!!HELP[${JSON.stringify(headingTopic(app, card.heading, true) ?? '')}]`)) bad.push(`${id}: ${line.trim().slice(0, 60)}`);
  }
  assert.ok(found.length >= 3, 'expected to find the full-width message cells');
  assert.deepEqual(bad, []);
});

test('labels built at runtime use helpButtonLabel', () => {
  // Help guide internals build their own headings; everything else must not.
  // Scan the whole script, not single lines, and skip balanced parentheses so
  // nested and multi-line calls are still seen.
  const body = script.replace(/^function (guideSection|helpDataTable)\b[^\n]*(\n(?=[ \t])[^\n]*)*/gm, '')
    .replace(/for\(const label of data\.headers\)[^\n]*/g, '');
  const plain = [];
  for (const match of body.matchAll(/node\(\s*(?:(['"`])(?:h2|h3|th|dt)\1|(['"`])div\2\s*,\s*\w+\s*,\s*(['"`])(?:label|k)\3)/g)) {
    let depth = 0, end = match.index + 'node'.length;
    for (; end < body.length; end++) {
      if (body[end] === '(') depth++;
      else if (body[end] === ')' && --depth === 0) break;
    }
    plain.push(body.slice(match.index, end + 1));
  }
  assert.deepEqual(plain, []);
});

test('memory tile, meter and fact labels resolve to a real topic', () => {
  const app = dashboard();
  const labels = new Set();
  for (const [, label] of script.matchAll(/\btile\(\s*'([^']+)'/g)) labels.add(label);
  for (const [, label] of script.matchAll(/\bmeter\(\s*'([^']+)'/g)) labels.add(label);
  const facts = script.match(/for\(const \[label,value\] of \[([\s\S]*?)\]\)\{\s*const item=node/)?.[1] ?? '';
  for (const [, label] of facts.matchAll(/\['([^']+)'\s*,/g)) labels.add(label);
  assert.ok(labels.size >= 15, `found only ${labels.size} labels`);
  const missing = [...labels].filter(label => !app.run(`!!HELP[topicForText(${JSON.stringify(label)})]`));
  assert.deepEqual(missing, []);
  assert.equal(app.run("topicForText('Data + heap (VmData)')"), 'vmdata');
  assert.equal(app.run("topicForText('Page faults since start')"), 'faulttotals');
  assert.equal(app.run("topicForText('Major faults/s')"), 'faults');
});

test('Escape stays suppressed while keyboard focus remains on its trigger', () => {
  const app = helpClock();
  app.run("dwell.request('cpu','CPU')");app.advance(1200);
  app.run("dwell.cancel(true);dwell.leave(()=>true);dwell.request('cpu','CPU')");app.advance(1200);
  assert.equal(app.run('helpEvents.length'), 2);
  assert.equal(app.run('dwell.blocked.key'), 'cpu');
});

test('cell explanations use the displayed observation and distinguish missing from zero', () => {
  const app = dashboard();
  app.run(`
    live={health:{session:'s'},threads:[{tid:1,generation:1,name:'new',run_delay_pct:99,last_sample:200}]};
    var shown={tid:1,generation:1,name:'displayed',run_delay_pct:null,last_sample:100};
    var helpRow={dataset:{tid:'1'},_helpThread:shown,cells:[{textContent:'displayed'}],children:[]};
    var helpTable={querySelectorAll:()=>[{textContent:'Run delay'}]};
    var helpCell={textContent:'·',parentElement:helpRow,querySelector:()=>null,
      closest:selector=>selector==='tr'?helpRow:selector==='table'?helpTable:null};
    helpRow.children=[helpCell];
    var captured=captureHelp({target:helpCell,column:helpCell,id:'delay'});
  `);
  assert.equal(app.run('captured.value'), 'Not available');
  assert.equal(app.run('captured.stamp'), 100);
  assert.equal(app.run('captured.context'), 'displayed · TID 1');
  app.run("shown.run_delay_pct=0;captured=captureHelp({target:helpCell,column:helpCell,id:'delay'})");
  assert.equal(app.run('captured.value'), '0');
  assert.match(app.run('captured.scope'), /preceding ~10 s/);
});

test('each cell has a distinct help target even when it shares a metric topic', () => {
  const app = dashboard();
  app.run("var readCell={textContent:'1'},writeCell={textContent:'1'};var readKey=helpIdentity(readCell,'sysio')");
  assert.notEqual(app.run('readKey'), app.run("helpIdentity(writeCell,'sysio')"));
  app.run("readCell.textContent='2'");
  assert.equal(app.run('readKey'), app.run("helpIdentity(readCell,'sysio')"), 'new values must not reset dwell on the same target');
});

test('zoom legend names every kind shown in the grid, in the grid colors', () => {
  const app = dashboard();
  app.run("live={health:{session:'s'},memory:{available:true,pid:1,layout_id:'s:1'}};memoryLayout={id:'s:1',pid:1}");
  const kinds = JSON.parse(app.run('JSON.stringify(Object.keys(MEMORY_KINDS))'));
  assert.deepEqual([...kinds].sort(), ['anonymous', 'code', 'file', 'guard', 'heap', 'kernel', 'library', 'stack']);
  // Two 8 KB regions with an unmapped page between them, so every zoom also has a "not mapped" square.
  const legend = kind => app.run(`(()=>{const member=(lo,hi)=>({cat:'${kind}',lo,hi,size:Number(hi-lo),start:'0x'+lo.toString(16),permissions:'rw-p',vmas:1,name:''});
    const members=[member(0x10000n,0x12000n),member(0x13000n,0x15000n)];
    memoryLayout.regions=members.map(r=>({...r,end:'0x'+r.hi.toString(16),kind:'${kind}'}));
    memoryPrevious=null;renderMemoryZoom({key:'${kind}',cat:'${kind}',vmas:2,size:16384,lo:0x10000n,hi:0x15000n,members});
    return element('memory-grid-legend').children.map(item=>({label:item.children[1],style:item.children[0].style.background,cls:item.children[0].className}))})()`);
  for (const kind of kinds) {
    const entries=legend(kind),gap=entries.find(item=>item.label==='not mapped'),mapped=entries.find(item=>item.label!=='not mapped');
    assert.equal(entries.length,2,kind);
    assert.equal(mapped.label, app.run(`MEMORY_KIND_LABELS.${kind}`), kind);
    if (kind === 'guard') assert.match(mapped.cls, /cell-guard/);
    else assert.equal(mapped.style, app.run(`MEMORY_KINDS.${kind}[0]`), kind);
    assert.deepEqual([gap.label, gap.cls], ['not mapped', 'sw cell-none'], kind);
  }
  // Squares mapped since the previous layout add the marker entry; unchanged layouts do not.
  app.run("memoryPrevious={regions:[{start:'0x10000',end:'0x12000',permissions:'rw-p',kind:'heap',name:''}]}");
  const labels = app.run(`(()=>{const member=(lo,hi)=>({cat:'heap',lo,hi,size:Number(hi-lo),start:'0x'+lo.toString(16),permissions:'rw-p',vmas:1,name:''});
    memoryLayout.regions=[{start:'0x10000',end:'0x14000',size:16384,vmas:1,kind:'heap',permissions:'rw-p'}];
    renderMemoryZoom({key:'h',cat:'heap',vmas:1,size:16384,lo:0x10000n,hi:0x14000n,members:[member(0x10000n,0x14000n)]});
    return element('memory-grid-legend').children.map(item=>item.children[1])})()`);
  assert.deepEqual([...labels].sort(), ['heap (brk)', 'mapped since the previous layout','not mapped'].sort());
});

// Memory-map hover help on a live collector. refresh() re-runs renderMemory()
// every second; help opens after 1,200 ms, so a rebuild in between would
// disconnect the target and cancel the pending help.
function memoryHelpApp() {
  const app = dashboard();
  const layout = {id: 's:1', pid: 1, regions: [
    {start: '0x555500000000', end: '0x555500200000', size: 2 << 20, vmas: 1, kind: 'heap', permissions: 'rw-p', name: '[heap]'},
    {start: '0x7ffc00000000', end: '0x7ffc00400000', size: 4 << 20, vmas: 1, kind: 'stack', permissions: 'rw-p', name: ''}]};
  app.run(`innerWidth=1000;innerHeight=800;captureHelp=request=>({topic:{title:'T',meaning:'m',limits:'l'},scope:'',context:'',value:'1',stamp:1,warnings:[],target:request.target});
    describeHelp=()=>{};positionHelp=()=>{};
    live={health:{session:'s',pid:1},threads:[],memory:${JSON.stringify(memorySummary({}, {layout_id: 's:1', interval_s: 1}))}};
    memoryLayout=${JSON.stringify(layout)};renderMemory()`);
  return app;
}
// The first node under a host that carries a help topic.
const memoryTargets = {
  tiles: "memory-tiles", findings: "memory-findings", 'limit meters': "memory-limits", 'limit facts': "memory-facts",
  'zoom facts': "memory-zoom-facts", 'chart titles': "memory-charts"};

for (const [name, host] of Object.entries(memoryTargets)) {
  test(`memory ${name} keep their help target through live re-renders`, () => {
    const app = memoryHelpApp();
    app.run(`var host=element('${host}');var target=(function find(node){if(node.dataset?.help)return node;for(const child of node.children){const hit=find(child);if(hit)return hit}return null})(host);
      helpTimer.request('memory-help',{target,id:target.dataset.help})`);
    assert.ok(app.run('target.isConnected'), 'target starts attached');
    app.advance(1000);
    app.run('renderMemory()');
    assert.ok(app.run('target.isConnected'), 'the pending target is not replaced');
    assert.ok(app.run('helpTimer.active&&helpTimer.active.payload.target===target'), 'pending help survives the poll');
    app.advance(200);
    assert.ok(app.run('helpTimer.visible&&helpTimer.visible.payload.target===target'), 'help opens after 1,200 ms');
    app.run('renderMemory()');
    assert.ok(app.run('target.isConnected'), 'an open card keeps its target too');
    // Once help lets go, the next poll applies the skipped rebuild.
    // The zoom facts change only with the layout; their catch-up is tested below.
    app.run('helpTimer.cancel(true)');
    if (host !== 'memory-zoom-facts') {
      app.run('renderMemory()');
      assert.ok(!app.run('target.isConnected'), 'the host is rebuilt after help closes');
    }
    assert.ok(app.run(`element('${host}').children.length>0`));
  });
}

test('a skipped zoom rebuild is applied once help closes', () => {
  const app = memoryHelpApp();
  app.run(`var facts=element('memory-zoom-facts');var label=facts.children[0].children[0];
    helpTimer.request('zoom',{target:label,id:label.dataset.help});
    memoryRenderedLayout=null;renderMemory()`);
  assert.ok(app.run('label.isConnected'));
  assert.ok(app.run('memoryZoomStale'), 'the skipped zoom is remembered');
  app.run("helpTimer.cancel(true);renderMemory()");
  assert.ok(!app.run('memoryZoomStale'));
  assert.ok(!app.run('label.isConnected'));
  // Unrelated hosts are not held back while the zoom is skipped.
  app.run("helpTimer.request('zoom',{target:element('memory-zoom-facts').children[0].children[0],id:'memzoom'});live.memory.values.vma_count=777;renderMemory()");
  assert.ok(app.run("element('memory-tiles').children.some(box=>box.children.some(child=>child.textContent==='777'))"));
});

test('memory zoom uses target page size and omits unknown page counts', () => {
  const app = dashboard();
  app.run(`live={health:{session:'s'},memory:{pid:1},resources:{available:true,session:'s',pid:1,limits:{page_size:4096}}};
    zoomRow=memoryRows(memoryRegions({regions:[{start:'0x100000',end:'0x500000',size:4194304,vmas:1,kind:'heap',permissions:'rw-p'}]}))[0]`);
  for (const page of [4096,65536]) {
    app.run(`live.resources.limits.page_size=${page};renderMemoryZoom(zoomRow)`);
    assert.match(app.elements.get('memory-grid-caption').textContent, /KiB.*pages?\)/);
    assert.ok(app.elements.get('memory-grid').children.length <= 512);
    assert.equal(app.run('memoryPageSize()'), page);
  }
  for (const change of ['delete live.resources.limits.page_size','live.resources.stale=true','live.resources.pid=2','live.resources.session="old"']) {
    // Nothing learned yet for this target: the page size is unknown.
    app.run('memoryPage=null;live.resources={available:true,session:"s",pid:1,limits:{page_size:4096}}');
    app.run(`${change};renderMemoryZoom(zoomRow)`);
    assert.equal(app.run('memoryPageSize()'), null);
    assert.doesNotMatch(app.elements.get('memory-grid-caption').textContent, /\(.*page|KiB/);
    assert.match(app.elements.get('memory-grid-caption').textContent, /One square = \d+ bytes,/);
    assert.ok(app.elements.get('memory-grid').children.length <= 512);
  }
  // Once learned, a late or missing resource sample does not unset it.
  app.run('memoryPage=null;live.resources={available:true,session:"s",pid:1,limits:{page_size:4096}};memoryPageSize();live.resources.stale=true');
  assert.equal(app.run('memoryPageSize()'), 4096);
  app.run('resetMemoryTarget({pid:2})');
  assert.equal(app.run('memoryPageSize()'), null);
  assert.equal(app.run('memoryBytes(2**30)'), '1.0 GiB');
});

function loadMemoryZoom(app) {
  app.run(`live={health:{session:'s',pid:1},threads:[],memory:{available:true,pid:1,updated:10,interval_s:30,layout_id:'s:1',values:{}}};
    memoryLayout={id:'s:1',pid:1,updated:10,regions:[{start:'0x100000',end:'0x200000',size:1048576,vmas:1,kind:'heap',permissions:'rw-p'}]};renderMemory()`);
}
const zoomFacts = app => app.elements.get('memory-zoom-facts').children.map(item => item.children.at(-1).textContent);

test('memory growth refreshes unchanged layouts and rejects stale or other-target history', () => {
  const app = dashboard();loadMemoryZoom(app);
  app.run('live.memory.updated=40;renderMemory()');
  assert.ok(zoomFacts(app).includes('0 B in 30 s'));
  app.run('live.memory.updated=70;renderMemory()');
  assert.ok(zoomFacts(app).includes('0 B in 60 s'));
  app.run('live.memory.stale=true;renderMemory()');
  assert.ok(zoomFacts(app).includes('Unavailable'));
  app.run('live.memory.stale=false;live.memory.layout_id="s:2";renderMemory()');
  assert.ok(zoomFacts(app).includes('Unavailable'));
  app.run('live.health.session="other";live.memory.layout_id="other:1";memoryLayout.id="other:1";renderMemory()');
  assert.equal(app.run('memoryHistory.length'),1);
  assert.ok(zoomFacts(app).includes('Collecting…'));
  assert.equal(app.run('memoryPrevious'),null);
  app.run('live.memory.pid=2;live.health.pid=2;memoryLayout.pid=2;renderMemory()');
  assert.equal(app.run('memoryHistory.length'),1);
});

test('largest unmapped gap clips and merges exact high-address ranges', () => {
  const app = dashboard();
  app.run(`gapBase=2n**60n;gapRow={lo:gapBase,hi:gapBase+100n,members:[
    {lo:gapBase+80n,hi:gapBase+110n},{lo:gapBase+30n,hi:gapBase+50n},
    {lo:gapBase-10n,hi:gapBase+10n},{lo:gapBase+40n,hi:gapBase+60n}]}`);
  assert.equal(app.run('memoryLargestGap(gapRow)'),20n);
  app.run('gapRow.members.push({lo:gapBase,hi:gapBase+100n})');
  assert.equal(app.run('memoryLargestGap(gapRow)'),0n);
  app.run('gapRow.members=[]');
  assert.equal(app.run('memoryLargestGap(gapRow)'),100n);
});

test('incomplete memory layouts cannot claim unmapped gaps or new mappings', () => {
  const app = dashboard();loadMemoryZoom(app);
  app.run(`memoryLayout.regions.push({start:'0x300000',end:'0x400000',size:1048576,vmas:1,kind:'heap',permissions:'rw-p'});
    gapZoom={cat:'heap',lo:0x100000n,hi:0x400000n,size:2097152,vmas:2,members:memoryRegions(memoryLayout)};
    renderMemoryZoom(gapZoom)`);
  assert.ok(zoomFacts(app).includes('1.0 MiB'));
  for (const flag of ['maps_partial','maps_hidden','regions_truncated']) {
    app.run(`live.memory.flags={${flag}:true};renderMemoryZoom(gapZoom)`);
    assert.ok(zoomFacts(app).includes('Unavailable'));
    assert.ok(app.elements.get('memory-grid').children.some(cell=>cell.className==='cell-unknown'));
    assert.ok(!app.elements.get('memory-grid').children.some(cell=>cell.className==='cell-none'));
  }
  app.run('live.memory.flags={};memoryLayout.flags={regions_truncated:true};renderMemoryZoom(gapZoom)');
  assert.ok(zoomFacts(app).includes('Unavailable'));
});

test('memory boundary charts preserve high-address steps and missing samples', () => {
  const app = dashboard();loadMemoryZoom(app);
  app.run(`high=2n**60n;regions=[{cat:'heap',size:4096,lo:high,hi:high+4096n},{cat:'stack',size:4096,lo:high+65536n,hi:high+69632n}];
    memoryHistory=[];recordMemory({...live.memory,updated:10},regions,true);
    regions[0].hi+=4096n;regions[1].lo-=4096n;
    recordMemory({...live.memory,updated:40},regions,true);
    recordMemory({...live.memory,updated:70},regions,true);
    recordMemory({...live.memory,updated:100},regions,false);
    regions[0].hi-=4096n;recordMemory({...live.memory,updated:130},regions,true)`);
  assert.deepEqual([...app.run("memoryBoundaryPoints('heapEnd').map(p=>p.offset)")],[0,4096,4096,null,0]);
  assert.deepEqual([...app.run("memoryBoundaryPoints('stackStart').map(p=>p.offset)")],[0,-4096,-4096,null,-4096]);
  // Inspect the actual SVG: the missing sample splits the two valid runs.
  app.run(`chart=memoryChart('Heap mapping end ↑',memoryBoundaryPoints('heapEnd'),'offset','blue',true)`);
  const lines = app.run('chart.children[1].children.filter(item=>item.attrs.points)');
  assert.equal(lines.length,2);
  assert.match(app.run('chart.children.at(-1).textContent'),/^Offset: 0 B → 0 B$/);
  app.run('live.health.session="new";resetMemoryTarget(live.memory);recordMemory({...live.memory,updated:160},regions,true)');
  assert.deepEqual([...app.run("memoryBoundaryPoints('heapEnd').map(p=>p.offset)")],[0]);
});

test('heap margin survives layout replacement and a pending layout fetch', () => {
  const app = dashboard();loadMemoryZoom(app);
  const before = app.run('memoryHeapSpan.hi');
  const count = app.elements.get('memory-grid').children.length;
  // A new layout ID arrives before its maps response. Coverage is unknown
  // during that poll, but it must not discard the selected heap's span.
  app.run("live.memory.layout_id='s:2';live.memory.updated=11;renderMemory()");
  app.run(`memoryLayout={...memoryLayout,id:'s:2',regions:[{
    ...memoryLayout.regions[0],end:'0x201000',size:1052672}]};renderMemory()`);
  assert.equal(app.run('memoryHeapSpan.hi'),before);
  assert.equal(app.elements.get('memory-grid').children.length,count);
  assert.ok(zoomFacts(app).includes('1.0 MiB'));
  // A command name update also rebuilds the map without changing selection.
  app.run("live.threads=[{tid:1,name:'renamed'}];renderMemory()");
  assert.equal(app.run('memoryHeapSpan.hi'),before);
  // Growth beyond the retained margin creates a new bounded span.
  app.run(`live.memory.layout_id='s:3';memoryLayout={...memoryLayout,id:'s:3',
    regions:[{...memoryLayout.regions[0],end:'0x241000',size:1314816}]};renderMemory()`);
  assert.ok(app.run('memoryHeapSpan.hi')>before);
  assert.ok(app.run('memoryHeapSpan.hi-memoryRows(memoryRegions(memoryLayout))[0].hi<=1048576n'));
  app.run("live.health.session='other';renderMemory()");
  assert.equal(app.run('memoryHeapSpan'),null);
});

test('heap margin stays bounded and stable, includes neighbors, and resets on selection', () => {
  const app = dashboard();loadMemoryZoom(app);
  app.run(`heap=memoryRows(memoryRegions(memoryLayout))[0];span=memoryDisplaySpan(heap);
    neighbor={start:'0x210000',end:'0x220000',size:65536,vmas:1,kind:'file',permissions:'rw-p',name:'/tmp/data'};
    memoryLayout.regions.push(neighbor);renderMemoryZoom(heap)`);
  assert.ok(app.run('span.hi-heap.hi<=1048576n'));
  assert.ok(app.run("element('memory-grid-legend').children.some(item=>item.children[1]==='file mapping')"));
  const before = app.run('span.hi');
  app.run('heap.hi+=65536n;heap.size+=65536');
  assert.equal(app.run('memoryDisplaySpan(heap).hi'),before);
  app.run('heap.hi=span.hi+65536n;heap.size=Number(heap.hi-heap.lo)');
  assert.ok(app.run('memoryDisplaySpan(heap).hi>span.hi'));
  app.run('memoryDisplaySpan({...heap,cat:"stack"})');
  assert.equal(app.run('memoryHeapSpan'),null);
  app.run('live.memory.stale=true');
  assert.equal(app.run('memoryDisplaySpan(heap).hi'),app.run('heap.hi'));
  assert.ok(app.elements.get('memory-grid').children.length<=512);
});

function processFacts(app) {
  const card = app.elements.get('process-info');
  const facts = Object.fromEntries(app.elements.get('process-facts').children.map(
    item => [item.children[0].textContent, item.children[1].textContent]));
  return {card, facts};
}

test('process details show the readable facts and say what is not available', () => {
  const app = dashboard();
  const info = {session: 's', pid: 1234, started_at: 1700000000, parent_pid: 1, uid: 1000, euid: 1000,
    gid: 100, egid: 100, command: '/usr/bin/app --port 8080', command_truncated: false,
    executable: '/usr/bin/app', executable_truncated: false, exe_hidden: false, exe_deleted: true,
    working_directory: '', working_directory_truncated: false, cwd_hidden: true,
    cpus_allowed: '0-3,8', cpus_truncated: false};
  // A recorded view counts the run time to the recording time.
  app.run(`replayAt=1700000000+3*3600;live={health:{session:'s'},process:${JSON.stringify(info)}};renderProcessInfo()`);
  let {card, facts} = processFacts(app);
  assert.equal(card.hidden, false);
  assert.deepEqual(Object.keys(facts), ['Command line', 'Executable', 'Working directory', 'Started',
    'Parent process', 'User & group', 'Allowed CPUs']);
  assert.equal(facts['Command line'], '/usr/bin/app --port 8080');
  // The sampler sends the path without the suffix and sets exe_deleted.
  assert.equal(facts.Executable, '/usr/bin/app (deleted)');
  assert.match(facts['Working directory'], /^Not available.*process owner/);
  assert.match(facts.Started, / · up 3\.0 h$/);
  assert.equal(facts['Parent process'], 'PID 1');
  assert.equal(facts['User & group'], 'UID 1000 · GID 100');
  assert.equal(facts['Allowed CPUs'], '0-3,8');
  // Every label has a help topic.
  for (const item of app.elements.get('process-facts').children) {
    assert.ok(app.run(`!!HELP[${JSON.stringify(item.children[0].dataset.help)}]`), item.children[0].textContent);
  }

  // Effective IDs show only when they differ; unread values are not zero.
  Object.assign(info, {euid: 0, gid: null, egid: null, parent_pid: 0, started_at: null, cpus_allowed: '',
    command: '', command_truncated: true});
  app.run(`live.process=${JSON.stringify(info)};renderProcessInfo()`);
  ({facts} = processFacts(app));
  assert.equal(facts['User & group'], 'UID 1000 (effective 0) · GID Not available');
  assert.match(facts['Parent process'], /^None visible/);
  assert.equal(facts.Started, 'Not available');
  assert.equal(facts['Allowed CPUs'], 'Not available');
  assert.match(facts['Command line'], /^Empty/);

  // A cut command ends with an ellipsis; a cut path begins with one.
  Object.assign(info, {command: '/usr/bin/app --long', command_truncated: true,
    executable: 'bin/app', executable_truncated: true, exe_deleted: false});
  app.run(`live.process=${JSON.stringify(info)};renderProcessInfo()`);
  ({facts} = processFacts(app));
  assert.equal(facts['Command line'], '/usr/bin/app --long …');
  assert.equal(facts.Executable, '…bin/app');

  // Info read for another session is never shown for this one.
  app.run("live.health.session='t';renderProcessInfo()");
  assert.equal(processFacts(app).card.hidden, true);
  app.run("live.process=null;live.health.session='s';renderProcessInfo()");
  assert.equal(processFacts(app).card.hidden, true);
});

// Watched threads. A thread is built as the live API reports it: a rule gave it
// wake_ms, and it last ran `quiet` seconds before its newest sample (at 1000).
function watchedThread(tid, name, {wake = 500, quiet = 0, cpu = 0.2, state = 'futex', wchan = 'futex_do_wait', ...rest} = {}) {
  return {tid, name, state, wchan, cpu_pct: cpu, switches_per_s: 1, state_mix: {[state]: 20}, run_delay_pct: 0,
    read_bps: 0, write_bps: 0, major_faults_per_s: 0, last_sample: 1000, last_ran: 1000 - quiet, wake_ms: wake,
    stale: false, generation: 0, ...rest};
}

// Show `threads` to the dashboard and return its findings as [level, title, detail].
function watchFindings(threads, {health = {}, rules = null, setup = ''} = {}) {
  const app = dashboard();
  app.run(`live={health:{session:'s',sample_interval_ms:200,...${JSON.stringify(health)}},threads:${JSON.stringify(threads)}};
    lastTick=1000;watchRules=${JSON.stringify(rules)};${setup}`);
  const findings = JSON.parse(app.run('JSON.stringify(assess(live.threads,[]))'));
  return {app, findings, watch: findings.filter(item => item.help === 'watched')};
}

test('a watched thread that has not run for over 2 x wake + 2 x sample interval stopped waking', () => {
  // wake 500 ms, sample interval 200 ms: overdue after 2 x 0.5 + 2 x 0.2 = 1.4 s.
  const limit = quiet => watchFindings([watchedThread(1, 'worker-1', {quiet})]).watch;
  assert.equal(limit(1.4).some(item => item.level === 'serious'), false, 'exactly at the limit is on time');
  assert.equal(limit(1.0).some(item => item.level === 'serious'), false);
  const [stuck] = limit(4.2);
  assert.equal(stuck.level, 'serious');
  assert.equal(stuck.title, 'worker-1 stopped waking up');
  assert.match(stuck.detail, /TID 1 is set to wake at least every 500 ms, but it has not run for 4\.2 s\. It may be deadlocked or waiting without a timeout\. Last state: Futex wait in futex_do_wait\./);
  assert.deepEqual(stuck.action, {tid: 1});
  // The interval term: a 10 ms rule is not flagged by ordinary sampling jitter, a 1 s sampler tolerates more.
  const fast = quiet => watchFindings([watchedThread(1, 'tick-1', {wake: 10, quiet})]).watch.some(item => item.level === 'serious');
  assert.equal(fast(0.4), false);
  assert.equal(fast(0.5), true);
  const slow = quiet => watchFindings([watchedThread(1, 'tick-1', {wake: 500, quiet})], {health: {sample_interval_ms: 1000}}).watch.some(item => item.level === 'serious');
  assert.equal(slow(2.9), false);
  assert.equal(slow(3.1), true);
  // An unknown sample interval is assumed to be slow, never fast.
  assert.equal(watchFindings([watchedThread(1, 'tick-1', {quiet: 2.9})], {health: {sample_interval_ms: null}}).watch.some(item => item.level === 'serious'), false);
});

test('stuck time is measured between samples, not against the clock', () => {
  const app = dashboard();
  // The view is long past the samples (paused sampler, a replay): still on time.
  app.run(`live={health:{session:'s',sample_interval_ms:200},threads:[${JSON.stringify(watchedThread(1, 'worker-1', {quiet: 0.1}))}]};
    lastTick=1000;watchRules=null;replayAt=2000;frozen=null`);
  const titles = JSON.parse(app.run('JSON.stringify(assess(live.threads,[]).map(item=>item.title))'));
  assert.deepEqual(titles.filter(title => /worker-1|watched/.test(title)), ['1 watched thread wakes on schedule']);
});

test('several stuck threads become one finding, worst first', () => {
  const threads = [1, 2, 3, 4, 5].map(tid => watchedThread(tid, 'worker-' + tid, {quiet: tid + 1}));
  threads.push(watchedThread(6, 'io-1', {wake: 100, quiet: 0.1, state: 'sleep', wchan: ''}));
  const {watch} = watchFindings(threads);
  const stuck = watch.filter(item => item.level === 'serious');
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].title, '5 watched threads stopped waking up');
  assert.match(stuck[0].detail, /Worst first: worker-5 \(6\.0 s, every 500 ms\), worker-4 \(5\.0 s, every 500 ms\), worker-3 \(4\.0 s, every 500 ms\) and 2 more\./);
  assert.deepEqual(stuck[0].action, {tid: 5});
  assert.equal(watch.some(item => item.level === 'info'), false, 'no "on schedule" line while some thread is stuck');
});

test('a busy watched thread gets one specific finding instead of the generic one', () => {
  const {findings, watch} = watchFindings([watchedThread(1, 'worker-spin', {cpu: 99, state: 'running', wchan: ''}),
    watchedThread(2, 'plain-spin', {cpu: 95, state: 'running', wchan: '', wake: null, last_ran: undefined})]);
  const titles = findings.map(item => item.title);
  assert.deepEqual(titles.filter(title => /spin/.test(title)).sort(), ['plain-spin is saturating a core', 'worker-spin is running instead of sleeping']);
  assert.equal(watch.length, 1);
  assert.equal(watch[0].level, 'serious');
  assert.match(watch[0].detail, /expected to sleep and wake every 500 ms, but it uses 99\.0% of one core\. It may be stuck in an infinite or retry loop\./);
  assert.deepEqual(watch[0].action, {tid: 1});
  const several = watchFindings([1, 2, 3].map(tid => watchedThread(tid, 'worker-' + tid, {cpu: 90 + tid, state: 'running'}))).watch;
  assert.equal(several.length, 1);
  assert.equal(several[0].title, '3 watched threads are running instead of sleeping');
  assert.match(several[0].detail, /worker-3 93\.0%, worker-2 92\.0%, worker-1 91\.0%/);
});

test('watch findings skip stale threads, a silent sampler, an absent target and unwatched data', () => {
  const stale = watchedThread(1, 'worker-1', {quiet: 30, stale: true});
  assert.deepEqual(watchFindings([stale]).watch, []);
  const stuck = watchedThread(1, 'worker-1', {quiet: 30});
  assert.deepEqual(watchFindings([stuck], {health: {sampler_silent: true}}).watch, []);
  assert.deepEqual(watchFindings([stuck], {health: {target_absent: true}}, ).watch, []);
  // Older recordings carry neither wake_ms nor last_ran: not watched.
  const old = watchedThread(1, 'worker-1', {quiet: 30});
  delete old.wake_ms; delete old.last_ran;
  assert.deepEqual(watchFindings([old]).watch, []);
  assert.deepEqual(watchFindings([watchedThread(1, 'worker-1', {wake: null, quiet: 30})]).watch, []);
});

test('a rule that matches no current thread is a warning, only for a live present target', () => {
  const rules = [{prefix: 'worker-', wake_ms: 500}, {prefix: 'gone-', wake_ms: 200}];
  const threads = [watchedThread(1, 'worker-1')];
  const {watch} = watchFindings(threads, {rules});
  const missing = watch.find(item => item.level === 'warning');
  assert.equal(missing.title, 'A watch rule matches no thread');
  assert.match(missing.detail, /^No thread matches watch rule “gone-”: the threads may have exited or been renamed\./);
  // The longest prefix wins, so a rule shadowed by a longer one matches nothing.
  const shadowed = watchFindings([watchedThread(1, 'worker-io-1', {wake: 100})], {rules: [{prefix: 'worker-', wake_ms: 500}, {prefix: 'worker-io', wake_ms: 100}]}).watch;
  assert.match(shadowed.find(item => item.level === 'warning').detail, /“worker-”/);
  assert.equal(watchFindings(threads, {rules: [{prefix: 'worker-', wake_ms: 500}]}).watch.some(item => item.level === 'warning'), false);
  // A stale thread does not satisfy a rule; no threads at all says nothing.
  assert.equal(watchFindings([watchedThread(1, 'gone-1', {stale: true}), ...threads], {rules}).watch.filter(item => item.level === 'warning').length, 1);
  assert.equal(watchFindings([], {rules}).watch.length, 0);
  // Not loaded, replay, final view, silent sampler, absent target: skipped.
  assert.equal(watchFindings(threads).watch.some(item => item.level === 'warning'), false);
  assert.equal(watchFindings(threads, {rules, setup: 'replayAt=999'}).watch.some(item => item.level === 'warning'), false);
  assert.equal(watchFindings(threads, {rules, setup: "frozen={at:1000,live:{health:{session:'s'}}}"}).watch.some(item => item.level === 'warning'), false);
  assert.equal(watchFindings(threads, {rules, health: {sampler_silent: true}}).watch.some(item => item.level === 'warning'), false);
  assert.equal(watchFindings(threads, {rules, health: {target_absent: true}}).watch.some(item => item.level === 'warning'), false);
  // The rule list is older than the threads (a rule was just saved): wait for the refresh.
  assert.equal(watchFindings([watchedThread(1, 'worker-1', {wake: 250})], {rules}).watch.some(item => item.level === 'warning'), false);
  assert.equal(watchFindings([watchedThread(1, 'worker-1', {wake: null})], {rules}).watch.some(item => item.level === 'warning'), false);
});

test('healthy watched threads get one line naming their rules', () => {
  const rules = [{prefix: 'worker-', wake_ms: 500}, {prefix: 'io-', wake_ms: 100}];
  const threads = [watchedThread(1, 'worker-1', {quiet: 0.3}), watchedThread(2, 'worker-2'), watchedThread(3, 'io-1', {wake: 100, quiet: 0.1}),
    watchedThread(4, 'worker-3', {quiet: 0.2})];
  const {watch} = watchFindings(threads, {rules});
  assert.deepEqual(watch.map(item => [item.level, item.title]), [['info', '4 watched threads wake on schedule (worker-, io-)']]);
  assert.deepEqual(watchFindings([watchedThread(1, 'worker-1')]).watch.map(item => item.title), ['1 watched thread wakes on schedule'], 'without rules, only the count');
  assert.deepEqual(watchFindings([{...watchedThread(1, 'misc'), wake_ms: null}]).watch, []);
});

test('rules load once, refresh every 10 s and are fetched again when they look out of date', async () => {
  const app = dashboard();
  let rules = [{prefix: 'worker-', wake_ms: 500}];
  app.run("live={health:{session:'s'},threads:[]};replayAt=null;frozen=null");
  let count = 0;
  app.setFetch(async url => {if (url === '/api/watches') count++; return {ok: true, json: async () => ({rules})};});
  const fetches = () => count;
  const tick = async (threads = '[]') => {app.run(`watchRulesTick(${threads})`); await new Promise(setImmediate);};
  const before = fetches();
  await tick();
  assert.equal(fetches(), before + 1);
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(watchRules)')), rules);
  await tick();
  assert.equal(fetches(), before + 1, 'not again within 10 s');
  app.run('watchRulesAt-=11000');
  await tick();
  assert.equal(fetches(), before + 2);
  // A thread reports a wake_ms the list does not give it: fetch sooner, but not every poll.
  const changed = JSON.stringify([watchedThread(1, 'worker-1', {wake: 250})]);
  await tick(changed);
  assert.equal(fetches(), before + 2, 'retry is throttled to 3 s');
  rules = [{prefix: 'worker-', wake_ms: 250}];
  app.run('watchRulesAt-=3500');
  await tick(changed);
  assert.equal(fetches(), before + 3);
  assert.equal(app.run('watchRules[0].wake_ms'), 250);
  // Not in a recording or a final view.
  app.run('watchRulesAt=0;replayAt=5');
  await tick();
  app.run('replayAt=null;frozen={at:1}');
  await tick();
  assert.equal(fetches(), before + 3);
  // A failed request leaves no rules, so no unmatched-rule finding can come from them.
  app.run('frozen=null;watchRulesAt=0');
  app.setFetch(async () => ({ok: false}));
  await tick();
  assert.equal(app.run('watchRules'), null);
});

test('the thread drawer shows a compact line for watched threads only', () => {
  const app = dashboard();
  app.run("live={health:{session:'s',sample_interval_ms:200},threads:[]}");
  const line = thread => JSON.parse(app.run(`JSON.stringify((t=>{const n=watchLine(t);return n&&[n.textContent,n.dataset.help]})(${JSON.stringify(thread)}))`));
  assert.deepEqual(line(watchedThread(1, 'worker-1', {quiet: 0.2})), ['Watched: wakes at least every 500 ms · last ran 0.2 s before the latest sample', 'watched']);
  assert.equal(line(watchedThread(1, 'worker-1', {quiet: 0}))[0], 'Watched: wakes at least every 500 ms · ran in the latest sample');
  assert.match(line(watchedThread(1, 'worker-1', {quiet: 4.2}))[0], /last ran 4\.2 s before the latest sample · overdue$/);
  assert.equal(line(watchedThread(1, 'misc', {wake: null})), null);
});

test('a watched finding keeps its help target through live re-renders', () => {
  const {app} = watchFindings([watchedThread(1, 'worker-1', {quiet: 30})]);
  app.run(`innerWidth=1000;innerHeight=800;captureHelp=request=>({topic:{title:'T',meaning:'m',limits:'l'},scope:'',context:'',value:'1',stamp:1,warnings:[],target:request.target});
    describeHelp=()=>{};positionHelp=()=>{};realRenderAssessment(live.threads);
    var target=[...element('findings').children].find(row=>row.dataset.help==='watched');target.closest=()=>null;helpTimer.request('watched-help',{target,id:'watched'})`);
  // Live polling re-renders about once a second, before the 1,200 ms help delay ends.
  app.advance(1000);
  app.run('realRenderAssessment(live.threads);refreshHelp()');
  assert.ok(app.run('target.isConnected'), 'the pending row is not replaced');
  assert.ok(app.run('helpTimer.active&&helpTimer.active.payload.target===target'), 'pending help survives the poll');
  app.advance(200);
  assert.ok(app.run('helpTimer.visible&&helpTimer.visible.payload.target===target'), 'help opens after 1,200 ms');
  app.run('realRenderAssessment(live.threads);refreshHelp()');
  assert.ok(app.run('target.isConnected'), 'an open card keeps its row too');
  app.run('helpTimer.cancel(true);realRenderAssessment(live.threads)');
  assert.ok(!app.run('target.isConnected'), 'the list is rebuilt after help closes');
});

// ---------- Settings tab: watched-thread rules ----------
const watchLimits = {prefix_max_bytes: 15, wake_ms_min: 10, wake_ms_max: 3600000, max_rules: 64};
const watchReply = (rules, extra = {}) => ({rules, source: 'config', saved_error: null, revision: 'test-1', limits: watchLimits, ...extra});
const httpReply = (body, status = 200) => ({ok: status < 400, status, json: async () => body});
async function watchApp(info = watchReply([{prefix: 'worker-', wake_ms: 500}]), onWrite = () => httpReply(info)) {
  const writes = [];
  const app = dashboard(new Map(), url => url === '/api/watches' ? Promise.resolve(httpReply(info)) : undefined);
  app.setFetch(async (url, options) => {
    if (options?.method === 'POST') {writes.push({url, options}); return onWrite(url, options);}
    return url === '/api/watches' ? httpReply(info) : new Promise(() => {});
  });
  await app.run('loadWatches()');
  app.writes = writes;
  app.type = (row, field, text) => app.run(`watchRows[${row}].${field}.value=${JSON.stringify(text)};watchRows[${row}].${field}.oninput()`);
  app.el = id => app.elements.get(id);
  return app;
}

test('watch rule fields are checked against the collector limits, and Save follows', async () => {
  const app = await watchApp();
  assert.equal(app.el('watch-save').disabled, true, 'nothing changed');
  assert.match(app.el('watch-source').textContent, /^From the config file \(collector\.toml\)\.$/);
  assert.equal(app.el('watch-reset').disabled, true, 'nothing saved to reset');
  const prefixError = () => app.run('watchRows[0].prefixError.textContent'), wakeError = () => app.run('watchRows[0].wakeError.textContent');
  app.type(0, 'prefix', '');
  assert.equal(prefixError(), 'Enter a prefix.');
  assert.equal(app.el('watch-save').disabled, true);
  app.type(0, 'prefix', 'é'.repeat(8));
  assert.match(prefixError(), /Too long: 16 bytes/, 'the limit counts UTF-8 bytes, not characters');
  app.type(0, 'prefix', 'é'.repeat(7));
  assert.equal(prefixError(), '');
  for (const [text, message] of [['', /Enter a number/], ['5', /At least 10 ms/], ['1.5', /whole number/], ['1e3', /whole number/], ['-5', /whole number/], ['3600001', /At most 3,600,000 ms/]]) {
    app.type(0, 'wake', text);
    assert.match(wakeError(), message, text);
    assert.equal(app.el('watch-save').disabled, true, text);
  }
  app.type(0, 'wake', ' 250 ');
  assert.equal(wakeError(), '');
  assert.equal(app.el('watch-save').disabled, false);
  assert.match(app.el('watch-unsaved').textContent, /^Unsaved edits\. They apply only after you select Save/);
  assert.equal(app.el('watch-unsaved').hidden, false);
  // Back to the saved list: nothing to save or warn about.
  app.type(0, 'prefix', 'worker-'); app.type(0, 'wake', '500');
  assert.equal(app.el('watch-save').disabled, true);
  assert.equal(app.el('watch-unsaved').hidden, true);
  // Add rule: a duplicate prefix is marked on the later rule, and the rule limit stops Add.
  app.el('watch-add').onclick();
  assert.equal(app.run('watchDraft.length'), 2);
  app.type(1, 'prefix', 'worker-'); app.type(1, 'wake', '100');
  assert.match(app.run('watchRows[1].prefixError.textContent'), /Same prefix as rule 1/);
  assert.equal(app.el('watch-save').disabled, true);
  app.run('watchDraft=Array.from({length:64},(_,i)=>({prefix:"p"+i,wake:"100"}));renderWatchRows()');
  assert.equal(app.el('watch-add').disabled, true);
  assert.match(app.el('watch-limit').textContent, /At most 64 rules/);
});

test('matching threads now counts live threads with the longest prefix, as the collector does', async () => {
  const app = await watchApp(watchReply([{prefix: 'worker-', wake_ms: 500}, {prefix: 'worker-io', wake_ms: 2000}]));
  app.run(`latestLive={threads:['worker-1','worker-2','worker-io-1','worker-io-1','main'].map((name,i)=>({tid:i+1,name}))}`);
  app.run('updateWatch()');
  const count = row => app.run(`watchRows[${row}].count.textContent`), names = row => app.run(`watchRows[${row}].names.textContent`);
  assert.equal(count(0), '2');
  assert.match(names(0), /^worker-1, worker-2\. 2 more threads start with this prefix but use a longer rule\.$/);
  assert.equal(count(1), '2');
  assert.equal(names(1), 'worker-io-1 (×2)');
  // Typing updates the count at once; a prefix nothing starts with says so.
  app.type(1, 'prefix', 'Worker-io');
  assert.equal(count(1), '0');
  assert.match(names(1), /^No live thread name starts with this prefix\.$/);
  assert.equal(count(0), '4');
  // A duplicate prefix ties with the first rule; it is not "a longer rule".
  app.type(1, 'prefix', 'worker-io'); app.el('watch-add').onclick(); app.type(2, 'prefix', 'worker-io');
  assert.equal(count(2), '0');
  assert.doesNotMatch(names(2), /longer rule/);
  // No target: nothing to count against, and the note says so instead of blaming the prefix.
  app.run('latestLive={threads:[]}; updateWatch()');
  assert.equal(names(1), 'No live threads to check against.');
  // Recorded moments have no live threads.
  app.run("latestLive={threads:[{tid:1,name:'worker-1'}]};replayAt=100;updateWatch()");
  assert.equal(count(0), '0');
});

test('saving sends the whole list with the guard header and shows the reply or the collector error', async () => {
  const saved = watchReply([{prefix: 'db-', wake_ms: 250}], {source: 'dashboard'});
  const app = await watchApp(watchReply([{prefix: 'worker-', wake_ms: 500}]), () => httpReply(saved));
  app.run('var refreshed=0; refreshWatchRules=async()=>{refreshed++}');
  app.type(0, 'prefix', 'db-'); app.type(0, 'wake', '250');
  await app.run('saveWatches()');
  assert.equal(app.writes.length, 1);
  assert.equal(app.writes[0].url, '/api/watches');
  assert.equal(app.writes[0].options.headers['X-Triangulator'], '1');
  assert.equal(app.writes[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(app.writes[0].options.body), {rules: [{prefix: 'db-', wake_ms: 250}]});
  assert.equal(app.el('watch-status').textContent, 'Saved and applied.');
  assert.equal(app.run('refreshed'), 1, 'the Assessment re-reads the rules after a save');
  assert.match(app.el('watch-source').textContent, /^Saved from the dashboard\. These replace the \[\[watch\]\] rules in collector\.toml until you reset\.$/);
  assert.equal(app.el('watch-save').disabled, true);
  assert.equal(app.el('watch-reset').disabled, false);

  // The collector refuses: its message is shown unchanged and the edits stay.
  const refused = await watchApp(watchReply([]), () => httpReply({error: 'watch rule 1 (prefix "x"): nope'}, 400));
  refused.el('watch-add').onclick(); refused.type(0, 'prefix', 'x'); refused.type(0, 'wake', '100');
  await refused.run('saveWatches()');
  assert.equal(refused.el('watch-status').textContent, 'watch rule 1 (prefix "x"): nope');
  assert.equal(refused.run('watchDraft.length'), 1);
  assert.equal(refused.el('watch-save').disabled, false, 'the user can fix and retry');
  assert.equal(refused.el('watch-unsaved').hidden, false);
});

test('a save the collector applied but could not confirm on disk shows the rules in force and a warning', async () => {
  const app = await watchApp(watchReply([]), () => httpReply({error: 'rules were applied, but persistence could not be confirmed', applied: true}, 500));
  const inForce = watchReply([{prefix: 'a', wake_ms: 100}], {source: 'dashboard'});
  app.setFetch(async (url, options) => options?.method === 'POST'
    ? httpReply({error: 'rules were applied, but persistence could not be confirmed', applied: true, applied_state: inForce}, 500) : httpReply(inForce));
  app.el('watch-add').onclick(); app.type(0, 'prefix', 'a'); app.type(0, 'wake', '100');
  await app.run('saveWatches()');
  assert.match(app.el('watch-status').textContent, /^Warning: rules were applied/);
  assert.equal(app.el('watch-status').className, 'warning');
  assert.equal(app.el('watch-unsaved').hidden, true, 'the list in force equals the list on screen');
});

test('reset asks first, mentions unsaved edits, and returns to the config file rules', async () => {
  const config = watchReply([{prefix: 'worker-', wake_ms: 500}]);
  const app = await watchApp(watchReply([{prefix: 'db-', wake_ms: 250}], {source: 'dashboard'}), () => httpReply(config));
  const questions = [];
  app.run('confirm=question=>{questions.push(question);return answer}; var questions=[]; var answer=false');
  app.type(0, 'wake', '300');
  app.el('watch-reset').onclick();
  assert.equal(app.writes.length, 0, 'declining the question changes nothing');
  app.run('answer=true');
  app.el('watch-reset').onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.writes.length, 1);
  assert.equal(app.writes[0].url, '/api/watches/reset');
  assert.equal(app.writes[0].options.headers['X-Triangulator'], '1');
  assert.match(app.run('questions[0]'), /unsaved edits will also be lost/);
  assert.match(app.el('watch-source').textContent, /^From the config file/);
  assert.equal(app.run('watchDraft[0].prefix'), 'worker-');
});

test('a collector without the endpoint, a recorded moment and a broken saved file are explained', async () => {
  const missing = dashboard(new Map(), url => url === '/api/watches' ? Promise.resolve(httpReply({}, 404)) : undefined);
  await missing.run('loadWatches()');
  assert.equal(missing.elements.get('watch-editor').hidden, true);
  assert.match(missing.elements.get('watch-readonly').textContent, /no \/api\/watches/);
  assert.equal(missing.elements.get('watch-readonly').hidden, false);

  const broken = await watchApp(watchReply([{prefix: 'worker-', wake_ms: 500}], {saved_error: 'watch-rules.json: bad rule'}));
  assert.equal(broken.el('watch-warning').hidden, false);
  assert.match(broken.el('watch-warning').textContent, /watch-rules\.json: bad rule/);
  assert.equal(broken.el('watch-reset').disabled, false, 'reset removes the broken file');

  broken.run('replayAt=100;renderWatchMode()');
  assert.equal(broken.el('watch-editor').hidden, true);
  assert.match(broken.el('watch-readonly').textContent, /recorded moment/);
  broken.run('replayAt=null;renderWatchMode()');
  assert.equal(broken.el('watch-editor').hidden, false);
});

test('a rules read that an edit, a save or a reset overtook is dropped', async () => {
  const original = watchReply([{prefix: 'worker-', wake_ms: 500}]);
  const saved = watchReply([{prefix: 'worker-', wake_ms: 100}], {source: 'dashboard'});
  const app = await watchApp(original, () => httpReply(saved));
  let answer;
  const pendingRead = () => {app.setFetch(async (url, options) => options?.method === 'POST' ? httpReply(saved)
    : new Promise(resolve => {answer = resolve;}));};
  // Selecting Settings again re-reads while the fields stay editable.
  pendingRead();
  const read = app.run('loadWatches()');
  app.type(0, 'wake', '250');
  answer(httpReply(original)); await read;
  assert.equal(app.run('watchRows[0].wake.value'), '250', 'the edit made during the read is kept');
  assert.equal(app.run('watchDirty()'), true);
  assert.equal(app.el('watch-unsaved').hidden, false);
  // A reply that arrives after a save would put back the rules from before it.
  app.type(0, 'wake', '500');
  const late = app.run('loadWatches()'), answerLate = answer;
  app.type(0, 'wake', '100');
  await app.run('saveWatches()');
  answerLate(httpReply(original)); await late;
  assert.equal(app.run('watchInfo.rules[0].wake_ms'), 100);
  assert.equal(app.run('watchRows[0].wake.value'), '100');
  assert.equal(app.el('watch-status').textContent, 'Saved and applied.');
  // A failed read that was overtaken does not show an error or schedule a retry.
  app.run('watchInfo=null');
  const failed = app.run('loadWatches()'), answerFailed = answer;
  app.run('watchRead++');
  answerFailed(httpReply({}, 503)); await failed;
  assert.equal(app.run('watchLoadError'), '');
});

test('a change the collector applied but could not confirm can be repeated until it is confirmed', async () => {
  const unconfirmed = {error: 'rules were applied, but persistence could not be confirmed for /d/watch-rules.json: Input/output error', applied: true};
  const inForce = watchReply([{prefix: 'a', wake_ms: 100}], {source: 'dashboard'});
  let reply = () => httpReply({...unconfirmed, applied_state: current}, 500), current = watchReply([]);
  const app = await watchApp(watchReply([]));
  app.setFetch(async (url, options) => {if (options?.method === 'POST') {app.writes.push({url}); return reply();} return httpReply(current);});
  app.run('refreshWatchRules=async()=>{}');
  app.el('watch-add').onclick(); app.type(0, 'prefix', 'a'); app.type(0, 'wake', '100');
  current = inForce;
  await app.run('saveWatches()');
  assert.equal(app.run('watchDirty()'), false, 'the rules in force equal the draft');
  assert.equal(app.el('watch-save').disabled, false, 'Save stays on to retry');
  assert.match(app.el('watch-status').textContent, /^Warning: rules were applied.*Input\/output error\. Select Save again to retry\.$/);
  reply = () => httpReply(inForce);
  await app.run('saveWatches()');
  assert.equal(app.writes.length, 2);
  assert.equal(app.el('watch-status').textContent, 'Saved and applied.');
  assert.equal(app.el('watch-save').disabled, true, 'confirmed: nothing left to save');

  // Reset: the rules in force are the config file ones, so Reset would be off without the retry.
  app.run('confirm=()=>true');
  reply = () => httpReply({...unconfirmed, applied_state: current}, 500); current = watchReply([]);
  app.el('watch-reset').onclick(); await new Promise(resolve => setImmediate(resolve));
  assert.match(app.el('watch-source').textContent, /^From the config file/);
  assert.equal(app.el('watch-reset').disabled, false, 'Reset stays on to retry');
  assert.equal(app.el('watch-save').disabled, true);
  assert.match(app.el('watch-status').textContent, /Select Reset to config file again to retry\.$/);
  reply = () => httpReply(watchReply([]));
  app.el('watch-reset').onclick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.el('watch-status').textContent, 'Reset. The rules from the config file are in force.');
  assert.equal(app.el('watch-reset').disabled, true);
});

test('matching threads now follows the collector while the final view of an exited target is open', async () => {
  const app = await watchApp();
  let threads = [{tid: 1, name: 'worker-1'}];
  app.setFetch(async url => url === '/api/live' ? httpReply({health: {session: 's2'}, threads}) : new Promise(() => {}));
  app.run("frozenChecked=true;frozen={at:1000,exit:{},live:{health:{session:'s1'},threads:[]}}");
  const poll = async () => {await app.run('refresh()'); return app.run('watchRows[0].count.textContent');};
  assert.equal(await poll(), '1');
  threads = [];
  assert.equal(await poll(), '0', 'the target exited');
  threads = [1, 2, 3].map(tid => ({tid, name: 'worker-' + tid}));
  assert.equal(await poll(), '3', 'a replacement target started');
  assert.ok(app.run('frozen!==null'), 'the final view stays open');
});

// A refused stale write must keep the draft until the operator explicitly
// loads the current list. A failed reload must also keep the draft.
test('conflicting saves and resets keep drafts and require an explicit reload', async () => {
  for (const kind of ['save', 'reset']) {
    const original = watchReply([{prefix: 'worker-', wake_ms: 500}], {source: 'dashboard', revision: 'old'});
    const current = watchReply([{prefix: 'other-', wake_ms: 1000}], {source: 'dashboard', revision: 'new'});
    const app = await watchApp(original, () => httpReply({error: 'Another user changed the rules.'}, 409));
    app.type(0, 'wake', '250');
    app.run('confirm=()=>true');
    await app.run(kind === 'save' ? 'saveWatches()' : "changeWatches('/api/watches/reset',{},'Reset.','reset')");
    assert.equal(app.writes[0].options.headers['If-Match'], '"old"');
    assert.equal(app.run('watchDraft[0].wake'), '250');
    assert.equal(app.run('watchInfo.revision'), 'old');
    assert.equal(app.el('watch-save').disabled, true);
    assert.equal(app.el('watch-reset').disabled, true);
    assert.equal(app.el('watch-reload').hidden, false);
    assert.match(app.el('watch-status').textContent, /Another user/);
    app.run('confirm=()=>false');
    await app.run('reloadWatches()');
    assert.equal(app.run('watchDraft[0].wake'), '250', 'Cancel retains the draft');
    app.run('confirm=()=>true');
    app.setFetch(async () => httpReply({}, 503));
    await app.run('reloadWatches()');
    assert.equal(app.run('watchDraft[0].wake'), '250', 'a failed reload retains the draft');
    assert.equal(app.run('watchConflict'), true);
    app.setFetch(async () => httpReply(current));
    await app.run('reloadWatches()');
    assert.equal(app.run('watchDraft[0].prefix'), 'other-');
    assert.equal(app.run('watchInfo.revision'), 'new');
    assert.equal(app.el('watch-reload').hidden, true);
    assert.equal(app.run('watchConflict'), false);
    assert.equal(app.run('watchDirty()'), false);
  }
});

test('an older collector without edit revisions keeps settings read-only', async () => {
  const app = await watchApp(watchReply([], {revision: undefined}));
  assert.equal(app.el('watch-editor').hidden, true);
  assert.match(app.el('watch-readonly').textContent, /Update the collector/);
});

// A persistence retry must use the revision of its own applied change. A
// later read can belong to another editor and must not authorize a retry.
test('persistence retries cannot adopt another editor\'s revision', async () => {
  for (const kind of ['save', 'reset']) {
    const original = watchReply([{prefix: 'worker-', wake_ms: 500}], {source: 'dashboard', revision: 'original'});
    const applied = watchReply(kind === 'save' ? [{prefix: 'worker-', wake_ms: 250}] : [],
      {source: kind === 'save' ? 'dashboard' : 'config', revision: 'applied'});
    const other = watchReply([{prefix: 'other-', wake_ms: 1000}], {source: 'dashboard', revision: 'other'});
    const app = await watchApp(original);
    app.type(0, 'wake', '250');
    app.run('refreshWatchRules=async()=>{}');
    app.setFetch(async (url, options) => options?.method === 'POST'
      ? httpReply({error: 'rules were applied, but persistence could not be confirmed', applied: true, applied_state: applied}, 500)
      : httpReply(other));
    await app.run(`changeWatches('/api/watches${kind === 'reset' ? '/reset' : ''}', {}, 'Done.', '${kind}')`);
    assert.equal(app.run('watchInfo.revision'), 'applied', 'retain the revision of this change');
    assert.equal(app.run('watchDraft[0]?.prefix'), kind === 'save' ? 'worker-' : undefined);
    app.setFetch(async (url, options) => {
      assert.equal(options.headers['If-Match'], '"applied"', 'a retry cannot authorize a later revision');
      return httpReply({error: 'Another user changed the rules.'}, 409);
    });
    await app.run(`changeWatches('/api/watches${kind === 'reset' ? '/reset' : ''}', {}, 'Done.', '${kind}')`);
    assert.equal(app.run('watchConflict'), true);
    assert.equal(app.el('watch-save').disabled, true);
    assert.equal(app.el('watch-reset').disabled, true);
  }
});

test('an applied error without its revision requires an explicit reload', async () => {
  const app = await watchApp();
  app.type(0, 'wake', '250');
  app.run('refreshWatchRules=async()=>{}');
  app.setFetch(async () => httpReply({error: 'Persistence could not be confirmed.', applied: true}, 500));
  await app.run('saveWatches()');
  assert.equal(app.run('watchDraft[0].wake'), '250');
  assert.equal(app.run('watchInfo.revision'), 'test-1');
  assert.equal(app.el('watch-save').disabled, true);
  assert.equal(app.el('watch-reset').disabled, true);
  assert.equal(app.el('watch-reload').hidden, false);
  assert.match(app.el('watch-status').textContent, /Reload current rules before retrying/);
});

test('folded panels open for a warning of their type until the user chooses', () => {
  const app = dashboard();
  app.run(`var folds=[{open:false,dataset:{fold:'health',foldOn:'monitor'}},{open:false,dataset:{fold:'memory',foldOn:'memory'}}];
    document.querySelectorAll=(original=>selector=>selector==='details[data-fold-on]'?folds:original(selector))(document.querySelectorAll);`);
  // Info is not enough; a warning of the panel's type opens it.
  app.run(`openFoldsFor([{type:'monitor',level:'info'},{type:'memory',level:'warning'}])`);
  assert.equal(app.run('JSON.stringify(folds.map(fold=>fold.open))'), '[false,true]');
  // A panel the user closed stays closed.
  app.run(`localStorage.getItem=key=>key==='triangulator:fold:health'?'closed':null;openFoldsFor([{type:'monitor',level:'critical'}])`);
  assert.equal(app.run('folds[0].open'), false);
});

test('folded panels restore a saved choice and save a click', () => {
  const app = dashboard();
  app.run(`setTimeout=callback=>callback();var stored={'triangulator:fold:health':'closed','triangulator:fold:memory':'open'};
    localStorage.getItem=key=>stored[key]??null;localStorage.setItem=(key,value)=>{stored[key]=value};
    var clicks={};
    var folds=['health','memory'].map(name=>({open:name==='health',dataset:{fold:name},querySelector:()=>({addEventListener:(type,handler)=>{clicks[name]=handler}})}));
    document.querySelectorAll=(original=>selector=>selector==='details[data-fold]'?folds:original(selector))(document.querySelectorAll);
    initFolds()`);
  assert.equal(app.run('JSON.stringify(folds.map(fold=>fold.open))'), '[false,true]');
  app.run(`folds[0].open=true;clicks.health()`);
  assert.equal(app.run('stored["triangulator:fold:health"]'), 'open');
});

test('a panel the user chose stays closed when storage is blocked', () => {
  const app = dashboard();
  app.run(`setTimeout=callback=>callback();localStorage.getItem=()=>{throw Error('blocked')};localStorage.setItem=()=>{throw Error('blocked')};
    var click;
    var folds=[{open:false,dataset:{fold:'health',foldOn:'monitor'},querySelector:()=>({addEventListener:(type,handler)=>{click=handler}})}];
    document.querySelectorAll=(original=>selector=>selector.startsWith('details[data-fold')?folds:original(selector))(document.querySelectorAll);
    initFolds();openFoldsFor([{type:'monitor',level:'critical'}])`);
  assert.equal(app.run('folds[0].open'), true);
  app.run('folds[0].open=false;click()');
  app.run(`openFoldsFor([{type:'monitor',level:'critical'}])`);
  assert.equal(app.run('folds[0].open'), false);
});

test('theme selection restores preferences and works when storage is blocked', () => {
  const source = script.slice(script.indexOf("const themes=['auto'"), script.indexOf('let resizeTimer;'));
  const storage = new Map([['triangulator:theme', 'dark']]);
  function start(blocked = false) {
    const root = {dataset: {}}, picker = {value: ''};
    const context = vm.createContext({document: {documentElement: root},
      element: () => picker, live: {}, localStorage: {
        getItem: key => {if (blocked) throw Error('blocked'); return storage.get(key);},
        setItem: (key, value) => {if (blocked) throw Error('blocked'); storage.set(key, value);},
      }});
    vm.runInContext(source, context);
    return {root, picker, select(value) {picker.value = value; picker.onchange();}};
  }
  const app = start();
  assert.equal(app.root.dataset.theme, 'dark');
  assert.equal(app.picker.value, 'dark');
  app.select('light');
  assert.equal(app.root.dataset.theme, 'light');
  assert.equal(start().picker.value, 'light');
  app.select('auto');
  assert.equal(app.root.dataset.theme, undefined, 'System leaves appearance to the media query');
  assert.equal(start().picker.value, 'auto');
  storage.set('triangulator:theme', 'unknown');
  assert.equal(start().picker.value, 'auto');
  const blocked = start(true);
  assert.equal(blocked.picker.value, 'auto');
  blocked.select('dark');
  assert.equal(blocked.root.dataset.theme, 'dark');
  blocked.select('light');
  assert.equal(blocked.root.dataset.theme, 'light');
});

test('target requests select one key and keep the target list global', async () => {
  const app = dashboard();
  const requests = [];
  app.setFetch(async (url, options) => {requests.push({url, options});return {ok: true};});
  app.run("selectedTarget='host-a/orders'");
  await app.run("apiFetch('/api/live')");
  await app.run("apiFetch('/api/history?session=1&tid=2')");
  await app.run("apiFetch('/api/targets')");
  await app.run("apiFetch('/api/watches',{method:'POST'})");
  assert.equal(requests[0].url, '/api/live?target=host-a%2Forders');
  assert.equal(requests[1].url, '/api/history?session=1&tid=2&target=host-a%2Forders');
  assert.equal(requests[2].url, '/api/targets');
  assert.equal(requests[3].options.method, 'POST');
  assert.ok(requests[3].url.includes('target=host-a%2Forders'));
});

test('closing the thread drawer keeps the selected target in the URL', () => {
  const app = dashboard(new Map(), () => undefined, {target: 'omarchy/cpu'});
  app.run("live={health:{session:1},threads:[{tid:7,name:'worker',generation:1}]};openThread(live.threads[0])");
  assert.equal(app.run('location.search + location.hash'), '?target=omarchy%2Fcpu#thread=7');
  app.run('closeThread()');
  assert.equal(app.run('location.search + location.hash'), '?target=omarchy%2Fcpu');
});

test('the target selector shows status, limited access, throttling, and other attention', () => {
  const app = dashboard();
  app.run(`selectedTarget='host-a/orders';renderTargetChoices([
    {key:'host-a/orders',host:'host-a',id:'orders',pid:123,status:'live',access:'limited',throttled:true,effective_rate_hz:2,sampler_cpu_pct:.9,cpu_budget_pct:1},
    {key:'host-b/billing',host:'host-b',id:'billing',pid:456,status:'absent',access:'full',throttled:false}])`);
  assert.equal(app.elements.get('target-select').hidden, false);
  assert.equal(app.elements.get('target-access').hidden, false);
  assert.equal(app.elements.get('target-budget').hidden, false);
  assert.match(app.elements.get('target-budget-value').textContent, /2.00 Hz/);
  assert.match(app.elements.get('target-attention').dataset.label, /1 other target/);
  app.run(`renderTargetChoices([{key:'host-a/orders',host:'host-a',id:'orders',pid:123,status:'live',access:'full',throttled:false}])`);
  assert.equal(app.elements.get('target-select').hidden, true);
  assert.equal(app.elements.get('target-key').dataset.label, 'host-a · orders');
});

test('the selector stays visible while the selected target is unavailable', () => {
  const app = dashboard();
  const one = `[{key:'host-a/orders',host:'host-a',id:'orders',pid:123,status:'live',access:'full',throttled:false}]`;
  app.run(`selectedTarget='host-a/billing'`);
  // Two refreshes with the same list: the second must not hide the control.
  app.run(`renderTargetChoices(${one})`);
  assert.equal(app.elements.get('target-select').hidden, false);
  app.run(`renderTargetChoices(${one})`);
  assert.equal(app.elements.get('target-select').hidden, false);
  assert.equal(app.elements.get('target-key').hidden, true);
  app.run(`selectedTarget='host-a/orders';renderTargetChoices(${one})`);
  assert.equal(app.elements.get('target-select').hidden, true);
});

test('target management checks an add, then requires confirmation before one global write', async () => {
  const app = dashboard(new Map(), () => undefined, {target: null});
  const bodies = [];
  app.setFetch(async (url, options) => {bodies.push(JSON.parse(options.body));return {ok: true,json:async()=>({targets:[],message:'Reload requested.'})};});
  app.run(`managedTargets=[{id:'default',target:'123'}];var questions=0;confirm=()=>{questions++;return false};`);
  await app.run("changeManagedTarget({action:'add',id:'orders',target:'456'})");
  assert.deepEqual(bodies, [{action: 'add', id: 'orders', target: '456', check: true}]);
  assert.equal(app.run('questions'), 1);
  app.run("confirm=()=>true;refreshFleet=async()=>{};element('target-settings').showModal()");
  bodies.length = 0;
  await app.run("changeManagedTarget({action:'add',id:'orders',target:'456'})");
  assert.deepEqual(bodies, [{action: 'add', id: 'orders', target: '456', check: true},
                            {action: 'add', id: 'orders', target: '456'}]);
  assert.equal(app.elements.get('target-settings').open, false, 'a completed add closes the dialog');
  assert.equal(app.elements.get('fleet-status').textContent, 'Reload requested.');
  // A removal is not checked first.
  bodies.length = 0;
  await app.run("changeManagedTarget({action:'remove',id:'orders',target:'456'})");
  assert.deepEqual(bodies, [{action: 'remove', id: 'orders', target: '456'}]);
});

test('an add that fails its check is rejected before the confirmation', async () => {
  const app = dashboard(new Map(), () => undefined, {target: null});
  let writes = 0;
  app.setFetch(async () => {writes++;return {ok: false,json:async()=>({error:'no running process with PID 999999'})};});
  app.run(`managedTargets=[{id:'default',target:'123'}];var questions=0;confirm=()=>{questions++;return true};`);
  await app.run("changeManagedTarget({action:'add',id:'ghost',target:'999999'})");
  assert.equal(writes, 1);
  assert.equal(app.run('questions'), 0);
  assert.equal(app.elements.get('target-status').textContent, 'no running process with PID 999999');
  assert.equal(app.elements.get('target-status').className, 'bad');
  assert.equal(app.elements.get('target-save').disabled, false);
});


test('switching targets clears destination view caches and keeps other tabs independent', async () => {
  const storage=new Map([
    ['triangulator:buffer:host-a/orders','old'],
    ['triangulator:threads:host-b/billing','old'],
    ['triangulator:frozen:host-b/billing','old'],
    ['triangulator:buffer:host-c/gateway','keep']]);
  const first=dashboard(storage,()=>undefined,{target:'host-a/orders'});
  const second=dashboard(new Map(),()=>undefined,{target:'host-c/gateway'});
  first.run("selectTarget('host-b/billing')");
  assert.deepEqual(first.navigation,['/?target=host-b%2Fbilling']);
  assert.equal(storage.has('triangulator:threads:host-b/billing'),false);
  assert.equal(storage.has('triangulator:frozen:host-b/billing'),false);
  assert.equal(storage.get('triangulator:buffer:host-c/gateway'),'keep');
  assert.equal(second.run('selectedTarget'),'host-c/gateway');
});

// The page without ?target= is the overview: one tile per target, worst first,
// each judged by the Assessment rules on that target's latest live view.
function fleetView(pid, name, cpu) {
  const now = Date.now() / 1000;
  return {health: {session: String(pid), pid, last_seen: now, sampler_silent: false, target_absent: false},
    threads: [{tid: pid, generation: 1, name, last_sample: now, cpu_pct: cpu, run_delay_pct: 0, state: cpu >= 90 ? 'running' : 'sleep'}]};
}
const fleetTargets = [
  {key: 'h/api', host: 'h', id: 'api', pid: 10, status: 'live', access: 'full', throttled: false},
  {key: 'h/busy', host: 'h', id: 'busy', pid: 20, status: 'live', access: 'limited', throttled: true},
  {key: 'h/gone', host: 'h', id: 'gone', pid: 30, status: 'silent', access: 'full', throttled: false}];
const noControl = Promise.resolve({ok: false});
function fleetRespond(url) {
  if (url === '/api/targets/control') return noControl;
  if (url === '/api/targets') return jsonResponse({targets: fleetTargets});
  if (url === '/api/live?target=h%2Fapi') return jsonResponse(fleetView(10, 'api', 5));
  if (url === '/api/live?target=h%2Fbusy') return jsonResponse(fleetView(20, 'busy', 99));
  if (url === '/api/live?target=h%2Fgone') return Promise.resolve({ok: false, json: async () => ({})});
  return undefined;
}
const tileText = tile => JSON.stringify(tile, (key, value) => key === 'parent' ? undefined : value);

test('overview page shows one tile per target, worst first, and links to each dashboard', async () => {
  const app = dashboard(new Map(), fleetRespond, {target: null});
  assert.equal(app.run('document.documentElement.dataset.page'), 'fleet');
  await app.run('refreshFleet()');
  assert.ok(!app.requests.some(url => /^\/api\/(live|replay|resources|socket-io|watches)$|^\/api\/(replay|resources)\?/.test(url)), 'the overview starts no dashboard loop');
  const tiles = app.elements.get('fleet-grid').children.slice(0, -1);
  assert.equal(app.elements.get('fleet-grid').children.at(-1), app.elements.get('fleet-add'));
  const link = tile => tile.children[0].children[1];
  assert.deepEqual(tiles.map(tile => link(tile).href), ['?target=h%2Fbusy', '?target=h%2Fapi', '?target=h%2Fgone']);
  assert.deepEqual(tiles.map(tile => tile.dataset.level), ['serious', 'good', 'unknown']);
  assert.match(tileText(tiles[0]), /busy is saturating a core/);
  assert.match(tileText(tiles[1]), /Healthy/);
  assert.doesNotMatch(tileText(tiles[1]), /No problems detected/);
  assert.equal(tiles[2].children[0].children[0].attrs['aria-label'], 'Assessment: No data');
  assert.equal(app.run('document.title'), '(1) Targets · Thread monitor');
  assert.equal(app.elements.get('fleet-empty').hidden, true);
  // A later poll keeps the same tile elements, so focus and hover survive.
  const first = tiles[0];
  await app.run('refreshFleet()');
  assert.equal(app.elements.get('fleet-grid').children[0], first);
});

test('overview page polls nothing while the tab is hidden and reports a lost collector', async () => {
  const app = dashboard(new Map(), fleetRespond, {target: null});
  app.run('document.hidden=true');
  const before = app.requests.length;
  await app.run('refreshFleet()');
  assert.equal(app.requests.length, before);
  app.run('document.hidden=false');
  app.setFetch(async () => {throw Error('down');});
  await app.run('refreshFleet()');
  assert.match(app.elements.get('error').textContent, /Collector unavailable/);
});

test('overview page starts no new live request once the tab is hidden mid-batch', async () => {
  const many = Array.from({length: 8}, (_, i) => ({key: 'h/t' + i, host: 'h', id: 't' + i, pid: 100 + i, status: 'live', access: 'full', throttled: false}));
  let app, started = 0;
  app = dashboard(new Map(), url => {
    if (url === '/api/targets/control') return noControl;
    if (url === '/api/targets') return jsonResponse({targets: many});
    if (url.startsWith('/api/live?')) {if (++started === 4) app.run('document.hidden=true'); return jsonResponse(fleetView(1, 'x', 1));}
    return undefined;
  }, {target: null});
  const before = app.requests.length;
  await app.run('refreshFleet()');
  const live = app.requests.slice(before).filter(url => url.startsWith('/api/live?'));
  assert.equal(live.length, 4, 'only the first batch is in flight');
});

test('overview tile faces show only identity and an accessible assessment dot', async () => {
  const app = dashboard(new Map(), url => {
    if (url === '/api/live?target=h%2Fapi') return jsonResponse({...fleetView(10, 'api', 5),
      resources: {available: true, stale: false, session: '10', pid: 10, memory: {rss: 5 * 1048576}}});
    return fleetRespond(url);
  }, {target: null});
  await app.run('refreshFleet()');
  const visibleText = item => typeof item === 'string' ? [item] : item.className === 'ft-card' ? []
    : [item.textContent, ...item.children.flatMap(visibleText)].filter(Boolean);
  const [busy, healthy, missing] = app.elements.get('fleet-grid').children;
  assert.deepEqual(visibleText(healthy), ['api', 'h · api']);
  assert.deepEqual(visibleText(busy), ['busy', 'h · busy']);
  assert.deepEqual(visibleText(missing), ['gone', 'h · gone']);
  for (const [tile, level, label] of [[busy, 'serious', 'Something is struggling'],
    [healthy, 'good', 'Healthy'], [missing, 'unknown', 'No data']]) {
    const [dot, link] = tile.children[0].children;
    assert.equal(tile.dataset.level, level);
    assert.equal(dot.attrs.role, 'img');
    assert.equal(dot.attrs['aria-label'], 'Assessment: ' + label);
    assert.equal(dot.title, label);
    assert.match(link.attrs['aria-label'], new RegExp(label, 'i'));
    assert.equal(dot.className, 'status-dot ft-assessment', 'the dot uses assessment color, without a live-status color');
  }
});

test('a target dashboard does not start the overview', () => {
  const app = dashboard(new Map(), () => undefined, {target: 'h/api'});
  assert.equal(app.run('document.documentElement.dataset.page'), 'target');
  assert.ok(app.requests.includes('/api/live?target=h%2Fapi'));
  assert.equal(app.run('fleetTiles.size'), 0);
});

test('overview tiles offer Remove only for targets of the local sampler', async () => {
  const app = dashboard(new Map(), fleetRespond, {target: null});
  app.run("managedTargets=[{id:'api',target:'api'},{id:'busy',target:'busy'}];controlHost='h'");
  await app.run('refreshFleet()');
  const tiles = app.elements.get('fleet-grid').children.slice(0, -1);
  const remove = tile => tile.children.find(child => child.className === 'ft-foot').children.find(child => child.className === 'ft-remove');
  assert.deepEqual(tiles.map(tile => !!remove(tile)), [true, true, false]);
  const bodies = [];
  app.run('confirm=()=>true;refreshFleet=async()=>{}');
  app.setFetch(async (url, options) => {bodies.push(JSON.parse(options.body)); return {ok: true, json: async () => ({targets: [], message: 'Reload requested.'})};});
  await remove(tiles[1]).onclick();
  assert.deepEqual(bodies, [{action: 'remove', id: 'api', target: 'api'}]);
  assert.equal(app.elements.get('fleet-status').textContent, 'Reload requested.');
  // A tile of another host has no Remove, even with the same target ID.
  app.run("controlHost='other'");
  app.run(`renderFleet(${JSON.stringify(fleetTargets)}, new Map())`);
  assert.ok(app.elements.get('fleet-grid').children.slice(0, -1).every(tile => !remove(tile)));
});

test('overview polls refresh Remove controls and stay quiet about control errors', async () => {
  const control = {enabled: true, host: 'h', targets: [{id: 'api', target: 'api'}, {id: 'busy', target: 'busy'}]};
  const app = dashboard(new Map(), url => url === '/api/targets/control' ? jsonResponse(control) : fleetRespond(url), {target: null});
  await app.run('refreshFleet()');
  const remove = tile => tile.children.find(child => child.className === 'ft-foot').children.find(child => child.className === 'ft-remove');
  const tiles = () => app.elements.get('fleet-grid').children.slice(0, -1);
  assert.deepEqual(tiles().map(tile => !!remove(tile)), [true, true, false]);
  // A target added from another tab becomes removable on the next poll.
  control.targets.push({id: 'extra', target: 'extra'});
  app.run("targetStatus('half-typed form message')");
  await app.run('refreshFleet()');
  assert.equal(app.elements.get('target-status').textContent, 'half-typed form message');
  // A remote dashboard or a stopped sampler shows no error until the user acts.
  Object.assign(control, {enabled: false, error: 'target control is available for a local sampler on a loopback dashboard'});
  app.run("targetStatus('')");
  await app.run('refreshFleet()');
  assert.equal(app.elements.get('fleet-status').textContent, '');
  assert.equal(app.elements.get('fleet-add').hidden, true);
});

test('Add target dialog holds the help surfaces so they stay usable', async () => {
  const app = dashboard(new Map(), url => url === '/api/targets/control' ? jsonResponse({enabled: true}) : fleetRespond(url), {target: null});
  await app.run('openTargetDialog()');
  const dialog = app.elements.get('target-settings');
  for (const id of ['help-guide', 'tip', 'help-scrim']) assert.equal(app.elements.get(id).parent, dialog, id);
});

test('narrow-viewport help guide inside the Add target dialog is not made inert', async () => {
  const app = dashboard(new Map(), url => url === '/api/targets/control' ? jsonResponse({enabled: true}) : fleetRespond(url), {target: null});
  await app.run('openTargetDialog()');
  app.run(`innerWidth=1000;innerHeight=800;helpContext={};
    var fleetMain=element('fleet'),otherMain={contains:()=>false,inert:false};fleetMain.inert=false;fleetMain.children=[element('target-settings')];
    document.querySelectorAll=()=>[fleetMain,otherMain];syncHelpLayout()`);
  assert.equal(app.run('fleetMain.inert'), false);
  assert.equal(app.run('otherMain.inert'), true);
});

test('an ambiguous process name lists the matching processes and a choice fills in the PID', async () => {
  const app = dashboard(new Map(), () => undefined, {target: null});
  const candidates = [{pid: 4100, user: 'app', started_at: Date.now() / 1000 - 7200, command: 'worker --queue orders'},
    {pid: 4377, user: 'app', started_at: null, command: 'worker --queue billing'}];
  app.setFetch(async () => ({ok: false, json: async () => ({error: 'multiple processes named worker; pass a PID from: [4100, 4377]', candidates})}));
  app.run("managedTargets=[{id:'default',target:'1'}];confirm=()=>true");
  await app.run("changeManagedTarget({action:'add',id:'orders',target:'worker'})");
  assert.equal(app.elements.get('target-candidates').hidden, false);
  const options = app.elements.get('target-pid').children;
  assert.deepEqual(options.map(option => option.value), ['', '4100', '4377']);
  assert.equal(options[1].textContent, 'PID 4100 · app · started 2 h ago · worker --queue orders');
  assert.equal(options[2].textContent, 'PID 4377 · app · worker --queue billing');
  assert.match(app.elements.get('target-status').textContent, /2 processes are named worker/);
  app.elements.get('target-pid').value = '4377';
  app.run("element('target-pid').onchange()");
  assert.equal(app.elements.get('target-input').value, '4377');
  assert.match(app.elements.get('target-status').textContent, /does not follow a restart/);
  // Another error, or a new dialog, hides the list.
  app.setFetch(async () => ({ok: false, json: async () => ({error: 'no running process with PID 4377'})}));
  await app.run("changeManagedTarget({action:'add',id:'orders',target:'4377'})");
  assert.equal(app.elements.get('target-candidates').hidden, true);
});

test('the ambiguous-name status counts every match and a local validation error hides the list', async () => {
  const app = dashboard(new Map(), () => undefined, {target: null});
  const candidates = Array.from({length: 20}, (_, i) => ({pid: 5000 + i, user: 'app', started_at: null, command: 'worker'}));
  app.setFetch(async () => ({ok: false, json: async () => ({error: 'multiple processes named worker', candidates, total: 25})}));
  app.run("managedTargets=[{id:'default',target:'1'}];confirm=()=>true");
  await app.run("changeManagedTarget({action:'add',id:'orders',target:'worker'})");
  assert.equal(app.elements.get('target-pid').children.length, 21);
  assert.match(app.elements.get('target-status').textContent, /25 processes are named worker; the first 20 are listed/);
  app.run("element('target-id').value='.';element('target-input').value='other'");
  await app.run('addManagedTarget()');
  assert.equal(app.elements.get('target-candidates').hidden, true);
});

test('a tile with findings carries a card with the worst findings and the process start', async () => {
  const app = dashboard(new Map(), url => {
    if (url === '/api/live?target=h%2Fbusy') {
      const view = fleetView(20, 'busy', 99);
      view.process = {session: '20', started_at: Date.now() / 1000 - 7200, command: '/usr/bin/busy --spin'};
      return jsonResponse(view);
    }
    return fleetRespond(url);
  }, {target: null});
  await app.run('refreshFleet()');
  const [busy, api] = app.elements.get('fleet-grid').children;
  const card = tile => tile.children.find(child => child.className === 'ft-card');
  assert.equal(card(api), undefined, 'a healthy tile has no card');
  assert.match(tileText(card(busy)), /PID 20 · Started 2 h ago · \/usr\/bin\/busy --spin/);
  assert.match(tileText(card(busy)), /busy is saturating a core/);
  assert.match(tileText(card(busy)), /uses 99/);
  assert.equal(card(busy).children[1].children[0].className, 'lvl-serious');
});

test('a poll keeps the tile link element, so keyboard focus survives', async () => {
  const app = dashboard(new Map(), fleetRespond, {target: null});
  await app.run('refreshFleet()');
  const tile = app.elements.get('fleet-grid').children[0];
  const link = tile.children[0].children[1];
  await app.run('refreshFleet()');
  assert.equal(tile.children[0].children[1], link);
  assert.equal(link.href, '?target=h%2Fbusy');
  assert.equal(tile.children.filter(child => child.className === 'ft-key').length, 1);
});

test('a tile that holds keyboard focus is not refilled until focus leaves it', async () => {
  let cpu = 99;
  const app = dashboard(new Map(), url => url === '/api/live?target=h%2Fbusy' ? jsonResponse(fleetView(20, 'busy', cpu)) : fleetRespond(url), {target: null});
  await app.run('refreshFleet()');
  const tile = app.elements.get('fleet-grid').children.find(item => item.dataset.level === 'critical' || item.dataset.level === 'serious' || item.dataset.level === 'warning');
  const key = tile.children.find(child => child.className === 'ft-key');
  const link = tile.children[0].children[1];
  app.run('document.activeElement = null');
  cpu = 5;
  app.run('document.activeElement = fleetTiles.get("h/busy").children[0].children[1]');
  await app.run('refreshFleet()');
  assert.ok(tile.children.includes(key), 'the focused tile keeps its elements');
  assert.equal(tile.children[0].children[1], link);
  app.run('document.activeElement = null');
  await app.run('refreshFleet()');
  assert.ok(!tile.children.includes(key), 'the tile refills after focus leaves');
});

test('a tile with only informational findings has no card', async () => {
  const info = fleetView(10, 'api', 5);
  info.threads.push({tid: 11, generation: 1, name: 'side', last_sample: info.threads[0].last_sample, cpu_pct: 1, run_delay_pct: 0, state: 'sleep'});
  const app = dashboard(new Map(), url => url === '/api/live?target=h%2Fapi' ? jsonResponse(info) : fleetRespond(url), {target: null});
  await app.run('refreshFleet()');
  const api = app.elements.get('fleet-grid').children.find(tile => tile.dataset.level === 'good');
  assert.match(tileText(api), /Healthy/);
  assert.doesNotMatch(tileText(api), /No problems detected/);
  assert.equal(api.children.find(child => child.className === 'ft-card'), undefined);
});

// Browser storage that survives a reload, or that throws as blocked storage does.
function localStore() {
  const saved = new Map();
  return {getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, String(value))};
}
const blockedStore = {getItem() {throw Error('blocked');}, setItem() {throw Error('blocked');}};
function chooseDensity(app, density) {
  app.elements.get('fleet-density').value = density;
  app.elements.get('fleet-density').onchange();
}
const density = app => [app.elements.get('fleet-density').value, app.elements.get('fleet-grid').dataset.density];

test('tile density starts Comfortable, survives reload, and ignores target count and polls', async () => {
  const local = localStore();
  let targets = fleetTargets;
  const respond = url => url === '/api/targets' ? jsonResponse({targets}) : url.startsWith('/api/live?') ? jsonResponse(fleetView(1, 'x', 1)) : fleetRespond(url);
  const app = dashboard(new Map(), respond, {target: null, local});
  assert.deepEqual(density(app), ['comfortable', 'comfortable']);
  await app.run('refreshFleet()');
  chooseDensity(app, 'compact');
  assert.deepEqual(density(app), ['compact', 'compact']);
  targets = Array.from({length: 64}, (_, i) => ({key: 'h/t' + i, host: 'h', id: 't' + i, pid: 100 + i, status: 'live'}));
  await app.run('refreshFleet()');
  targets = fleetTargets.slice(0, 1);
  await app.run('refreshFleet()');
  assert.deepEqual(density(app), ['compact', 'compact']);
  assert.deepEqual(density(dashboard(new Map(), respond, {target: null, local})), ['compact', 'compact']);
  chooseDensity(app, 'comfortable');
  assert.deepEqual(density(dashboard(new Map(), respond, {target: null, local})), ['comfortable', 'comfortable']);
});

test('blocked storage keeps the density choice only until reload', () => {
  const app = dashboard(new Map(), fleetRespond, {target: null, local: blockedStore});
  assert.deepEqual(density(app), ['comfortable', 'comfortable']);
  chooseDensity(app, 'compact');
  assert.deepEqual(density(app), ['compact', 'compact']);
  assert.deepEqual(density(dashboard(new Map(), fleetRespond, {target: null, local: blockedStore})), ['comfortable', 'comfortable']);
});
