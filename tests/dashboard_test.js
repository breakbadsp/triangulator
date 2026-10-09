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
function dashboard(storage = new Map(), respond = () => undefined, {resourceFetch} = {}) {
  const elements = new Map();
  function element() {
    return {value: '', dataset: {}, textContent: '', attrs: {}, children: [],
      get firstChild() {return this.children[0];}, parentElement: {},
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
  let timerId = 0, timerNow = 0;
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
    realRenderTiles=renderTiles; realRenderAssessment=renderAssessment;
    timeChart=()=>{}; renderAssessment=()=>{}; renderTiles=()=>{};
    renderCores=()=>{}; renderMosaic=()=>{}; renderFamilies=()=>{};
    renderWchans=()=>{}; renderThreads=()=>{}; renderDrawerLive=()=>{};
  `, context);
  return {run: source => vm.runInContext(source, context), elements, ranges, resourceRanges, timers, requests, storage,
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
  assert.match(app.elements.get('replay-note').textContent, /No process snapshot/);
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
  app.run(`live.health.session='b';recordMemory(${summary(2)},[],true)`);
  assert.equal(app.run('memoryHistory.length'), 1);
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
  assert.match(resident[2], /^▲ 1[12][0-9](\.[0-9])? MB \/ min$/);
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
