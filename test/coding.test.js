// Coding uses synthetic replies only (nothing has been written to a real car
// yet). Features and platforms are injected, so these tests don't depend on
// what codingFeatures.js currently lists.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const isotp = require('../src/isotp');
const d = require('../src/decode');
const { recorder, READ_SIDS } = require('../src/scan');
const { readCoding, planChanges, planRestore, writeCoding, codingAllowed } = require('../src/coding');
const cat = require('../src/codingCatalog');
const { CodingStore } = require('../src/codingStore');
const { ReplayElm, createDemoCoding } = require('../src/replay');

const R = (...lines) => lines.join('\r');
const VIN = 'WAUZZZ8X4GB012345';
const C09 = '0A180A3E0C00A00800040040E80C00102D08003000001400000000000000';
const C46 = '018D08000C0000000000';

// Same car as the demo, on a plain ELM327 (STI -> "?"), so no STPX.
const ELM_S1 = {
  ATI: 'ELM327 v1.4b',
  ATRV: '12.7V',
  '7DF:0100': '7E8 06 41 00 BE 3E A8 13',
  '7DF:0902': R('7E8 10 14 49 02 01 57 41 55', '7E8 21 5A 5A 5A 38 58 34 47', '7E8 22 42 30 31 32 33 34 35'),
};

const ONOFF = [{ label: 'Off', value: 0 }, { label: 'On', value: 1 }];
const feature = (over) => ({
  platform: 'audi-8x',
  module: '09',
  did: 0x0600,
  options: [{ label: 'Off', value: 0 }, { label: 'On', value: 0x80 }],
  category: 'Lights',
  description: '',
  needs: null,
  partNumbers: null,
  source: 'test',
  verified: false,
  ...over,
});
const FEATS = [
  feature({ id: 't.fog', name: 'Fog cornering', byte: 14, mask: 0x80, partNumbers: '^8X0 ?907 ?063' }),
  feature({ id: 't.low', name: 'Low bit', byte: 14, mask: 0x01, options: ONOFF, verified: true }),
  feature({ id: 't.wide', name: 'Wide', byte: 14, mask: 0x81, options: [{ label: 'Off', value: 0 }, { label: 'Both', value: 0x81 }] }),
  feature({ id: 't.mode', name: 'Mode', byte: 2, mask: 0x0f, options: [{ label: 'A', value: 0x0a }, { label: 'B', value: 0x0b }, { label: 'C', value: 0x0c }] }),
  feature({ id: 't.odd', name: 'Odd', byte: 3, mask: 0x0f, options: [{ label: 'One', value: 1 }, { label: 'Two', value: 2 }] }),
  feature({ id: 't.far', name: 'Far', byte: 40, mask: 0x01, options: ONOFF }),
  feature({ id: 't.part', name: 'Other part', module: '17', byte: 0, mask: 0x01, options: ONOFF, partNumbers: '^5Q0' }),
  feature({ id: 't.adapt', name: 'Adaptation', module: '46', did: 0x04a1, byte: 1, mask: 0x01, options: ONOFF }),
  feature({ id: 't.gone', name: 'Unreadable', module: '46', did: 0x04a2, byte: 0, mask: 0x01, options: ONOFF }),
  feature({ id: 't.silent', name: 'Silent', module: '5F', byte: 0, mask: 0x01, options: ONOFF }),
];

const AUDI = cat.platformById('audi-8x');
const PSA = cat.platformById('psa-cmp');
// A silent extra module to see how features on it are reported.
const TEST_AUDI = { ...AUDI, modules: [...AUDI.modules, { key: '5F', name: '5F Information electronics', tx: '773', rx: '7DD', codeable: true, dids: [0x0600] }] };
const OPTS = { platforms: [TEST_AUDI, PSA], features: FEATS };

// Demo modules plus a short adaptation DID on 46 (for single-frame writes).
function demoSim(options) {
  const sim = createDemoCoding(options);
  sim.modules['70A'].dids['04A1'] = '0010';
  return sim;
}

// Every command the adapter receives: AT/STI as is, the rest as header:cmd.
function recording(elm) {
  const sent = [];
  let header = '7DF';
  const send = elm.send.bind(elm);
  elm.send = (cmd, t) => {
    if (cmd === 'ATZ') header = '7DF';
    if (cmd.startsWith('ATSH')) header = cmd.slice(4);
    sent.push(cmd.startsWith('AT') || /^ST(I|DI)$/.test(cmd) ? cmd : `${header}:${cmd}`);
    return send(cmd, t);
  };
  return sent;
}
const carBound = (sent) => sent.filter((c) => /^[0-9A-F]{3}:/.test(c));

async function read(sim = demoSim(), replies = undefined) {
  const elm = new ReplayElm(() => {}, 0, replies, { coding: sim });
  const reading = await readCoding(elm, () => {}, OPTS);
  return { elm, sim, reading };
}

const withByte = (hex, i, b) => hex.slice(0, i * 2) + isotp.toHex([b]) + hex.slice(i * 2 + 2);

test('ISO-TP: segmenting a request into CAN frames', () => {
  const { segment, fromHex, toHex } = isotp;
  assert.deepStrictEqual(segment(fromHex('22F187')).map(toHex), ['0322F18700000000']);
  const payload = [0x2e, 0x06, 0x00, ...Array.from({ length: 17 }, (_, i) => i + 1)];
  assert.deepStrictEqual(segment(payload).map(toHex), ['10142E0600010203', '210405060708090A', '220B0C0D0E0F1011']);
  // Last frame padded to 8 bytes; sequence numbers wrap from F to 0.
  assert.deepStrictEqual(segment(fromHex('2E0600AABBCCDDEEFF11')).map(toHex), ['100A2E0600AABBCC', '21DDEEFF11000000']);
  const long = segment(Array(6 + 7 * 17).fill(0x55));
  assert.deepStrictEqual(long.slice(15, 18).map((f) => f[0]), [0x2f, 0x20, 0x21]);
  assert.throws(() => segment(Array(4096).fill(0)));
  assert.strictEqual(fromHex('2E06G0'), null);
  assert.strictEqual(fromHex('2E0'), null);
});

test('ISO-TP: flow control, block size and STmin', () => {
  const { parseFlowControl, nextFlowControl, stMinMs } = isotp;
  assert.deepStrictEqual(parseFlowControl([0x30, 0x02, 0x05, 0xaa]), { status: 'continue', blockSize: 2, stMinMs: 5 });
  assert.strictEqual(parseFlowControl([0x31, 0, 0]).status, 'wait');
  assert.strictEqual(parseFlowControl([0x32, 0, 0]).status, 'overflow');
  assert.strictEqual(parseFlowControl([0x35, 0, 0]).status, 'invalid');
  assert.strictEqual(parseFlowControl([0x21, 0, 0]), null);
  assert.deepStrictEqual([0x00, 0x14, 0x7f, 0xf1, 0xf9, 0x80, 0xfa].map(stMinMs), [0, 20, 127, 0.1, 0.9, 127, 127]);
  assert.strictEqual(nextFlowControl([[0x31, 0, 0], [0x30, 0, 0x0a]]).stMinMs, 10, 'WAIT then continue');
  assert.strictEqual(nextFlowControl([[0x31, 0, 0]]).status, 'wait');
  assert.strictEqual(nextFlowControl(Array(11).fill([0x31, 0, 0]).concat([[0x30, 0, 0]])).status, 'wait', 'too many WAITs');
  assert.strictEqual(nextFlowControl([[0x03, 0x7f, 0x2e, 0x13]]).status, 'none');
  assert.strictEqual(nextFlowControl([[0x32, 0, 0]]).status, 'overflow');
});

test('catalogue: platforms from the VIN, safety-critical modules never codeable', () => {
  assert.strictEqual(cat.platformForVin(VIN).id, 'audi-8x');
  assert.strictEqual(cat.platformForVin('VXKUBYHTKL4123456').id, 'psa-cmp');
  assert.strictEqual(cat.platformForVin('VR3UHZKXZLT123456').id, 'psa-cmp');
  assert.strictEqual(cat.platformForVin('WAUZZZ8V5JA123456'), null, 'A3 8V is not an 8X');
  assert.strictEqual(cat.platformForVin('W0L0AHM75D1234567'), null);
  assert.strictEqual(cat.platformForVin(null), null);
  assert.strictEqual(cat.canWrite(PSA), false, 'PSA is read-only until checked on a car');
  for (const p of cat.PLATFORMS) {
    for (const m of p.modules) if (cat.NEVER_CODEABLE_TX.has(m.tx)) assert.strictEqual(cat.isCodeable(p, m), false, m.name);
  }
  const fake = { ...AUDI, modules: [] };
  for (const [key, tx, rx] of [['01', '7E0', '7E8'], ['02', '7E1', '7E9'], ['03', '713', '77D'], ['15', '715', '77F'], ['44', '712', '77C'], ['03', '7A0', '7A8']]) {
    assert.strictEqual(cat.isCodeable(fake, { key, tx, rx, codeable: true }), false, `${key} ${tx}`);
  }
  assert.deepStrictEqual(cat.moduleDids(TEST_AUDI, AUDI.modules[2], FEATS), [0x04a1, 0x04a2, 0x0600]);
  const bad = feature({ id: 'bad', name: 'Bad', byte: 0, mask: 0x01, options: [{ label: 'x', value: 0 }, { label: 'y', value: 0x02 }], partNumbers: '(' });
  assert.deepStrictEqual(cat.featureProblems(bad, AUDI), ['bad option y', 'bad partNumbers pattern']);
  assert.deepStrictEqual(cat.featureProblems({ ...bad, module: '99', options: ONOFF, partNumbers: null }, AUDI), ['unknown module 99']);
});

test('the features data file is well-formed (whatever it lists)', () => {
  const { FEATURES } = require('../src/codingFeatures');
  const ids = FEATURES.map((f) => f.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'feature ids are unique');
  for (const f of FEATURES) {
    assert.deepStrictEqual(cat.featureProblems(f, cat.platformById(f.platform)), [], f.id);
  }
});

test('reading decodes modules and features, read-only', async () => {
  const elm = new ReplayElm(() => {}, 0, undefined, { coding: demoSim() });
  const sent = recording(elm);
  const r = await readCoding(elm, () => {}, OPTS);

  assert.strictEqual(r.vin, VIN);
  assert.strictEqual(r.voltage, 12.6);
  assert.strictEqual(r.stn, true);
  assert.strictEqual(r.adapter, 'STN1130 v4.6.4 (ELM327 v1.4b)');
  assert.deepStrictEqual(r.platform, { id: 'audi-8x', label: 'Audi A1 / S1 (8X)', writable: true, verified: false, security: null, protocol: 'vag-uds' });
  const byKey = Object.fromEntries(r.modules.map((m) => [m.key, m]));
  assert.deepStrictEqual(
    [byKey['09'].partNo, byKey['09'].swVersion, byKey['09'].systemName, byKey['09'].codeable],
    ['8X0907063AH', '0560', 'BCM PQ25 H+4', true],
  );
  assert.deepStrictEqual(byKey['09'].data, { '0600': C09 });
  assert.deepStrictEqual(byKey['17'].data['0600'].length, 36);
  assert.deepStrictEqual(byKey['46'].data, { '0600': C46, '04A1': '0010' });
  assert.deepStrictEqual(byKey['46'].unreadable, { '04A2': 'request out of range' });
  assert.strictEqual(byKey['5F'].responded, false);

  const f = Object.fromEntries(r.features.map((x) => [x.id, x]));
  assert.deepStrictEqual([f['t.fog'].current, f['t.fog'].available], [0, true]);
  assert.deepStrictEqual([f['t.mode'].current, f['t.mode'].available], [0x0a, true]);
  assert.deepStrictEqual([f['t.adapt'].current, f['t.adapt'].available], [0, true]);
  assert.strictEqual(f['t.odd'].current, null);
  assert.match(f['t.odd'].reason, /0x0E/);
  assert.match(f['t.far'].reason, /30 bytes.*byte 40/);
  assert.match(f['t.part'].reason, /part number 8X0920930H/);
  assert.match(f['t.gone'].reason, /couldn't read data 04A2 \(request out of range\)/);
  assert.match(f['t.silent'].reason, /didn't answer/);
  for (const id of ['t.odd', 't.far', 't.part', 't.gone', 't.silent']) assert.strictEqual(f[id].available, false, id);

  // Only read-only services reached the car.
  assert.deepStrictEqual(carBound(sent).filter((c) => !/:(0100|0902|22[0-9A-F]{4})$/.test(c)), []);
  assert.deepStrictEqual(r.transcript.map(([h, c]) => `${h}:${c}`), carBound(sent), 'every exchange is in the transcript');
});

test('reading a car without a coding list', async () => {
  const elm = new ReplayElm(() => {}, 0, {
    '7DF:0100': '7E8 06 41 00 BE 3F A8 13',
    '7DF:0902': R('7E8 10 14 49 02 01 57 30 4C', '7E8 21 30 41 48 4D 37 35 44', '7E8 22 31 32 33 34 35 36 37'),
  });
  const r = await readCoding(elm);
  assert.deepStrictEqual([r.vin, r.platform, r.modules, r.features, r.stn], ['W0L0AHM75D1234567', null, [], [], false]);
  assert.throws(() => planChanges(r, [{ module: '09', did: 0x0600, hex: C09 }]), /no coding list/);
});

test('planning merges changes to one DID and reports unverified settings', async () => {
  const { reading } = await read();
  const plan = planChanges(reading, [{ featureId: 't.fog', value: 0x80 }, { featureId: 't.low', value: 1 }, { featureId: 't.mode', value: 0x0c }], OPTS);
  assert.strictEqual(plan.length, 1);
  const [it] = plan;
  assert.deepStrictEqual([it.module, it.tx, it.rx, it.did, it.before], ['09', '70E', '778', '0600', C09]);
  assert.strictEqual(it.after, withByte(withByte(C09, 14, 0x81), 2, 0x0c));
  assert.deepStrictEqual(it.edits, [
    { byte: 2, before: 0x0a, after: 0x0c, features: ['Mode'] },
    { byte: 14, before: 0x00, after: 0x81, features: ['Fog cornering', 'Low bit', 'Wide'] },
  ]);
  assert.deepStrictEqual(it.unverified, ['Fog cornering', 'Wide', 'Mode']);
  assert.deepStrictEqual(it.settings.find((s) => s.id === 't.fog'), { id: 't.fog', name: 'Fog cornering', before: 'Off', after: 'On', verified: false });
  assert.strictEqual(it.raw, false);

  // Raw edits merge with feature changes on other bits; raw-only bytes are flagged.
  const raw = withByte(C09, 20, 0xff);
  const mixed = planChanges(reading, [{ module: '09', did: '0600', hex: raw }, { featureId: 't.fog', value: 0x80 }], OPTS);
  assert.strictEqual(mixed[0].after, withByte(raw, 14, 0x80));
  assert.deepStrictEqual(mixed[0].edits.map((e) => [e.byte, e.raw === true]), [[14, false], [20, true]]);

  // Two modules -> two items; settings already in place -> nothing to do.
  assert.strictEqual(planChanges(reading, [{ featureId: 't.fog', value: 0x80 }, { featureId: 't.adapt', value: 1 }], OPTS).length, 2);
  assert.deepStrictEqual(planChanges(reading, [{ featureId: 't.fog', value: 0 }], OPTS), []);
  assert.strictEqual(planChanges(reading, [{ featureId: 't.fog', value: 0x80 }, { featureId: 't.fog', value: 0x80 }], OPTS).length, 1);
});

test('planning refuses bad, conflicting or unsafe changes', async () => {
  const { reading } = await read();
  const refuses = (changes, re, opts = OPTS, r = reading) => assert.throws(() => planChanges(r, changes, opts), re);
  refuses([{ featureId: 't.fog', value: 0x80 }, { featureId: 't.wide', value: 0 }], /same bits/);
  refuses([{ featureId: 't.fog', value: 0x80 }, { featureId: 't.fog', value: 0 }], /same bits/);
  refuses([{ module: '09', did: 0x0600, hex: withByte(C09, 14, 0x01) }, { module: '09', did: 0x0600, hex: withByte(C09, 14, 0x80) }], /one raw change/);
  refuses([{ module: '09', did: 0x0600, hex: withByte(C09, 14, 0x01) }, { featureId: 't.low', value: 0 }], /same bits/);
  refuses([{ featureId: 'nope', value: 1 }], /Unknown setting/);
  refuses([{ featureId: 't.fog', value: 0x40 }], /unknown option/);
  refuses([{ featureId: 't.part', value: 1 }], /part number/);
  refuses([{ featureId: 't.odd', value: 1 }], /isn't one this app knows/);
  refuses([{ featureId: 't.silent', value: 1 }], /wasn't read/);
  refuses([{ module: '09', did: 0x0600, hex: C09.slice(2) }], /30 bytes.*29/);
  refuses([{ module: '09', did: 0x0600, hex: `${C09}00` }], /30 bytes.*31/);
  refuses([{ module: '09', did: 0x0600, hex: 'XYZ' }], /hex/);
  refuses([{ module: '09', did: 0xf187, hex: '00' }], /isn't on the coding list/);
  refuses([{ module: '09', did: 'zz', hex: '00' }], /isn't on the coding list/);
  refuses([{ module: '01', did: 0x0600, hex: '00' }], /Unknown module/);
  refuses([], /No changes/);
  refuses([{ restore: 'x' }], /Bad coding change/);

  // Engine marked codeable in (bad) data is still refused, in planning and on the wire.
  const ENGINE = { id: 'engine-test', label: 'Engine test', match: () => false, protocol: 'vag-uds', security: null, writable: true, verified: false, modules: [{ key: '01', name: '01 Engine', tx: '7E0', rx: '7E8', codeable: true, dids: [0x0600] }] };
  const engineReading = { vin: VIN, platform: { id: 'engine-test' }, modules: [{ key: '01', responded: true, data: { '0600': '0011' } }] };
  refuses([{ module: '01', did: 0x0600, hex: '0012' }], /can't be changed with this app/, { platforms: [ENGINE], features: [] }, engineReading);
  const allow = codingAllowed(ENGINE, []);
  assert.deepStrictEqual([allow([0x2e, 0x06, 0x00, 0x00, 0x12], '7E0'), allow([0x10, 0x03], '7E0'), allow([0x22, 0x06, 0x00], '7E0')], [false, false, true]);

  // PSA is read-only: reading works, writing is refused.
  const psaReading = { vin: 'VXKUBYHTKL4123456', platform: { id: 'psa-cmp' }, modules: [{ key: 'BSI', responded: true, data: { '0600': '00' } }] };
  refuses([{ module: 'BSI', did: 0x0600, hex: '01' }], /read-only/, {}, psaReading);
  const psaAllow = codingAllowed(PSA, []);
  assert.deepStrictEqual([psaAllow([0x10, 0x03], '752'), psaAllow([0x2e, 0x06, 0x00, 0x01], '752'), psaAllow([0x22, 0xf1, 0x87], '752')], [false, false, true]);
});

test('restore plans put a backup back after checking it belongs to this car', async () => {
  const { reading } = await read();
  const record = { id: `${VIN}_original-09-0600`, vin: VIN, platform: 'audi-8x', module: '09', tx: '70E', rx: '778', did: '0600', hex: withByte(C09, 14, 0x80), reason: 'original', at: '2026-11-01T10:00:00.000Z' };
  const [it] = planRestore(reading, record, OPTS);
  assert.deepStrictEqual([it.before, it.after, it.restore.id], [C09, record.hex, record.id]);
  // Every known setting on the changed bits is named, even one that ends up
  // on a value with no label.
  assert.deepStrictEqual(it.settings.map((s) => [s.name, s.before, s.after]), [['Fog cornering', 'Off', 'On'], ['Wide', 'Off', '0x80']]);
  assert.deepStrictEqual(planRestore(reading, { ...record, hex: C09 }, OPTS), [], 'already matches');
  assert.throws(() => planRestore(reading, { ...record, vin: 'WAUZZZ8X0GB000000' }, OPTS), /different car/);
  assert.throws(() => planRestore(reading, { ...record, tx: '7E0' }, OPTS), /addresses/);
  assert.throws(() => planRestore(reading, { ...record, hex: '00' }, OPTS), /30 bytes/);
});

test('allowlist checks every request: header, service, sub-function and DID', async () => {
  const elm = new ReplayElm(() => {}, 0, undefined, { coding: demoSim() });
  const sent = recording(elm);
  const rec = recorder(elm, [], codingAllowed(TEST_AUDI, FEATS));
  await rec.send('ATSH70E');
  for (const bad of ['2701', '2702AABBCCDD', '1101', '1103', '3101FF00', '3401004400', '3601', '37', '2802', '8502', '0400', '14FFFFFF', '1002', '1081', '3E80', '2EF19800000000', '2E04A10011', '2F0600']) {
    await assert.rejects(rec.send(bad), /Refusing/, bad);
    await assert.rejects(rec.sendPayload(bad), /Refusing/, bad);
  }
  await assert.rejects(rec.sendPayload(`2E0600${C09}`.replace('2E0600', '2E0601')), /Refusing/);
  // 2E 0600 is fine on 09 but not on the engine or a module that isn't codeable.
  for (const h of ['ATSH7E0', 'ATSH713', 'ATSH7DF', 'ATSH710']) {
    await rec.send(h);
    await assert.rejects(rec.sendPayload(`2E0600${C09}`), /Refusing/, h);
    await assert.rejects(rec.send('1003'), /Refusing/, h);
  }
  // Adapter commands: only STI / STDI pass; STPX only via sendPayload.
  for (const st of ['STSBR 2000000', 'STPX H:70E, D:2E0600, R:1', 'STWBR', 'STSLCS', 'STP 33']) {
    await assert.rejects(rec.send(st), /adapter command not allowed/, st);
  }
  // Raw frames can't sneak a request past the check either.
  await rec.send('ATSH70E');
  await rec.send('ATCAF0');
  for (const frame of ['022701', '101411111111111', '1014111111111111', '2111111111111111']) await assert.rejects(rec.send(frame), /Refusing/, frame);
  await rec.send('ATCAF1');
  assert.deepStrictEqual(carBound(sent), [], 'nothing refused reached the adapter');
  assert.match(await rec.send('STI'), /STN/);

  // The scan's read-only recorder still refuses every coding request.
  const ro = recorder(elm, [], READ_SIDS);
  for (const bad of ['1003', '1001', '3E00', `2E0600${C46}`]) await assert.rejects(ro.send(bad), /Refusing/);
  await assert.rejects(ro.sendPayload(`2E0600${C09}`), /Refusing/);
  assert.deepStrictEqual(carBound(sent), []);
});

test('long writes use STPX on an STN adapter', async () => {
  const sim = demoSim();
  const elm = new ReplayElm(() => {}, 0, undefined, { coding: sim });
  const transcript = [];
  const rec = recorder(elm, transcript, codingAllowed(AUDI, []));
  await rec.send('ATSH70E');
  await rec.send('1003');
  const after = withByte(C09, 14, 0x80);
  const out = await rec.sendPayload(`2E0600${after}`);
  assert.strictEqual(rec.stn, true);
  assert.strictEqual(transcript.at(-1)[1], `STPX H:70E, D:2E0600${after}, R:1`);
  assert.strictEqual(d.finalReply(out, 0x2e).ok, true);
  assert.strictEqual(sim.modules['70E'].dids['0600'], after);
});

test('without STPX, long writes are sent as ISO-TP frames honouring block size and STmin', async () => {
  const sim = demoSim({ flowControl: [[0x30, 0x02, 0x0a]] });
  const elm = new ReplayElm(() => {}, 0, ELM_S1, { coding: sim });
  const sent = recording(elm);
  const transcript = [];
  const rec = recorder(elm, transcript, codingAllowed(AUDI, []));
  await rec.send('ATSH70E');
  await rec.send('1003');
  const after = withByte(C09, 29, 0x42);
  const frames = isotp.segment(isotp.fromHex(`2E0600${after}`)).map(isotp.toHex);
  assert.strictEqual(frames.length, 5);
  const started = Date.now();
  const out = await rec.sendPayload(`2E0600${after}`);
  const took = Date.now() - started;

  const f = frames.map((x) => `70E:${x}`);
  assert.deepStrictEqual(sent.slice(sent.indexOf('70E:1003') + 1), [
    'STI', 'ATCAF0', `${f[0]} 1`, 'ATR0', f[1], 'ATR1', `${f[2]} 1`, 'ATR0', f[3], 'ATR1', f[4], 'ATCAF1', 'ATR1',
  ]);
  assert.ok(took >= 36, `STmin 10 ms before each of 4 frames (took ${took} ms)`);
  assert.strictEqual(rec.stn, false);
  assert.strictEqual(d.finalReply(out, 0x2e).ok, true);
  assert.strictEqual(sim.modules['70E'].dids['0600'], after, 'module reassembled the frames');
  assert.deepStrictEqual(transcript.map(([h, c]) => `${h}:${c}`), carBound(sent), 'each frame is in the transcript');
});

test('manual ISO-TP gives up on overflow or endless WAIT and restores the adapter', async () => {
  for (const [flowControl, re] of [[[[0x32, 0, 0]], /overflow/], [[[0x31, 0, 0]], /wait/], [[], /didn't answer the first frame/]]) {
    const sim = demoSim({ flowControl });
    const elm = new ReplayElm(() => {}, 0, ELM_S1, { coding: sim });
    const sent = recording(elm);
    const rec = recorder(elm, [], codingAllowed(AUDI, []));
    await rec.send('ATSH70E');
    await rec.send('1003');
    await assert.rejects(rec.sendPayload(`2E0600${withByte(C09, 0, 0)}`), (err) => re.test(err.message) && err.code === 'ISOTP');
    assert.deepStrictEqual(sent.slice(-2), ['ATCAF1', 'ATR1']);
    assert.strictEqual(carBound(sent).length, 2, 'only 10 03 and the first frame went out');
    assert.deepStrictEqual(sim.writes, []);
  }
  // A WAIT followed by "continue" is fine.
  const sim = demoSim({ flowControl: [[0x31, 0, 0], [0x30, 0, 0]] });
  const rec = recorder(new ReplayElm(() => {}, 0, ELM_S1, { coding: sim }), [], codingAllowed(AUDI, []));
  await rec.send('ATSH70E');
  await rec.send('1003');
  await rec.sendPayload(`2E0600${withByte(C09, 0, 0)}`);
  assert.strictEqual(sim.writes.length, 1);
});

test('a write sends exactly the expected sequence and reads back', async () => {
  const { elm, sim, reading } = await read();
  const plan = planChanges(reading, [{ featureId: 't.fog', value: 0x80 }], OPTS);
  const sent = recording(elm);
  const backups = [];
  const progress = [];
  const res = await writeCoding(elm, reading, plan, { ...OPTS, backup: async (r) => backups.push(r), onProgress: (p) => progress.push(p) });
  const after = plan[0].after;

  assert.deepStrictEqual(sent, [
    'ATZ', 'ATE0', 'ATL0', 'ATH1', 'ATS1', 'ATCAF1', 'STI', 'ATRV',
    'ATSP6', '7DF:0100', 'ATSH7DF', 'ATCRA7E8', '7DF:0902',
    'ATSH70E', 'ATCRA778', 'ATFCSH70E', 'ATFCSD300000', 'ATFCSM1', 'ATST FF',
    '70E:220600', 'ATRV', '70E:1003', `70E:STPX H:70E, D:2E0600${after}, R:1`, '70E:1001', '70E:220600',
    'ATCAF1', 'ATR1', 'ATFCSM0', 'ATCRA',
  ]);
  assert.deepStrictEqual(res.results, [{ module: '09', name: '09 Central electrics', did: '0600', before: C09, after, ok: true, readback: after }]);
  assert.deepStrictEqual([res.vin, res.platform], [VIN, 'audi-8x']);
  assert.deepStrictEqual(res.transcript.map(([h, c]) => `${h}:${c}`), carBound(sent));
  assert.strictEqual(backups.length, 1);
  const { at, ...rec } = backups[0];
  assert.ok(!Number.isNaN(Date.parse(at)));
  assert.deepStrictEqual(rec, { vin: VIN, platform: 'audi-8x', module: '09', name: '09 Central electrics', tx: '70E', rx: '778', did: '0600', hex: C09, partNo: '8X0907063AH', swVersion: '0560', reason: 'before-write' });
  assert.deepStrictEqual(progress, ['Resetting adapter', 'Connecting to car', 'Checking 09 Central electrics', 'Backing up 09 Central electrics', 'Writing 09 Central electrics', 'Checking 09 Central electrics', 'Done']);
  assert.strictEqual(sim.modules['70E'].session, 1, 'back in the default session');

  // The simulated car keeps it: the next reading shows the new setting.
  const again = await readCoding(elm, () => {}, OPTS);
  assert.strictEqual(again.features.find((f) => f.id === 't.fog').current, 0x80);
});

test('one module, two DIDs: one session, single-frame and STPX writes', async () => {
  const { elm, sim, reading } = await read();
  const plan = planChanges(reading, [{ featureId: 't.adapt', value: 1 }, { module: '46', did: 0x0600, hex: withByte(C46, 9, 0x01) }], OPTS);
  const sent = recording(elm);
  const res = await writeCoding(elm, reading, plan, { ...OPTS, backup: () => {} });
  assert.deepStrictEqual(carBound(sent), [
    '7DF:0100', '7DF:0902', '70A:2204A1', '70A:220600', '70A:1003', '70A:2E04A10011', `70A:STPX H:70A, D:2E0600${withByte(C46, 9, 0x01)}, R:1`, '70A:1001', '70A:2204A1', '70A:220600',
  ]);
  assert.deepStrictEqual(res.results.map((r) => [r.did, r.ok]), [['04A1', true], ['0600', true]]);
  assert.strictEqual(sim.modules['70A'].dids['04A1'], '0011');
});

test('a write on a plain ELM327 uses manual frames end to end', async () => {
  const { elm, sim, reading } = await read(demoSim(), ELM_S1);
  assert.strictEqual(reading.stn, false);
  const after = withByte(C46, 0, 0x03);
  const plan = planChanges(reading, [{ module: '46', did: 0x0600, hex: after }], OPTS);
  const sent = recording(elm);
  const res = await writeCoding(elm, reading, plan, { ...OPTS, backup: () => {} });
  const [ff, cf] = isotp.segment(isotp.fromHex(`2E0600${after}`)).map(isotp.toHex);
  assert.deepStrictEqual(carBound(sent), ['7DF:0100', '7DF:0902', '70A:220600', '70A:1003', `70A:${ff} 1`, `70A:${cf}`, '70A:1001', '70A:220600']);
  const i = sent.indexOf(`70A:${cf}`);
  assert.deepStrictEqual(sent.slice(i + 1, i + 3), ['ATCAF1', 'ATR1']);
  assert.ok(sent.indexOf('ATCAF0') < sent.indexOf(`70A:${ff} 1`));
  assert.strictEqual(res.results[0].ok, true);
  assert.strictEqual(sim.modules['70A'].dids['0600'], after);
});

test('writes are refused before reaching the car', async (t) => {
  const plan09 = (reading) => planChanges(reading, [{ featureId: 't.fog', value: 0x80 }], OPTS);
  const noWrite = (sent) => assert.deepStrictEqual(carBound(sent).filter((c) => !/:(0100|0902|22[0-9A-F]{4})$/.test(c)), []);

  await t.test('battery below 12.4 V', async () => {
    const { elm, reading } = await read(demoSim({ voltage: '12.1V' }));
    const sent = recording(elm);
    let backedUp = false;
    await assert.rejects(writeCoding(elm, reading, plan09(reading), { ...OPTS, backup: () => (backedUp = true) }), /12\.1 V.*12\.4 V/);
    assert.deepStrictEqual(carBound(sent), []);
    assert.strictEqual(backedUp, false);
  });

  await t.test('a different car', async () => {
    const { elm, reading } = await read();
    const plan = plan09(reading);
    const sent = recording(elm);
    await assert.rejects(writeCoding(elm, { ...reading, vin: 'WAUZZZ8X0GB000000' }, plan, { ...OPTS, backup: () => {} }), /isn't the car that was read/);
    assert.deepStrictEqual(carBound(sent), ['7DF:0100', '7DF:0902']);
  });

  await t.test('the coding changed since it was read', async () => {
    const { elm, sim, reading } = await read();
    const plan = plan09(reading);
    sim.modules['70E'].dids['0600'] = withByte(C09, 0, 0x0b);
    const sent = recording(elm);
    let backedUp = false;
    const res = await writeCoding(elm, reading, plan, { ...OPTS, backup: () => (backedUp = true) });
    assert.match(res.results[0].error, /changed since the car was read/);
    assert.strictEqual(res.results[0].ok, false);
    assert.strictEqual(backedUp, false);
    noWrite(sent);
  });

  await t.test('plans that fail the checks (tampered or stale)', async () => {
    const { elm, reading } = await read();
    const [good] = plan09(reading);
    const sent = recording(elm);
    const bad = [
      [{ ...good, module: '01' }, /Unknown module/],
      [{ ...good, did: 'F187' }, /isn't on the coding list/],
      [{ ...good, after: good.after.slice(2) }, /same length/],
      [{ ...good, tx: '7E0' }, /addresses/],
      [{ ...good, before: withByte(C09, 0, 0) }, /wasn't built from the last reading/],
      [[good, good], /twice/],
    ];
    for (const [plan, re] of bad) await assert.rejects(writeCoding(elm, reading, Array.isArray(plan) ? plan : [plan], { ...OPTS, backup: () => {} }), re);
    await assert.rejects(writeCoding(elm, reading, [good], OPTS), /backup is needed/);
    // Engine marked codeable in the data.
    const ENGINE = { id: 'engine-test', label: 'Engine test', match: () => false, protocol: 'vag-uds', security: null, writable: true, verified: false, modules: [{ key: '01', name: '01 Engine', tx: '7E0', rx: '7E8', codeable: true, dids: [0x0600] }] };
    const engineReading = { vin: VIN, platform: { id: 'engine-test' }, modules: [{ key: '01', responded: true, data: { '0600': '0011' } }] };
    const enginePlan = [{ module: '01', name: '01 Engine', tx: '7E0', rx: '7E8', did: '0600', before: '0011', after: '0012' }];
    await assert.rejects(writeCoding(elm, engineReading, enginePlan, { platforms: [ENGINE], features: [], backup: () => {} }), /can't be changed with this app/);
    // Read-only platform.
    const psaReading = { vin: 'VXKUBYHTKL4123456', platform: { id: 'psa-cmp' }, modules: [{ key: 'BSI', responded: true, data: { '0600': '00' } }] };
    const psaPlan = [{ module: 'BSI', name: 'BSI', tx: '752', rx: '652', did: '0600', before: '00', after: '01' }];
    await assert.rejects(writeCoding(elm, psaReading, psaPlan, { backup: () => {} }), /read-only/);
    assert.deepStrictEqual(sent, [], 'nothing at all was sent');
  });

  await t.test('empty plan does nothing', async () => {
    const { elm, reading } = await read();
    const sent = recording(elm);
    const res = await writeCoding(elm, reading, [], { ...OPTS, backup: () => {} });
    assert.deepStrictEqual([res.results, sent], [[], []]);
  });
});

test('a failed backup stops that write and the rest', async () => {
  const { elm, sim, reading } = await read();
  const plan = planChanges(reading, [{ featureId: 't.fog', value: 0x80 }, { featureId: 't.adapt', value: 1 }], OPTS);
  const sent = recording(elm);
  const res = await writeCoding(elm, reading, plan, {
    ...OPTS,
    backup: () => {
      throw new Error('disk full');
    },
  });
  assert.deepStrictEqual(res.results.map((r) => [r.module, r.ok]), [['09', false], ['46', false]]);
  assert.match(res.results[0].error, /backup couldn't be saved \(disk full\); nothing was written/);
  assert.match(res.results[1].error, /backup could not be saved/);
  assert.deepStrictEqual(carBound(sent).filter((c) => /:(10|2E|STPX)/.test(c)), []);
  assert.deepStrictEqual(sim.writes, []);
});

test('read-back problems and refusals are reported in plain English', async (t) => {
  const write = async (simOptions, writeOptions = {}, replies = undefined) => {
    const sim = demoSim(simOptions);
    const elm = new ReplayElm(() => {}, 0, replies, { coding: sim });
    const reading = await readCoding(elm, () => {}, OPTS);
    const plan = planChanges(reading, [{ featureId: 't.fog', value: 0x80 }], OPTS);
    return { plan, res: (await writeCoding(elm, reading, plan, { ...OPTS, backup: () => {}, ...writeOptions })).results[0], sim };
  };

  await t.test('module stores something else', async () => {
    const { plan, res } = await write({ mangle: true });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /doesn't match what was written/);
    assert.notStrictEqual(res.readback, plan[0].after);
    assert.notStrictEqual(res.readback, plan[0].before);
  });

  await t.test('module says yes but keeps the old coding', async () => {
    const { res } = await write({ ignoreWrites: true });
    assert.deepStrictEqual([res.ok, res.readback], [false, undefined]);
    assert.match(res.error, /still has the old coding/);
  });

  for (const [nrc, re] of [[0x33, /needs security access \/ login \(not supported yet\)/], [0x22, /conditions not correct/], [0x31, /out of range/], [0x7f, /different diagnostic session/], [0x72, /couldn't store/]]) {
    await t.test(`NRC 0x${nrc.toString(16)}`, async () => {
      const { res } = await write({ refuse: nrc });
      assert.strictEqual(res.ok, false);
      assert.match(res.error, re);
      assert.match(res.error, /nothing was changed/);
    });
  }

  await t.test('response pending, then yes', async () => {
    const { res, sim } = await write({ pending: true });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(sim.writes.length, 1);
  });

  await t.test('only response pending: read-back decides', async () => {
    const after = withByte(C09, 14, 0x80);
    const replies = { ...ELM_S1, STI: 'STN1130 v4.6.4', [`70E:STPX H:70E, D:2E0600${after}, R:1`]: '778 03 7F 2E 78' };
    const { res } = await write({}, { pendingMs: 1 }, replies);
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /no answer from the module; nothing was changed/);
  });
});

test('demo adapter: STN, shared coding, scans unaffected', async () => {
  const a = new ReplayElm();
  const b = new ReplayElm();
  assert.strictEqual(a.sim, b.sim, 'demo writes persist across adapters');
  assert.strictEqual(new ReplayElm(() => {}, 0, {}).sim, null);
  assert.strictEqual(ReplayElm.fromTranscript([]).sim, null);
  assert.strictEqual(await a.send('STI'), 'STN1130 v4.6.4');
  assert.strictEqual(await new ReplayElm(() => {}, 0, {}).send('STPX H:70E, D:2E0600, R:1'), '?', 'an ELM refuses STPX');
});

test('coding store: originals are never overwritten, ids are path-safe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obd-coding-'));
  const store = new CodingStore(dir);
  const base = { vin: VIN, module: '09', name: '09 Central electrics', did: '0600', hex: C09, partNo: '8X0907063AH', swVersion: '0560', at: '2026-11-10T10:00:00.000Z' };

  const id = store.saveOriginal(base);
  assert.strictEqual(id, `${VIN}_original-09-0600`);
  assert.strictEqual(store.saveOriginal({ ...base, hex: withByte(C09, 0, 0xff), at: '2026-11-11T10:00:00.000Z' }), null);
  const original = store.load(id);
  assert.strictEqual(original.hex, C09, 'first original kept');
  // Platform and addresses come from the catalogue when the record lacks them.
  assert.deepStrictEqual([original.platform, original.tx, original.rx, original.reason, original.original], ['audi-8x', '70E', '778', 'original', true]);

  const b1 = store.saveBackup({ ...base, did: 0x0600, at: '2026-11-12T09:00:00.000Z' });
  const b2 = store.saveBackup({ ...base, at: '2026-11-12T09:00:00.000Z', hex: withByte(C09, 1, 0) });
  assert.notStrictEqual(b1, b2, 'same time, still two files');
  const listed = store.list(VIN);
  assert.deepStrictEqual(new Set(listed.slice(0, 2).map((r) => r.id)), new Set([b1, b2]));
  assert.deepStrictEqual(listed.map((r) => [r.reason, r.original]), [['before-write', false], ['before-write', false], ['original', true]], 'newest first');
  assert.deepStrictEqual(store.list('WAUZZZ8X0GB000000'), []);

  const reading = { vin: VIN, at: '2026-11-12T08:00:00.000Z', platform: { id: 'audi-8x' }, modules: [
    { key: '09', name: '09 Central electrics', tx: '70E', rx: '778', data: { '0600': C09 } },
    { key: '46', name: '46 Comfort', tx: '70A', rx: '774', data: { '0600': C46, '04A1': '0010' } },
    { key: '5F', name: 'Silent', tx: '773', rx: '7DD', data: {} },
  ] };
  assert.deepStrictEqual(store.saveOriginals(reading), [`${VIN}_original-46-0600`, `${VIN}_original-46-04A1`]);
  assert.deepStrictEqual(store.saveOriginals(reading), []);

  store.logChange({ vin: VIN, at: '2026-11-12T09:00:01.000Z', results: [{ module: '09', ok: true }] });
  assert.deepStrictEqual(store.changes(VIN).map((c) => c.results[0].ok), [true]);

  // Nothing from outside can pick the file name.
  for (const bad of ['../../etc/passwd', `${VIN}_../x`, `${VIN}_..\\x`, `${VIN}/x`, 'x', `${VIN}_`, `${VIN}_a.b`, null, 42]) {
    assert.throws(() => store.load(bad), /Bad backup id/, String(bad));
  }
  for (const vin of ['../..', `${VIN}/..`, 'WAUZZZ8X4GB01234O', '', null]) {
    assert.throws(() => store.list(vin), /Bad VIN/);
    assert.throws(() => store.saveBackup({ ...base, vin }), /Bad VIN/);
    assert.throws(() => store.logChange({ vin }), /Bad VIN/);
  }
  assert.throws(() => store.saveBackup({ ...base, module: '../x' }), /Bad module/);
  assert.throws(() => store.saveBackup({ ...base, did: '../0' }), /Bad DID/);
  assert.throws(() => store.saveBackup({ ...base, did: -1 }), /Bad DID/);
  assert.throws(() => store.saveOriginal({ ...base, hex: 'zz' }), /Bad coding bytes/);
  const files = fs.readdirSync(dir, { recursive: true }).map(String).sort();
  assert.deepStrictEqual(files, [VIN, ...[`${VIN}/changes.jsonl`, ...store.list(VIN).map((r) => `${VIN}/${r.id.slice(18)}.json`)].map((f) => path.normalize(f))].sort());
  fs.rmSync(dir, { recursive: true, force: true });
});
