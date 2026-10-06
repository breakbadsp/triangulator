'use strict';
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {test} = require('node:test');
const vm = require('node:vm');
const html = readFileSync(new URL('../collector/dashboard.html', `file://${__filename}`), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Execute the shipped dashboard script, with network polling paused and a
// small DOM substitute. Keep ingestion, storage, overview and drawer controls
// real; unrelated visual panels are suppressed below.
function dashboard(storage = new Map(), {resourceFetch} = {}) {
  const elements = new Map();
  function element() {
    return {value: '', dataset: {}, textContent: '', attrs: {}, children: [],
      style: {setProperty() {}}, classList: {add() {}, remove() {}},
      setAttribute(key, value) {this.attrs[key] = value;},
      append(...items) {this.children.push(...items);},
      replaceChildren(...items) {this.children = items;},
      matches() {return false;}, focus() {}, addEventListener() {}};
  }
  const ranges = [900, 3600, 21600, 86400].map(seconds => {
    const button = element(); button.dataset.range = String(seconds); return button;
  });
  const resourceRanges = [900, 3600, 21600, 86400].map(seconds => {
    const button = element(); button.dataset.resRange = String(seconds); return button;
  });
  const timers = new Map();
  let timerId = 0;
  const requests = [];
  const context = vm.createContext({
    document: {getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    }, createElement: element, createElementNS: element, documentElement: {dataset: {}},
    querySelectorAll(selector) {return selector === '[data-range]' ? ranges : selector === '[data-res-range]' ? resourceRanges : [];},
    addEventListener() {}},
    sessionStorage: {getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    localStorage: {getItem() {return null;}, setItem() {}},
    history: {replaceState() {}}, location: {hash: '', pathname: '/'},
    addEventListener() {},
    setTimeout(callback, delay) {const id = ++timerId; timers.set(id, {callback, delay}); return id;},
    clearTimeout(id) {timers.delete(id);}, URLSearchParams,
    fetch(url) {
      requests.push(url);
      if (resourceFetch && url.startsWith('/api/resources?')) return resourceFetch(url);
      return url.startsWith('/api/history?')
        ? Promise.resolve({ok: true, json: async () => ({rows: []})})
        : new Promise(() => {});
    },
  });
  vm.runInContext(script, context);
  vm.runInContext(`
    timeChart=()=>{}; renderAssessment=()=>{}; renderTiles=()=>{};
    renderCores=()=>{}; renderMosaic=()=>{}; renderFamilies=()=>{};
    renderWchans=()=>{}; renderThreads=()=>{}; renderDrawerLive=()=>{};
  `, context);
  return {run: source => vm.runInContext(source, context), elements, ranges, resourceRanges, timers, requests, storage,
    setFetch: callback => {context.fetch = callback;}};
}

test('target editor loads the selector and sends one validated dashboard write', async () => {
  const app = dashboard();
  app.setFetch(async () => ({ok: true, json: async () => ({enabled: true, target: 'worker'})}));
  app.run("element('target-settings').hidden=true");
  await app.run('toggleTarget()');
  assert.equal(app.elements.get('target-toggle').hidden, false);
  assert.equal(app.elements.get('target-toggle').attrs['aria-expanded'], 'true');
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
  const app = dashboard();
  app.setFetch(async () => ({ok: true, json: async () => ({enabled: false})}));
  await app.run('loadTarget()');
  assert.equal(app.elements.get('target-toggle').hidden, true);
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

test('hidden or unreachable sockets are explained, not reported as zero', () => {
  const app = dashboard();
  const hidden = findingsOf(app, resources({flags: {descriptors_hidden: true}}));
  assert.equal(hidden.at(-1).title, 'Socket details hidden');
  const other = findingsOf(app, resources({flags: {other_network_namespace: true}}));
  assert.equal(other.at(-1).title, 'Socket queues unavailable');
  const stale = findingsOf(app, resources({stale: true, updated: Date.now() / 1000 - 120}));
  assert.equal(stale[0].title, 'Resource samples are stale');
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
  const app = dashboard(new Map(), {resourceFetch: async () => response});
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
