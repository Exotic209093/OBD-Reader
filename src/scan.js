// Full read-only scan. Never sends mode 04 or UDS 0x14 (clear), and never
// changes diagnostic session or requests security access. Clearing lives in
// clear.js and is only ever run on request.
const d = require('./decode');
const { describe } = require('./codes');
const { profileForVin } = require('./makes');

const MISFIRE_MIDS = [0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9];

// Freeze frame values read (mode 02, frame 0) when the engine stored one.
const FREEZE_PIDS = [0x0c, 0x0d, 0x04, 0x05, 0x0b, 0x11, 0x0f, 0x06, 0x07];

// Only these services may reach the car during a scan (all read-only).
// 01-0A OBD modes (not 04), 18 KWP read DTCs, 19 UDS read DTCs,
// 22 read data by id, A9 GMLAN read DTCs.
const READ_SIDS = [0x01, 0x02, 0x03, 0x06, 0x07, 0x09, 0x0a, 0x18, 0x19, 0x22, 0xa9];

// Module search range: requests go to every 11-bit id in here except
// broadcast/OBD reply ids and anything already seen as normal bus traffic.
const SEARCH_FROM = 0x600;
const SEARCH_TO = 0x7f7;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex3 = (n) => n.toString(16).toUpperCase().padStart(3, '0');

async function init(elm) {
  await elm.send('ATZ', 4000);
  for (const c of ['ATE0', 'ATL0', 'ATH1', 'ATS1', 'ATCAF1']) await elm.send(c);
}

// Connect and check the car is on 11-bit 500k CAN. Returns an error string or null.
// Tries 11-bit 500k CAN straight away (most cars) and only falls back to the
// adapter's slow protocol search when that gets no answer.
async function connect(elm) {
  await elm.send('ATSP6');
  if (d.parseMessages(await elm.send('0100', 5000)).length) return null;
  await elm.send('ATSP0');
  const probe = await elm.send('0100', 20000);
  const protocol = d.parseProtocol(await elm.send('ATDPN'));
  if (protocol && protocol !== 6) {
    return `This car talks ${d.PROTOCOLS[protocol] || `protocol ${protocol}`}. Only 11-bit 500k CAN (most cars from 2008 on) is supported so far.`;
  }
  if (!d.parseMessages(probe).length) return 'The car did not answer. Turn the ignition on and try again.';
  await elm.send('ATSP6');
  return null;
}

async function target(elm, { tx, rx }) {
  for (const c of [`ATSH${tx}`, `ATCRA${rx}`, `ATFCSH${tx}`, 'ATFCSD300000', 'ATFCSM1', 'ATST FF']) {
    await (elm.ensure ? elm.ensure(c) : elm.send(c));
  }
}

// Request with retries on "busy", on pending-only replies and on transient
// bus errors. Returns finalReply() or null when nothing answered.
async function request(elm, req, sid, tries = 3) {
  let reply = null;
  for (let i = 0; i < tries; i++) {
    const raw = await elm.send(req, 15000);
    reply = d.finalReply(raw, sid);
    if (reply && (reply.ok || reply.nrc !== 0x21)) return reply;
    if (!reply && /NO DATA/.test(raw)) return null;
    if (!reply && !/CAN ERROR|BUS ERROR|BUS BUSY|BUFFER FULL|STOPPED|RX ERROR/.test(raw)) return null;
    await sleep(300);
  }
  return reply;
}

// Each reader returns null (no answer), { ok: false, nrc } or { ok: true, dtcs }.
async function readUds(elm, mod) {
  await target(elm, mod);
  let reply = await request(elm, '19022D', 0x19);
  if (reply && !reply.ok && (reply.nrc === 0x31 || reply.nrc === 0x12)) reply = await request(elm, '1902FF', 0x19);
  if (!reply || !reply.ok) return reply && { ok: false, nrc: reply.nrc };
  return { ok: true, dtcs: d.parseUdsDtcs(reply.data).filter((x) => d.isReal(x.status)) };
}

// KWP2000 on CAN (older Ford, Toyota, Mercedes, Fiat, Renault ECUs):
// 18 02 FF 00 = all stored DTCs with their status.
async function readKwp(elm, mod) {
  await target(elm, mod);
  const reply = await request(elm, '1802FF00', 0x18);
  if (!reply || !reply.ok) return reply && { ok: false, nrc: reply.nrc };
  return { ok: true, dtcs: d.parseKwpDtcs(reply.data) };
}

// GMLAN A9 81: replies come on the module's normal id (refusals) and its UUDT
// id (DTCs), so accept both, and send raw frames (ATCAF0) since UUDT frames
// have no ISO-TP byte.
async function readGmlan(elm, mod) {
  const rx = parseInt(mod.rx, 16);
  const uudt = parseInt(mod.uudt, 16);
  const mask = 0x7ff & ~(rx ^ uudt);
  for (const c of [`ATSH${mod.tx}`, 'ATCRA', `ATCF${hex3(uudt & mask)}`, `ATCM${hex3(mask)}`, 'ATCAF0', 'ATST FF']) {
    await elm.send(c);
  }
  try {
    return d.parseGmlanDtcs(await elm.send('03A98112', 15000), mod.uudt);
  } finally {
    await elm.send('ATCAF1');
  }
}

const READERS = { uds: readUds, kwp: readKwp, gmlan: readGmlan };

async function readFaultMemory(elm, mod, profile, { extData }) {
  const base = { name: mod.name, tx: mod.tx, rx: mod.rx, ...(mod.uudt ? { uudt: mod.uudt } : {}) };
  let reply = null;
  let protocol = null;
  try {
    for (const p of profile.protocols) {
      if (p === 'gmlan' && !mod.uudt) continue;
      const r = await READERS[p](elm, mod);
      if (!r) continue;
      reply = r;
      protocol = p;
      // "Service not supported": this module speaks another protocol, try the next.
      if (r.ok || r.nrc !== 0x11) break;
    }
  } catch (err) {
    // One module hanging the adapter shouldn't lose the rest of the scan.
    return { ...base, responded: !!reply, error: `adapter error: ${err.message}`, faults: [] };
  }
  if (!reply) return { ...base, responded: false, faults: [] };
  if (!reply.ok) {
    return { ...base, responded: true, error: d.NRC[reply.nrc] || `NRC 0x${reply.nrc.toString(16)}`, faults: [] };
  }

  const faults = [];
  for (const { dtc, status } of reply.dtcs) {
    const id = profile.dtcStyle === 'vag' ? d.vagDtcId(dtc) : d.saeDtcId(dtc);
    const flags = protocol === 'uds' ? d.describeStatus(status) : d.describeOemStatus(status);
    const fault = { ...id, status, flags, description: describe(id) };
    if (extData && protocol === 'uds') {
      const ext = await request(elm, `1906${id.hex}FF`, 0x19);
      if (ext && ext.ok) Object.assign(fault, d.parseVagExtData(ext.data) || {});
    }
    faults.push(fault);
  }
  return { ...base, responded: true, protocol, faults };
}

// Find diagnostic modules the make profile doesn't list. Listens to the bus
// first and never sends on an id the car already uses, then asks each
// remaining id for its DTC count (UDS 19 01, read-only, single-frame reply).
async function searchModules(elm, known, onStep) {
  await elm.send('ATCRA');
  const busy = new Set(d.frameIds(await elm.monitor(1500)));
  for (const c of ['ATCF600', 'ATCM600', 'ATAT0', 'ATST 10']) await elm.send(c);

  const found = [];
  const replyIds = new Set(known);
  try {
    for (let tx = SEARCH_FROM; tx <= SEARCH_TO; tx++) {
      const id = hex3(tx);
      if (tx === 0x7df || (tx >= 0x7e0 && tx <= 0x7ef) || busy.has(id) || replyIds.has(id)) continue;
      if ((tx & 0x3f) === 0) onStep(`Searching for modules (${id})`);
      await elm.send(`ATSH${id}`);
      const raw = await elm.send('1901FF', 3000);
      const ids = [...new Set(d.parseMessages(raw).filter((m) => m.data[0] === 0x59 || (m.data[0] === 0x7f && m.data[1] === 0x19)).map((m) => m.id))];
      // More than one answer means a group (functional) address: not a module.
      if (ids.length !== 1 || replyIds.has(ids[0]) || busy.has(ids[0])) continue;
      replyIds.add(ids[0]);
      found.push({ tx: id, rx: ids[0] });
    }
  } finally {
    await elm.send('ATAT1');
    await elm.send('ATCRA');
  }
  return found;
}

// Module's own name (UDS 22 F197) for modules found by the search.
async function moduleName(elm, mod) {
  await target(elm, mod);
  const reply = await request(elm, '22F197', 0x22, 1);
  const name = reply && reply.ok ? d.parseAsciiDid(reply.data, 0xf197) : null;
  return `${name || 'Module'} (${mod.tx})`;
}

// Engine freeze frame (mode 02, frame 0): conditions when a code was stored.
async function readFreezeFrame(elm) {
  const dtc = d.parseFreezeFrame(await elm.send('020200'), 0x02);
  if (!dtc) return null;
  const values = {};
  for (const pid of FREEZE_PIDS) {
    const hex = pid.toString(16).toUpperCase().padStart(2, '0');
    Object.assign(values, d.parseFreezeFrame(await elm.send(`02${hex}00`), pid) || {});
  }
  return { dtc, values };
}

// Adapter settings that persist until changed, keyed so ensure() can skip
// re-sending one that is already in effect.
const AT_KEY = /^AT(Z|SP|SH|CRA|FCSH|FCSD|FCSM|ST|CF|CM|CAF|AT)/;

// Wraps the adapter so every car-bound request is checked against an
// allowlist of services and recorded (header, command, reply, ms) for replay.
function recorder(elm, transcript, allowed = READ_SIDS) {
  let header = '7DF';
  let caf = true;
  const settings = new Map();
  const track = (cmd, out) => {
    const key = (cmd.match(AT_KEY) || [])[1];
    if (!key) return;
    if (key === 'Z') return settings.clear();
    // The receive filter and the CF/CM filter overwrite each other.
    if (key === 'CRA') settings.delete('CF'), settings.delete('CM');
    if (key === 'CF' || key === 'CM') settings.delete('CRA');
    if (/\?/.test(out)) settings.delete(key);
    else settings.set(key, cmd);
  };
  const rec = {
    async send(cmd, timeoutMs) {
      const isAt = cmd.startsWith('AT');
      if (!isAt) {
        // With ATCAF0 the first byte is the ISO-TP length, the service is next.
        const sid = parseInt(caf ? cmd.slice(0, 2) : cmd.slice(2, 4), 16);
        if (!allowed.includes(sid)) throw new Error(`Refusing to send ${cmd}: service not allowed here`);
      }
      const started = Date.now();
      const out = await elm.send(cmd, timeoutMs);
      if (isAt) track(cmd, out);
      if (cmd.startsWith('ATSH')) header = cmd.slice(4);
      else if (cmd.startsWith('ATCAF')) caf = cmd.endsWith('1');
      else if (!isAt) transcript.push([header, cmd, out, Date.now() - started]);
      return out;
    },
    // Send an adapter setting only if it isn't already in effect.
    async ensure(cmd) {
      const key = (cmd.match(AT_KEY) || [])[1];
      if (key && settings.get(key) === cmd) return 'OK';
      return rec.send(cmd);
    },
    async monitor(ms) {
      const started = Date.now();
      const out = await elm.monitor(ms);
      transcript.push(['BUS', 'ATMA', out, Date.now() - started]);
      return out;
    },
  };
  return rec;
}

// options.search: look for modules beyond the make's known list on every address.
// options.memory(vin): what earlier scans of this car learned (see
//   History.carMemory): { found: modules the last search found, or null if this
//   car was never searched; silent: profile module tx ids that never answer }.
//   With it, a car's first scan searches every address on its own and later
//   scans read the remembered modules directly and skip the silent ones.
async function scan(adapter, onProgress = () => {}, { search = false, memory = null } = {}) {
  const report = { startedAt: new Date().toISOString() };
  const transcript = [];
  const timings = [];
  const elm = recorder(adapter, transcript);
  let current = null;
  const step = (label) => {
    const now = Date.now();
    if (current) timings.push({ step: current.label, ms: now - current.at });
    current = { label, at: now };
    onProgress(label);
  };

  step('Resetting adapter');
  await init(elm);
  report.adapter = (await elm.send('ATI')).trim();
  report.voltage = d.parseVoltage(await elm.send('ATRV'));

  step('Connecting to car');
  const error = await connect(elm);
  if (error) {
    report.error = error;
    return report;
  }
  await elm.send('ATSH7DF');
  await elm.send('ATCRA7E8');

  step('Reading engine status');
  const engine = {};
  engine.monitor = d.parseMonitorStatus(await elm.send('0101'));
  engine.coolantC = d.parseCoolant(await elm.send('0105'));
  engine.rpm = d.parseRpm(await elm.send('010C'));
  report.vin = d.parseVin(await elm.send('0902'));
  const profile = profileForVin(report.vin);
  report.make = { profile: profile.id, label: profile.label, name: profile.make, tool: profile.tool, verified: profile.verified };
  engine.stored = d.parseObdDtcs(await elm.send('03'), 0x03);
  engine.pending = d.parseObdDtcs(await elm.send('07'), 0x07);
  engine.permanent = d.parseObdDtcs(await elm.send('0A'), 0x0a);
  engine.freezeFrame = await readFreezeFrame(elm);

  step('Reading misfire counters');
  engine.misfires = [];
  for (const [i, mid] of MISFIRE_MIDS.entries()) {
    const m = d.parseMisfire(await elm.send(`06${mid.toString(16).toUpperCase()}`), mid);
    if (!m) break;
    engine.misfires.push({ cylinder: i + 1, ...m });
  }
  // Some ECUs list the misfire monitors but not the counters we decode.
  if (engine.misfires.every((m) => m.recent === null && m.current === null)) engine.misfires = [];

  step('Reading engine fault memory');
  engine.memory = await readFaultMemory(elm, profile.engine, profile, { extData: profile.extData });
  report.engine = engine;

  const mem = memory ? memory(report.vin) : null;
  const silent = new Set(!search && mem ? mem.silent : []);
  report.modules = [];
  for (const mod of profile.modules) {
    if (silent.has(mod.tx)) {
      report.modules.push({ name: mod.name, tx: mod.tx, rx: mod.rx, ...(mod.uudt ? { uudt: mod.uudt } : {}), responded: false, skipped: true, faults: [] });
      continue;
    }
    step(`Reading ${mod.name}`);
    report.modules.push(await readFaultMemory(elm, mod, profile, { extData: false }));
  }

  let extra = null;
  if (search || (mem && mem.found === null)) {
    const known = [profile.engine, ...profile.modules].flatMap((m) => [m.tx, m.rx]);
    const found = await searchModules(elm, known, step);
    report.search = { found: found.length };
    extra = [];
    for (const addr of found) extra.push({ ...addr, name: await moduleName(elm, addr) });
  } else if (mem && mem.found) {
    extra = mem.found;
    report.search = { found: extra.length, remembered: true };
  }
  for (const mod of extra || []) {
    step(`Reading ${mod.name}`);
    report.modules.push({ ...(await readFaultMemory(elm, mod, profile, { extData: false })), found: true });
  }

  await elm.send('ATFCSM0');
  await elm.send('ATCRA');
  step('Done');
  report.transcript = transcript;
  report.timings = timings;
  report.finishedAt = new Date().toISOString();
  return report;
}

module.exports = { scan, init, connect, target, request, recorder, READ_SIDS };
