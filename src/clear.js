// Clears stored fault codes, only when the user asks for it from the app.
// Uses the same protocol each module was read with; no session or security
// changes, so modules that only allow clearing in a dealer session refuse
// and say so.
const d = require('./decode');
const { init, connect, target, request, recorder, READ_SIDS } = require('./scan');

// Clear services: 04 OBD/GMLAN clear, 14 UDS/KWP clear.
const CLEAR_SIDS = [...READ_SIDS, 0x04, 0x14];

const CLEARERS = {
  uds: { req: '14FFFFFF', sid: 0x14 },
  kwp: { req: '14FF00', sid: 0x14 },
  gmlan: { req: '04', sid: 0x04 },
};

const HEX3 = /^[0-9A-F]{3}$/;

// Targets come from the renderer, so check them before anything is sent.
function checkTargets({ engine, modules = [] }) {
  if (typeof engine !== 'boolean') throw new Error('Bad clear request');
  for (const m of modules) {
    if (!m || typeof m.name !== 'string' || !HEX3.test(m.tx) || !HEX3.test(m.rx) || !CLEARERS[m.protocol]) {
      throw new Error(`Can't clear ${m && m.name}: unknown address or protocol`);
    }
  }
}

function outcome(name, reply) {
  if (!reply) return { name, ok: false, error: 'no answer' };
  if (reply.ok) return { name, ok: true };
  const why = {
    0x22: 'refused: conditions not correct (switch the engine off, ignition on)',
    0x33: 'refused: needs security access (use a dealer tool)',
    0x7e: 'refused: needs a dealer diagnostic session',
    0x7f: 'refused: needs a dealer diagnostic session',
  }[reply.nrc];
  return { name, ok: false, error: why || `refused (${d.NRC[reply.nrc] || `NRC 0x${reply.nrc.toString(16)}`})` };
}

// targets: { engine: bool (OBD mode 04 to all engine/emissions ECUs),
//            modules: [{ name, tx, rx, protocol }] from a scan report }
async function clearFaults(adapter, targets, onProgress = () => {}) {
  checkTargets(targets);
  const transcript = [];
  const elm = recorder(adapter, transcript, CLEAR_SIDS);
  await init(elm);
  const error = await connect(elm);
  if (error) throw new Error(error);

  const results = [];
  if (targets.engine) {
    onProgress('Clearing engine codes');
    await elm.send('ATSH7DF');
    await elm.send('ATCRA');
    results.push(outcome('Engine (OBD)', await request(elm, '04', 0x04)));
  }
  for (const m of targets.modules) {
    onProgress(`Clearing ${m.name}`);
    try {
      await target(elm, m);
      const { req, sid } = CLEARERS[m.protocol];
      results.push(outcome(m.name, await request(elm, req, sid)));
    } catch (err) {
      results.push({ name: m.name, ok: false, error: `adapter error: ${err.message}` });
    }
  }
  await elm.send('ATFCSM0');
  await elm.send('ATCRA');
  return { at: new Date().toISOString(), results, transcript };
}

module.exports = { clearFaults, CLEAR_SIDS };
