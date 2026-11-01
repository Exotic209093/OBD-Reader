// Clearing uses synthetic replies (nothing has been cleared on a real car yet).
const test = require('node:test');
const assert = require('node:assert');
const { clearFaults } = require('../src/clear');
const { ReplayElm } = require('../src/replay');

const R = (...lines) => lines.join('\r');
const REPLIES = {
  '7DF:0100': '7E8 06 41 00 BE 3F A8 13',
  '7DF:04': R('7E8 01 44', '7E9 01 44'),
  '713:14FFFFFF': R('77D 03 7F 14 78', '77D 01 54'),
  '715:14FFFFFF': '77F 03 7F 14 22',
  '7E0:14FF00': '7E8 01 54',
  '243:04': '643 01 44',
};

function recording(replies = REPLIES) {
  const elm = new ReplayElm(() => {}, 0, replies);
  const sent = [];
  let header = '7DF';
  const send = elm.send.bind(elm);
  elm.send = (cmd, t) => {
    if (cmd.startsWith('ATSH')) header = cmd.slice(4);
    else if (!cmd.startsWith('AT')) sent.push(`${header}:${cmd}`);
    return send(cmd, t);
  };
  return { elm, sent };
}

test('clears only the chosen modules with each one\'s protocol', async () => {
  const { elm, sent } = recording();
  const res = await clearFaults(elm, {
    engine: true,
    modules: [
      { name: '03 ABS / ESC', tx: '713', rx: '77D', protocol: 'uds' },
      { name: '15 Airbags', tx: '715', rx: '77F', protocol: 'uds' },
      { name: 'Old ECU', tx: '7E0', rx: '7E8', protocol: 'kwp' },
      { name: 'ABS / ESP (EBCM)', tx: '243', rx: '643', protocol: 'gmlan' },
      { name: 'Silent', tx: '7A0', rx: '7A8', protocol: 'uds' },
    ],
  });
  assert.deepStrictEqual(sent.filter((c) => !c.endsWith(':0100')), ['7DF:04', '713:14FFFFFF', '715:14FFFFFF', '7E0:14FF00', '243:04', '7A0:14FFFFFF']);
  assert.deepStrictEqual(res.results, [
    { name: 'Engine (OBD)', ok: true },
    { name: '03 ABS / ESC', ok: true },
    { name: '15 Airbags', ok: false, error: 'refused: conditions not correct (switch the engine off, ignition on)' },
    { name: 'Old ECU', ok: true },
    { name: 'ABS / ESP (EBCM)', ok: true },
    { name: 'Silent', ok: false, error: 'no answer' },
  ]);
});

test('engine-only clear sends just mode 04', async () => {
  const { elm, sent } = recording();
  await clearFaults(elm, { engine: true, modules: [] });
  assert.deepStrictEqual(sent, ['7DF:0100', '7DF:04']);
});

test('rejects bad targets before talking to the car', async () => {
  for (const bad of [
    { engine: 'yes', modules: [] },
    { engine: false, modules: [{ name: 'x', tx: '7E0', rx: '7E8', protocol: 'reset' }] },
    { engine: false, modules: [{ name: 'x', tx: '7E0;ATZ', rx: '7E8', protocol: 'uds' }] },
  ]) {
    const { elm, sent } = recording();
    await assert.rejects(clearFaults(elm, bad));
    assert.deepStrictEqual(sent, []);
  }
});
