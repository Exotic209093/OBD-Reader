const test = require('node:test');
const assert = require('node:assert');
const { scan } = require('../src/scan');
const { ReplayElm } = require('../src/replay');

test('full scan against replayed S1 data', async () => {
  const elm = new ReplayElm();
  const sent = [];
  const send = elm.send.bind(elm);
  elm.send = (cmd, t) => (sent.push(cmd), send(cmd, t));

  const r = await scan(elm);

  assert.ok(!sent.some((c) => c === '04' || c.startsWith('14')), 'must never send clear commands');
  assert.strictEqual(r.vin, 'WAUZZZ8X4GB012345');
  assert.strictEqual(r.voltage, 11.7);
  assert.deepStrictEqual([r.engine.monitor.mil, r.engine.monitor.dtcCount, r.engine.monitor.ignition], [false, 0, 'spark']);
  // 01 01 = 00 07 E1 21: catalyst and oxygen sensor tests not finished.
  assert.deepStrictEqual(r.engine.monitor.readiness.filter((m) => !m.complete).map((m) => m.name), ['Catalyst', 'Oxygen sensor']);
  assert.strictEqual(r.engine.monitor.readiness.length, 7);
  assert.deepStrictEqual(r.engine.misfires.map((m) => m.recent), [55, 1, 2, 1]);

  const faults = r.engine.memory.faults;
  assert.deepStrictEqual(faults.map((f) => f.number), ['15074', '15125', '16503']);
  assert.deepStrictEqual(faults.map((f) => f.mileageKm), [84685, 84685, 84688]);
  assert.strictEqual(faults[0].time, '2026-10-26 07:18:32');
  assert.strictEqual(faults[2].time, '2026-10-26 07:20:56');

  const byName = Object.fromEntries(r.modules.map((m) => [m.name, m]));
  assert.deepStrictEqual(byName['03 ABS / ESC'].faults.map((f) => f.number), ['00625', '00909']);
  for (const name of ['15 Airbags', '17 Instruments', '44 Power steering', '46 Comfort', '16 Steering column']) {
    assert.strictEqual(byName[name].faults.length, 0, name);
  }
  assert.strictEqual(byName['19 Gateway'].responded, false);
});

// Read-only guard: car-bound commands may only be OBD modes 01-0A (not 04),
// KWP 18 / UDS 19 (read DTCs), UDS 22 (read data) or GMLAN A9 (read DTCs,
// sent raw with its length byte).
const READ_ONLY = /^(?:0[1235-9A][0-9A-F]*|1[89][0-9A-F]+|22[0-9A-F]+|03A9[0-9A-F]+)$/;
const notReadOnly = (sent) => sent.filter((c) => !c.startsWith('AT') && !READ_ONLY.test(c));

test('S1 scan is recognised as VAG and only sends read-only services', async () => {
  const elm = new ReplayElm();
  const sent = [];
  const send = elm.send.bind(elm);
  elm.send = (cmd, t) => (sent.push(cmd), send(cmd, t));
  const r = await scan(elm);
  assert.deepStrictEqual(r.make, { profile: 'vag', label: 'VW Group', name: 'Audi', tool: 'VCDS or OBDeleven', verified: true });
  assert.deepStrictEqual(notReadOnly(sent), []);
  assert.ok(!sent.includes('03A98112'), 'VAG scan should not try GMLAN');
});

test('saved transcript replays to the same result', async () => {
  const first = await scan(new ReplayElm());
  const again = await scan(ReplayElm.fromTranscript(first.transcript));
  const faults = (r) => [r.engine.memory, ...r.modules].map((m) => [m.name, m.faults.map((f) => f.hex)]);
  assert.deepStrictEqual(faults(again), faults(first));
  assert.deepStrictEqual(again.engine.misfires, first.engine.misfires);
});

// Synthetic GM replies shaped like the 2013 Zafira's real ones (UDS 19 refused
// with NRC 11, P0134 pending). The GMLAN fault list is not a real capture yet.
const R = (...lines) => lines.join('\r');
const GM = {
  ATI: 'ELM327 v1.4b',
  ATRV: '12.2V',
  '7DF:0100': R('SEARCHING...', '7E8 06 41 00 BE 3F A8 13'),
  '7DF:0101': '7E8 06 41 01 00 07 E5 00',
  '7DF:0105': '7E8 03 41 05 34',
  '7DF:010C': '7E8 04 41 0C 00 00',
  '7DF:0902': R('7E8 10 14 49 02 01 57 30 4C', '7E8 21 30 41 48 4D 37 35 44', '7E8 22 31 32 33 34 35 36 37'),
  '7DF:03': '7E8 02 43 00',
  '7DF:07': '7E8 04 47 01 01 34',
  '7DF:06A2': '7E8 03 46 A2 00',
  '7E0:19022D': '7E8 03 7F 19 11',
  '7E0:03A98112': R('5E8 81 01 34 00 0A', '5E8 81 04 20 71 8A', '5E8 81 00 00 00 FF'),
  '243:19022D': '643 03 7F 19 11',
  '243:03A98112': R('543 81 C1 21 00 0A', '543 81 00 00 00 FF'),
  '247:19022D': '647 03 7F 19 11',
  '247:03A98112': '547 81 00 00 00 FF',
};

test('Vauxhall scan falls back to GMLAN and stays read-only', async () => {
  const elm = new ReplayElm(() => {}, 0, GM);
  const sent = [];
  const send = elm.send.bind(elm);
  elm.send = (cmd, t) => (sent.push(cmd), send(cmd, t));
  const r = await scan(elm);

  assert.strictEqual(r.vin, 'W0L0AHM75D1234567');
  assert.strictEqual(r.make.profile, 'gm');
  assert.deepStrictEqual(r.engine.pending, [{ ecu: '7E8', code: 'P0134' }]);
  assert.deepStrictEqual(r.engine.misfires, [], 'unreadable misfire monitors are dropped');

  const e = r.engine.memory;
  assert.strictEqual(e.name, 'Engine (ECM)');
  assert.strictEqual(e.protocol, 'gmlan');
  assert.deepStrictEqual(e.faults.map((f) => f.sae), ['P0134', 'P0420 71']);
  assert.deepStrictEqual(e.faults[1].flags, ['reported', 'warning lamp']);

  const byName = Object.fromEntries(r.modules.map((m) => [m.name, m]));
  assert.deepStrictEqual(byName['ABS / ESP (EBCM)'].faults.map((f) => f.sae), ['U0121']);
  assert.deepStrictEqual(byName['Airbags (SDM)'], { name: 'Airbags (SDM)', tx: '247', rx: '647', uudt: '547', responded: true, protocol: 'gmlan', faults: [] });
  assert.strictEqual(byName['Transmission (TCM)'].responded, false);
  assert.ok(!r.modules.some((m) => m.name.startsWith('03 ')), 'no VAG modules on a Vauxhall');

  // GMLAN is sent as a raw frame; adapter must be put back into ISO-TP mode.
  const i = sent.indexOf('03A98112');
  assert.ok(sent.lastIndexOf('ATCAF0', i) > sent.lastIndexOf('ATCAF1', i));
  assert.strictEqual(sent[i + 1], 'ATCAF1');
  assert.deepStrictEqual(notReadOnly(sent), []);
});

test('makes are picked from the VIN', () => {
  const { profileForVin, MAKES } = require('../src/makes');
  assert.strictEqual(profileForVin('W0L0AHM75D1234567').make, 'Vauxhall / Opel');
  assert.strictEqual(profileForVin('VXKUBYHTKL4123456').id, 'generic', 'Stellantis Vauxhalls are not GM');
  assert.strictEqual(profileForVin('WF0XXXGCDX1234567').id, 'ford');
  assert.strictEqual(profileForVin('KNAJ3811AH1234567').id, 'hyundaiKia');
  const bmw = profileForVin('WBA8E11080K123456');
  assert.deepStrictEqual([bmw.id, bmw.make, bmw.tool], ['generic', 'BMW', 'ISTA, BimmerLink or Carly']);
  const unknown = profileForVin('XXX12345678901234');
  assert.deepStrictEqual([unknown.id, unknown.make], ['generic', null]);
  assert.deepStrictEqual(profileForVin(null).modules.map((m) => m.tx), ['7E1']);
  const wmis = MAKES.flatMap((m) => m[3]);
  assert.strictEqual(new Set(wmis).size, wmis.length, 'each WMI maps to one make');
});

test('cars on another OBD protocol get a clear message', async () => {
  const elm = new ReplayElm(() => {}, 0, { ATDPN: 'A3', '7DF:0100': '48 6B 10 41 00 BE 1F B8 10 AA' });
  const r = await scan(elm);
  assert.match(r.error, /ISO 9141-2/);
});

test('Ford scan reads Ford module addresses with UDS', async () => {
  const elm = new ReplayElm(() => {}, 0, {
    '7DF:0100': '7E8 06 41 00 BE 3F A8 13',
    // Synthetic: VIN WF0XXXGCDX1234567, ABS with C0040 confirmed.
    '7DF:0902': R('7E8 10 14 49 02 01 57 46 30', '7E8 21 58 58 58 47 43 44 58', '7E8 22 31 32 33 34 35 36 37'),
    '760:19022D': '768 07 59 02 FF 40 40 00 08',
  });
  const r = await scan(elm);
  assert.strictEqual(r.make.name, 'Ford');
  const abs = r.modules.find((m) => m.name === 'ABS / ESP');
  assert.deepStrictEqual(abs.faults.map((f) => f.sae), ['C0040']);
  assert.strictEqual(r.engine.memory.responded, false);
});

// Synthetic Hyundai-style car for the module search: one module the profile
// doesn't list (7A3 -> 7AB) and one id (7B0) that is normal bus traffic.
const SEARCH = {
  '7DF:0100': '7E8 06 41 00 BE 3F A8 13',
  '7DF:0902': R('7E8 10 14 49 02 01 4B 4E 41', '7E8 21 4A 33 38 31 31 41 48', '7E8 22 31 32 33 34 35 36 37'),
  ATMA: R('7B0 08 00 11 22 33 44 55 66', '1A0 02 10 20'),
  '7A3:1901FF': '7AB 06 59 01 FF 01 00 01',
  '7A3:22F197': R('7AB 10 0B 62 F1 97 53 4D 4B', '7AB 21 20 55 4E 49 54 00 00'),
  '7A3:19022D': '7AB 07 59 02 FF 9A 11 00 08',
  '7B0:1901FF': '7B8 06 59 01 FF 01 00 01',
  '700:1901FF': R('7A8 06 59 01 FF 01 00 00', '7AB 06 59 01 FF 01 00 01'),
};

test('module search finds unlisted modules and stays off normal traffic ids', async () => {
  const elm = new ReplayElm(() => {}, 0, SEARCH);
  const sent = [];
  let header = '7DF';
  const send = elm.send.bind(elm);
  elm.send = (cmd, t) => {
    if (cmd.startsWith('ATSH')) header = cmd.slice(4);
    else sent.push(`${header}:${cmd}`);
    return send(cmd, t);
  };
  const r = await scan(elm, () => {}, { search: true });

  assert.ok(!sent.includes('7B0:1901FF'), 'must not transmit on an id seen on the bus');
  assert.ok(!sent.some((c) => c.startsWith('7DF:19') || c.startsWith('1A0:')));
  const found = r.modules.filter((m) => m.found);
  assert.deepStrictEqual(found.map((m) => [m.name, m.tx, m.rx]), [['SMK UNIT (7A3)', '7A3', '7AB']]);
  assert.deepStrictEqual(found[0].faults.map((f) => f.sae), ['B1A11']);
  assert.strictEqual(r.search.found, 1);
  assert.deepStrictEqual(notReadOnly(sent.map((c) => c.slice(4))), []);
  // Search state is undone so later commands use normal timing and filters.
  const at = (c) => sent.findIndex((s) => s.endsWith(`:${c}`));
  assert.ok(at('ATAT0') >= 0 && at('ATAT1') > at('ATAT0'));
});

test('KWP2000 modules are read when UDS is refused', async () => {
  const elm = new ReplayElm(() => {}, 0, {
    '7DF:0100': '7E8 06 41 00 BE 3F A8 13',
    '7E0:19022D': '7E8 03 7F 19 11',
    '7E0:1802FF00': '7E8 08 58 02 01 71 E0 04 20 20',
  });
  const r = await scan(elm);
  assert.strictEqual(r.engine.memory.protocol, 'kwp');
  assert.deepStrictEqual(r.engine.memory.faults.map((f) => f.sae), ['P0171', 'P0420']);
  assert.deepStrictEqual(r.engine.memory.faults[0].flags, ['reported', 'warning lamp']);
});
