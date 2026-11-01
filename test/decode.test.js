// Fixtures are real replies captured from a 2016 Audi S1 on 2026-10-26.
const test = require('node:test');
const assert = require('node:assert');
const d = require('../src/decode');
const { describe } = require('../src/codes');

const join = (...lines) => lines.join('\r');

test('monitor status: MIL off, no codes, readiness', () => {
  const m = d.parseMonitorStatus('7E8 06 41 01 00 07 E1 21');
  assert.deepStrictEqual([m.mil, m.dtcCount, m.ignition], [false, 0, 'spark']);
  assert.deepStrictEqual(m.readiness, [
    { name: 'Misfire', complete: true },
    { name: 'Fuel system', complete: true },
    { name: 'Components', complete: true },
    { name: 'Catalyst', complete: false },
    { name: 'Oxygen sensor', complete: false },
    { name: 'Oxygen sensor heater', complete: true },
    { name: 'EGR / VVT', complete: true },
  ]);
  // Synthetic diesel: MIL on with 2 codes, particulate filter not finished.
  const diesel = d.parseMonitorStatus('7E8 06 41 01 82 0F 41 40');
  assert.deepStrictEqual([diesel.mil, diesel.dtcCount, diesel.ignition], [true, 2, 'compression']);
  assert.deepStrictEqual(diesel.readiness.filter((r) => !r.complete).map((r) => r.name), ['Particulate filter']);
});

test('freeze frame (mode 02)', () => {
  assert.strictEqual(d.parseFreezeFrame('7E8 05 42 02 00 03 01', 0x02), 'P0301');
  assert.strictEqual(d.parseFreezeFrame('7E8 05 42 02 00 00 00', 0x02), null);
  assert.deepStrictEqual(d.parseFreezeFrame('7E8 05 42 0C 00 21 98', 0x0c), { rpm: 2150 });
  assert.deepStrictEqual(d.parseFreezeFrame('7E8 04 42 05 00 7B', 0x05), { coolant: 83 });
  assert.strictEqual(d.parseFreezeFrame('NO DATA', 0x05), null);
});

test('mode 03 with no codes', () => {
  assert.deepStrictEqual(d.parseObdDtcs('7E8 02 43 00', 0x03), []);
});

test('mode 03 with codes', () => {
  assert.deepStrictEqual(d.parseObdDtcs('7E8 06 43 02 03 01 01 19', 0x03).map((x) => x.code), ['P0301', 'P0119']);
});

test('multi-frame VIN', () => {
  const raw = join('7E8 10 14 49 02 01 57 41 55', '7E8 21 5A 5A 5A 38 58 34 47', '7E8 22 42 30 31 32 33 34 35');
  assert.strictEqual(d.parseVin(raw), 'WAUZZZ8X4GB012345');
});

test('coolant, rpm, voltage', () => {
  assert.strictEqual(d.parseCoolant('7E8 03 41 05 3F'), 23);
  assert.strictEqual(d.parseRpm('7E8 04 41 0C 00 00'), 0);
  assert.strictEqual(d.parseVoltage('11.7V'), 11.7);
});

test('mode 06 misfire counters', () => {
  const cyl1 = join('7E8 10 13 46 A2 0B 24 00 37', '7E8 21 00 00 FF FF A2 0C 24', '7E8 22 00 00 00 00 FF FF AA');
  assert.deepStrictEqual(d.parseMisfire(cyl1, 0xa2), { recent: 55, current: 0 });
});

test('UDS fault list skips pending (0x78) and decodes VAG numbers', () => {
  const raw = join(
    '7E8 03 7F 19 78',
    '7E8 10 0F 59 02 FF 00 3A E2',
    '7E8 21 60 00 3B 15 60 00 40',
    '7E8 22 77 65 AA AA AA AA AA',
  );
  const reply = d.finalReply(raw, 0x19);
  assert.ok(reply.ok);
  const faults = d.parseUdsDtcs(reply.data).map(({ dtc, status }) => ({ ...d.vagDtcId(dtc), status }));
  assert.deepStrictEqual(faults.map((f) => f.number), ['15074', '15125', '16503']);
  assert.strictEqual(faults[2].sae, 'P0119');
  assert.deepStrictEqual(d.describeStatus(0x65), ['failing now', 'pending', 'failed since clear']);
  assert.strictEqual(describe(faults[0]), 'Cylinder disabled (P130A)');
});

test('busy negative response is reported', () => {
  const reply = d.finalReply('77F 03 7F 19 21', 0x19);
  assert.deepStrictEqual([reply.ok, reply.nrc], [false, 0x21]);
});

test('"not tested" statuses are not real faults', () => {
  assert.strictEqual(d.isReal(0x10), false);
  assert.strictEqual(d.isReal(0x50), false);
  assert.strictEqual(d.isReal(0x08), true);
  assert.strictEqual(d.isReal(0x60), true);
});

test('long first frame length (0x10F) reassembles', () => {
  const msgs = d.parseMessages(join('776 11 0F 59 02 19 00 02 04', '776 21 10 01 7C 04 10 01 7C'));
  assert.deepStrictEqual(msgs[0].data.slice(0, 7), [0x59, 0x02, 0x19, 0x00, 0x02, 0x04, 0x10]);
});

test('VAG extended data: mileage and timestamp', () => {
  const raw = join(
    '7E8 03 7F 19 78',
    '7E8 10 3C 59 06 00 40 77 65',
    '7E8 21 01 02 01 02 FF 01 4A',
    '7E8 22 D0 00 00 6A B4 75 38',
    '7E8 23 70 2A 48 3C 59 87 3D',
    '7E8 24 64 39 FB 71 20 96 28',
    '7E8 25 11 0E 03 11 80 0A 94',
    '7E8 26 11 DC 02 4B 20 2F 0D',
    '7E8 27 FD 11 EC 02 11 DB 03',
    '7E8 28 B3 13 2D 07 AE AA AA',
  );
  const ext = d.parseVagExtData(d.finalReply(raw, 0x19).data);
  assert.strictEqual(ext.mileageKm, 84688);
  assert.strictEqual(ext.time, '2026-10-26 07:20:56');
});

test('non-zero high byte uses SAE form', () => {
  assert.deepStrictEqual(d.vagDtcId([0xc2, 0x35, 0x00]), { hex: 'C23500', number: null, sae: 'U0235 00' });
});
