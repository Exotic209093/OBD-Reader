const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scan } = require('../src/scan');
const { ReplayElm, simulatePids } = require('../src/replay');
const { buildAdvice } = require('../src/advice');
const { History, compareReports } = require('../src/history');
const { parsePids, LiveSession } = require('../src/live');
const { reportText } = require('../src/reportText');

const scanned = () => scan(new ReplayElm());

test('advice: misfire on cylinder 1, low battery, ABS unknowns', async () => {
  const r = await scanned();
  const a = buildAdvice(r);
  assert.strictEqual(a.overall, 'caution');
  const titles = a.items.map((i) => i.title);
  assert.ok(titles.includes('Cylinder 1 is misfiring'));
  assert.ok(titles.includes('Battery voltage low'));
  assert.ok(titles.includes('Cylinder 1 misfire'));
  assert.ok(titles.some((t) => t.startsWith('Unknown fault 00625')));
  // The active coolant sensor fault sorts first among cautions.
  assert.strictEqual(a.items[0].title, 'Coolant temperature sensor signal intermittent');
  assert.strictEqual(a.items[0].active, true);
  // Unknown codes come last.
  assert.strictEqual(a.items.at(-1).severity, 'info');
});

test('advice: clean car is ok', () => {
  const r = {
    voltage: 12.6,
    engine: { monitor: { mil: false }, rpm: 0, stored: [], pending: [], permanent: [], misfires: [{ cylinder: 1, recent: 0 }], memory: { faults: [] } },
    modules: [],
  };
  assert.deepStrictEqual(buildAdvice(r).overall, 'ok');
});

test('history: save, list, compare after a repair', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obd-hist-'));
  const h = new History(dir);
  const before = await scanned();
  before.finishedAt = '2026-10-26T08:00:00.000Z';
  h.save(before);

  const after = structuredClone(before);
  after.finishedAt = '2026-10-30T08:00:00.000Z';
  after.engine.memory.faults = after.engine.memory.faults.filter((f) => f.number === '16503');
  after.engine.misfires[0].recent = 2;
  const c = compareReports(h.latest(after.vin), after);
  assert.deepStrictEqual(c.added, []);
  assert.strictEqual(c.gone.length, 2);
  assert.ok(c.still.some((f) => f.label.startsWith('16503')));
  assert.deepStrictEqual(c.misfires[0], { cylinder: 1, before: 55, now: 2 });

  h.save(after);
  const list = h.list();
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].at, after.finishedAt);
  assert.throws(() => h.load('../evil'), /Bad history id/);
  fs.rmSync(dir, { recursive: true });
});

test('live: multi-PID reply parsing', () => {
  const v = parsePids(simulatePids([0x0c, 0x0d, 0x0b, 0x11, 0x04, 0x0f], 0));
  assert.deepStrictEqual(Object.keys(v).sort(), ['iat', 'load', 'map', 'rpm', 'speed', 'throttle']);
  assert.strictEqual(v.iat, 22);
  assert.strictEqual(parsePids('7E8 04 41 0C 1A F8').rpm, 1726);
  assert.strictEqual(parsePids('7E8 04 41 42 36 6A').voltage, 13.93);
});

test('live: session produces samples with boost and misfires', async () => {
  const samples = [];
  const live = new LiveSession(new ReplayElm(), (s) => {
    samples.push(s);
    if (samples.length === 3) live.stop();
  });
  await live.start();
  assert.strictEqual(samples.length, 3);
  assert.ok(samples[0].values.rpm > 0);
  assert.ok(typeof samples[0].values.boost === 'number');
  assert.strictEqual(samples[0].values.voltage, 13.93);
  assert.deepStrictEqual(samples[0].misfires.map((m) => m.recent), [55, 1, 2, 1]);
});

test('text report', async () => {
  const r = await scanned();
  r.finishedAt = '2026-10-26T08:00:00.000Z';
  r.advice = buildAdvice(r);
  const t = reportText(r);
  assert.match(t, /VERDICT: Safe to drive gently/);
  assert.match(t, /15125: Cylinder 1 misfire \(P0301\)/);
  assert.match(t, /16503: Coolant temperature sensor signal intermittent \(P0119\)/);
  assert.match(t, /cyl1=55/);
  assert.match(t, /03 ABS \/ ESC: 2 fault\(s\)/);
  assert.match(t, /No codes were cleared/);
});

test('history remembers found modules and skips modules that never answer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obd-mem-'));
  const h = new History(dir);
  const vin = 'WAUZZZ8X4GB012345';
  assert.deepStrictEqual(h.carMemory(vin), { found: null, silent: [] }, 'new car: search on first scan');

  const mod = (tx, extra = {}) => ({ name: tx, tx, rx: tx, responded: true, faults: [], ...extra });
  for (let i = 0; i < 3; i++) {
    h.save({
      vin,
      finishedAt: `2026-10-3${i}T10:00:00.000Z`,
      ...(i === 0 ? { search: { found: 1 } } : {}),
      engine: { misfires: [], memory: { name: 'E', faults: [] } },
      modules: [mod('713'), mod('710', { responded: false }), mod('70F', { found: true })],
    });
  }
  h.addRepair(vin, 'new coils and plugs', '2026-10-30T12:00:00.000Z');
  const m = h.carMemory(vin);
  assert.deepStrictEqual(m.found, [{ name: '70F', tx: '70F', rx: '70F' }]);
  assert.deepStrictEqual(m.silent, ['710']);
  assert.strictEqual(h.list().length, 3, 'repairs file is not a scan');
  assert.deepStrictEqual(h.repairs(vin).map((r) => r.note), ['new coils and plugs']);
  fs.rmSync(dir, { recursive: true });
});

test('remembered modules are read without searching; silent ones skipped', async () => {
  const elm = new ReplayElm();
  const sent = [];
  const send = elm.send.bind(elm);
  elm.send = (cmd, t) => (sent.push(cmd), send(cmd, t));
  const memory = () => ({ found: [{ name: 'Haldex4Motion (70F)', tx: '70F', rx: '779' }], silent: ['710'] });
  const r = await scan(elm, () => {}, { memory });
  assert.ok(!sent.includes('1901FF'), 'no address search');
  assert.deepStrictEqual(r.search, { found: 1, remembered: true });
  assert.ok(r.modules.find((x) => x.name === 'Haldex4Motion (70F)').found);
  assert.strictEqual(r.modules.find((x) => x.tx === '710').skipped, true);

  // A forced search ignores the memory and asks every address again.
  const again = await scan(new ReplayElm(), () => {}, { memory, search: true });
  assert.strictEqual(again.modules.find((x) => x.tx === '710').skipped, undefined);
  assert.ok(!again.search.remembered);
});

test('scan records step timings and skips repeated adapter settings', async () => {
  const elm = new ReplayElm();
  const sent = [];
  const send = elm.send.bind(elm);
  elm.send = (cmd, t) => (sent.push(cmd), send(cmd, t));
  const r = await scan(elm);
  assert.ok(r.timings.some((t) => t.step === 'Reading misfire counters' && t.ms >= 0));
  assert.ok(r.transcript.every((row) => typeof row[3] === 'number'));
  // Same flow-control settings for every module: sent once, not per module.
  assert.strictEqual(sent.filter((c) => c === 'ATFCSD300000').length, 1);
  assert.ok(!sent.includes('ATSP0'), 'CAN car connects without the slow protocol search');
});

const misfireScan = (recent, current) => ({
  voltage: 12.6,
  engine: {
    monitor: { mil: false },
    rpm: 0,
    stored: [],
    pending: [],
    permanent: [],
    misfires: recent.map((n, i) => ({ cylinder: i + 1, recent: n, current: current[i] })),
    memory: { name: '01 Engine', faults: [] },
  },
  modules: [],
});

test('advice: misfire average after a repair', () => {
  const repairs = [{ at: '2026-10-30T17:00:00.000Z', note: 'new coils and plugs' }];
  const previous = [{ at: '2026-10-30T17:52:42.000Z', misfires: [{ cylinder: 2, recent: 46 }] }];
  const clean = buildAdvice(misfireScan([1, 34, 1, 1], [0, 2, 0, 0]), { repairs, previous });
  const item = clean.items.find((i) => i.kind === 'misfire');
  assert.strictEqual(item.severity, 'info');
  assert.match(item.title, /Cylinder 2 misfires going away/);
  assert.match(item.what, /46 → 34/);
  assert.strictEqual(clean.overall, 'info');

  const still = buildAdvice(misfireScan([1, 34, 1, 1], [0, 12, 0, 0]), { repairs, previous });
  assert.match(still.items[0].title, /still misfiring after the repair/);
  assert.strictEqual(still.overall, 'caution');

  const noRepair = buildAdvice(misfireScan([1, 34, 1, 1], [0, 2, 0, 0]), {});
  assert.strictEqual(noRepair.items[0].title, 'Cylinder 2 is misfiring');
});

test('advice: unfinished readiness monitors are info', () => {
  const r = misfireScan([0], [0]);
  r.engine.monitor = { mil: false, readiness: [{ name: 'Catalyst', complete: false }, { name: 'Misfire', complete: true }] };
  const a = buildAdvice(r);
  assert.strictEqual(a.overall, 'info');
  assert.match(a.items[0].title, /not finished: catalyst/);
});

test('live: samples to CSV', () => {
  const { samplesToCsv } = require('../src/live');
  const csv = samplesToCsv([
    { t: Date.UTC(2026, 9, 30, 18), values: { rpm: 2150.25, boost: 0.456 }, misfires: [{ cylinder: 1, current: 0 }, { cylinder: 2, current: 3 }] },
    { t: Date.UTC(2026, 9, 30, 18, 0, 1), values: { rpm: 900 }, misfires: [] },
  ]).split('\r\n');
  assert.strictEqual(csv[0], 'time,rpm,speed,boost,throttle,load,coolant,iat,voltage,timing,stft,ltft,maf,misfires_cyl1,misfires_cyl2');
  assert.strictEqual(csv[1], '2026-10-30T18:00:00.000Z,2150.25,,0.46,,,,,,,,,,0,3');
  assert.strictEqual(csv[2], '2026-10-30T18:00:01.000Z,900,,,,,,,,,,,,,');
});
