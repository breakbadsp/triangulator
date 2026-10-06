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
function dashboard(storage = new Map()) {
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
  const requests = [];
  const context = vm.createContext({
    document: {getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    }, createElement: element, documentElement: {dataset: {}},
    querySelectorAll(selector) {return selector === '[data-range]' ? ranges : [];},
    addEventListener() {}},
    sessionStorage: {getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    localStorage: {getItem() {return null;}, setItem() {}},
    history: {replaceState() {}}, location: {hash: '', pathname: '/'},
    addEventListener() {}, setTimeout() {}, clearTimeout() {}, URLSearchParams,
    fetch(url) {
      requests.push(url);
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
  return {run: source => vm.runInContext(source, context), elements, ranges, requests, storage,
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
