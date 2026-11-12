// Coding (feature unlocking): read module coding, plan changes, and write
// them with a backup first and a read-back after. The only path in the app
// that writes to the car. Design and safety rules: docs/coding.md.
const d = require('./decode');
const isotp = require('./isotp');
const { init, connect, target, request, recorder, READ_SIDS } = require('./scan');
const cat = require('./codingCatalog');

// Services coding may use on top of the read-only ones. codingAllowed() is
// what's enforced: it also checks sub-functions, addresses and DIDs.
const CODE_SIDS = [...READ_SIDS, 0x10, 0x2e, 0x3e];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const h2 = (b) => b.toString(16).toUpperCase().padStart(2, '0');
const nrcName = (nrc) => d.NRC[nrc] || `NRC 0x${h2(nrc)}`;

// tx -> DIDs that may be written there: codeable modules of a platform that
// can be written, and only their listed DIDs.
function writableDids(platform, features) {
  const out = new Map();
  if (!cat.canWrite(platform)) return out;
  for (const mod of platform.modules) {
    if (cat.isCodeable(platform, mod)) out.set(mod.tx.toUpperCase(), new Set(cat.moduleDids(platform, mod, features)));
  }
  return out;
}

// Allowlist predicate for recorder(): read-only services anywhere; 10 01 /
// 10 03, 3E 00 and 2E only to a codeable module of a writable platform, 2E
// only for that module's DIDs. 27 (security access) stays refused until a
// platform's scheme is implemented; 04/14/11/28/31/34-37/85 are never allowed.
function codingAllowed(platform, features = platform ? cat.featuresFor(platform.id) : []) {
  const writable = writableDids(platform, features);
  return (bytes, header) => {
    const [sid] = bytes;
    if (READ_SIDS.includes(sid)) return true;
    const dids = writable.get(String(header).toUpperCase());
    if (!dids) return false;
    if (sid === 0x10) return bytes.length === 2 && (bytes[1] === 0x01 || bytes[1] === 0x03);
    if (sid === 0x3e) return bytes.length === 2 && bytes[1] === 0x00;
    if (sid === 0x2e) return bytes.length > 3 && dids.has((bytes[1] << 8) | bytes[2]);
    return false;
  };
}

// Plain-English reasons a module refuses a session change or write.
const WRITE_NRC = {
  0x13: 'refused: wrong length for this module',
  0x21: 'refused: module busy, try again',
  0x22: 'refused: conditions not correct (switch the engine off, ignition on)',
  0x31: 'refused: value out of range for this module',
  0x33: 'refused: needs security access / login (not supported yet)',
  0x72: "refused: the module couldn't store it",
  0x7e: 'refused: needs a different diagnostic session',
  0x7f: 'refused: needs a different diagnostic session',
};
const writeError = (nrc) => WRITE_NRC[nrc] || `refused (${nrcName(nrc)})`;

// 22 <did> -> { hex } (data only, no 62/DID prefix) or { error }.
async function readDid(elm, did, tries = 3) {
  const reply = await request(elm, `22${cat.didHex(did)}`, 0x22, tries);
  if (!reply) return { error: 'no answer' };
  if (!reply.ok) return { error: nrcName(reply.nrc) };
  if (reply.data.length < 4 || ((reply.data[1] << 8) | reply.data[2]) !== did) return { error: 'unexpected reply' };
  return { hex: isotp.toHex(reply.data.slice(3)) };
}

async function readText(elm, did) {
  const reply = await request(elm, `22${cat.didHex(did)}`, 0x22, 1);
  return reply && reply.ok ? d.parseAsciiDid(reply.data, did) : null;
}

// One module: identification (22 F187 part number, F189 software version,
// F197 system name; refusals are fine) and every DID on the coding list.
async function readModule(elm, platform, mod, features) {
  const out = { key: mod.key, name: mod.name, tx: mod.tx, rx: mod.rx, codeable: cat.isCodeable(platform, mod), responded: false, data: {} };
  try {
    await target(elm, mod);
    const ident = await request(elm, '22F187', 0x22, 1);
    if (!ident) return out;
    out.responded = true;
    out.partNo = ident.ok ? d.parseAsciiDid(ident.data, 0xf187) : null;
    out.swVersion = await readText(elm, 0xf189);
    out.systemName = await readText(elm, 0xf197);
    for (const did of cat.moduleDids(platform, mod, features)) {
      const r = await readDid(elm, did);
      if (r.hex) out.data[cat.didHex(did)] = r.hex;
      else (out.unreadable || (out.unreadable = {}))[cat.didHex(did)] = r.error || 'empty';
    }
  } catch (err) {
    // One module hanging the adapter shouldn't lose the others.
    out.error = `adapter error: ${err.message}`;
  }
  return out;
}

// Whether a feature's location fits this car's module (part number pattern).
const fitsPart = (f, m) => !f.partNumbers || Boolean(m.partNo && new RegExp(f.partNumbers).test(m.partNo));

// current = the option matching data[byte] & mask (null if none);
// available = it can be shown and changed on this car, else reason says why.
function featureState(platform, f, modules) {
  const no = (reason, current = null) => ({ current, available: false, reason });
  const problems = cat.featureProblems(f, platform);
  if (problems.length) return no(`catalogue entry is invalid: ${problems[0]}`);
  const m = (modules || []).find((x) => x.key === f.module);
  if (!m || !m.responded) return no(m && m.error ? m.error : "the module didn't answer");
  const did = cat.didHex(f.did);
  const hex = m.data && m.data[did];
  if (!hex) return no(`couldn't read data ${did}${m.unreadable && m.unreadable[did] ? ` (${m.unreadable[did]})` : ''}`);
  const bytes = isotp.fromHex(hex);
  if (f.byte >= bytes.length) return no(`the coding is ${bytes.length} bytes, this setting is at byte ${f.byte}`);
  if (!fitsPart(f, m)) return no(`not for this module (part number ${m.partNo || 'unknown'})`);
  const value = bytes[f.byte] & f.mask;
  if (!f.options.some((o) => o.value === value)) return no(`the current setting (0x${h2(value)}) isn't one this app knows`);
  return { current: value, available: true };
}

const platformSummary = (p) => ({ id: p.id, label: p.label, writable: cat.canWrite(p), verified: p.verified === true, security: p.security || null, protocol: p.protocol });

// Reads the car's coding. Read-only: only READ_SIDS reach the car.
// options: { platforms, features } override the catalogue (tests).
async function readCoding(adapter, onProgress = () => {}, options = {}) {
  const transcript = [];
  const elm = recorder(adapter, transcript, READ_SIDS);
  const reading = { at: new Date().toISOString(), vin: null, voltage: null, adapter: null, stn: false, platform: null, modules: [], features: [], transcript };

  onProgress('Resetting adapter');
  await init(elm);
  const ati = (await elm.send('ATI')).trim();
  const sti = (await elm.send('STI')).trim();
  reading.stn = elm.stn === true;
  reading.adapter = reading.stn ? `${sti} (${ati})` : ati;
  reading.voltage = d.parseVoltage(await elm.send('ATRV'));

  onProgress('Connecting to car');
  const error = await connect(elm);
  if (error) return { ...reading, error };
  await elm.send('ATSH7DF');
  await elm.send('ATCRA7E8');
  reading.vin = d.parseVin(await elm.send('0902'));
  const platform = cat.platformForVin(reading.vin, options.platforms);
  if (platform) {
    const features = cat.featuresFor(platform.id, options.features);
    reading.platform = platformSummary(platform);
    for (const mod of platform.modules) {
      onProgress(`Reading ${mod.name}`);
      reading.modules.push(await readModule(elm, platform, mod, features));
    }
    reading.features = features.map((f) => ({ ...f, ...featureState(platform, f, reading.modules) }));
  }
  await elm.send('ATFCSM0');
  await elm.send('ATCRA');
  onProgress('Done');
  return reading;
}

function parseDid(did) {
  if (Number.isInteger(did) && did >= 0 && did <= 0xffff) return did;
  if (typeof did === 'string' && /^[0-9A-F]{4}$/i.test(did)) return parseInt(did, 16);
  return null;
}

// Platform and features for a write, or a plain-English refusal.
function writeContext(reading, options) {
  const id = reading && reading.platform && reading.platform.id;
  const platform = id ? cat.platformById(id, options.platforms) : null;
  if (!platform) throw new Error('There is no coding list for this car, so nothing can be changed.');
  if (!cat.canWrite(platform)) throw new Error(`${platform.label} is read-only for now: writing to it hasn't been made safe yet.`);
  return { platform, features: cat.featuresFor(platform.id, options.features) };
}

// The catalogue module for a write and the DID's data from the reading.
function writeTarget(platform, features, reading, key, did) {
  const mod = platform.modules.find((m) => m.key === key);
  if (!mod) throw new Error(`Unknown module ${key}.`);
  if (!cat.isCodeable(platform, mod)) throw new Error(`${mod.name} can't be changed with this app.`);
  if (did === null || !cat.moduleDids(platform, mod, features).includes(did)) {
    throw new Error(`Data ${did === null ? '?' : cat.didHex(did)} isn't on the coding list for ${mod.name}.`);
  }
  const m = (reading.modules || []).find((x) => x.key === key);
  const hex = m && m.data && m.data[cat.didHex(did)];
  if (!hex) throw new Error(`${mod.name} data ${cat.didHex(did)} wasn't read, so it can't be changed. Read the car again.`);
  return { mod, hex };
}

// Marks which bits of a byte a change sets. Two changes that want the same
// bits different ways are refused rather than guessed.
function claim(e, byte, mask, value, who) {
  const c = e.claims[byte] || (e.claims[byte] = { mask: 0, value: 0, who: [] });
  if ((c.value ^ value) & c.mask & mask) {
    throw new Error(`${who} and ${c.who.join(', ')} change the same bits of ${e.mod.name} byte ${byte} in different ways.`);
  }
  c.mask |= mask;
  c.value = (c.value & ~mask) | (value & mask);
  c.who.push(who);
  e.after[byte] = (e.after[byte] & ~mask) | (value & mask);
}

function planItem(platform, features, reading, e) {
  const { mod, did, before, after } = e;
  const m = reading.modules.find((x) => x.key === mod.key);
  const optionLabel = (f, byte) => {
    const o = f.options.find((x) => x.value === (byte & f.mask));
    return o ? o.label : `0x${h2(byte & f.mask)}`;
  };
  // Every known setting the change touches, whether picked by feature or raw.
  const touched = features.filter(
    (f) => f.module === mod.key && f.did === did && !cat.featureProblems(f, platform).length && f.byte < before.length && fitsPart(f, m) && (before[f.byte] ^ after[f.byte]) & f.mask,
  );
  const edits = [];
  before.forEach((b, i) => {
    if (b === after[i]) return;
    const edit = { byte: i, before: b, after: after[i], features: touched.filter((f) => f.byte === i).map((f) => f.name) };
    if (e.raw.has(i)) edit.raw = true;
    edits.push(edit);
  });
  const settings = touched.map((f) => ({ id: f.id, name: f.name, before: optionLabel(f, before[f.byte]), after: optionLabel(f, after[f.byte]), verified: f.verified === true }));
  return {
    module: mod.key,
    name: mod.name,
    tx: mod.tx,
    rx: mod.rx,
    did: cat.didHex(did),
    before: isotp.toHex(before),
    after: isotp.toHex(after),
    edits,
    settings,
    unverified: settings.filter((s) => !s.verified).map((s) => s.name),
    raw: e.raw.size > 0,
  };
}

// changes: [{ featureId, value }] or raw [{ module, did, hex }] (whole DID,
// same length). Built from the main process's own reading. Changes to one
// DID merge into one write; DIDs that end up unchanged are left out.
function planChanges(reading, changes, options = {}) {
  const { platform, features } = writeContext(reading, options);
  if (!Array.isArray(changes) || !changes.length) throw new Error('No changes given.');
  const entries = new Map();
  const entry = (key, did) => {
    const id = `${key}:${did}`;
    if (!entries.has(id)) {
      const { mod, hex } = writeTarget(platform, features, reading, key, did);
      const before = isotp.fromHex(hex);
      entries.set(id, { mod, did, before, after: [...before], claims: [], raw: new Set() });
    }
    return entries.get(id);
  };
  for (const c of changes) {
    if (c && typeof c.featureId === 'string') {
      const f = features.find((x) => x.id === c.featureId);
      if (!f) throw new Error(`Unknown setting ${c.featureId}.`);
      const problems = cat.featureProblems(f, platform);
      if (problems.length) throw new Error(`${f.name || f.id} can't be used: ${problems[0]}.`);
      if (!f.options.some((o) => o.value === c.value)) throw new Error(`${f.name}: unknown option ${c.value}.`);
      const e = entry(f.module, f.did);
      const state = featureState(platform, f, reading.modules);
      if (!state.available) throw new Error(`${f.name} can't be changed: ${state.reason}.`);
      claim(e, f.byte, f.mask, c.value, f.name);
    } else if (c && typeof c.module === 'string') {
      const e = entry(c.module, parseDid(c.did));
      // A raw change states the whole DID, so two of them can't be merged.
      if (e.rawChange) throw new Error(`${e.mod.name}: only one raw change per data block.`);
      e.rawChange = true;
      const bytes = isotp.fromHex(c.hex);
      if (!bytes) throw new Error('Raw coding must be whole bytes of hex.');
      if (bytes.length !== e.before.length) {
        throw new Error(`${e.mod.name}: the coding is ${e.before.length} bytes and a change can't make it ${bytes.length}.`);
      }
      bytes.forEach((b, i) => {
        if (b === e.before[i]) return;
        claim(e, i, b ^ e.before[i], b, 'Raw coding edit');
        e.raw.add(i);
      });
    } else {
      throw new Error('Bad coding change.');
    }
  }
  return [...entries.values()].map((e) => planItem(platform, features, reading, e)).filter((it) => it.before !== it.after);
}

// Puts a saved backup back: a raw change to the whole DID, same checks.
function planRestore(reading, record, options = {}) {
  if (!record || typeof record !== 'object') throw new Error('Bad backup.');
  if (!reading || record.vin !== reading.vin) throw new Error('That backup is for a different car.');
  if (record.platform && (!reading.platform || record.platform !== reading.platform.id)) throw new Error('That backup is for a different kind of car.');
  const plan = planChanges(reading, [{ module: record.module, did: record.did, hex: record.hex }], options);
  for (const it of plan) {
    if ((record.tx && record.tx !== it.tx) || (record.rx && record.rx !== it.rx)) throw new Error(`That backup's addresses don't match ${it.name}.`);
    it.restore = { id: record.id || null, reason: record.reason || null, at: record.at || null };
  }
  return plan;
}

// Re-checks a plan against the catalogue and the reading it came from.
function checkPlan(platform, features, reading, plan) {
  if (!Array.isArray(plan)) throw new Error('Bad coding plan.');
  const seen = new Set();
  return plan.map((it) => {
    if (!it || typeof it !== 'object') throw new Error('Bad coding plan.');
    const did = parseDid(it.did);
    const { mod, hex } = writeTarget(platform, features, reading, it.module, did);
    if (seen.has(`${mod.key}:${did}`)) throw new Error(`${mod.name} data ${cat.didHex(did)} is in the plan twice.`);
    seen.add(`${mod.key}:${did}`);
    if (it.tx !== mod.tx || it.rx !== mod.rx) throw new Error(`${mod.name}: the plan's addresses don't match the coding list.`);
    if (it.before !== hex) throw new Error(`The plan for ${mod.name} wasn't built from the last reading. Read the car again.`);
    const after = isotp.fromHex(it.after);
    if (!after || after.length * 2 !== hex.length) throw new Error(`${mod.name}: the new coding must be the same length as the old.`);
    return { module: mod.key, name: mod.name, tx: mod.tx, rx: mod.rx, did: cat.didHex(did), didNum: did, before: hex, after: isotp.toHex(after), mod };
  });
}

function byModule(items) {
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.module)) groups.set(it.module, { mod: it.mod, items: [] });
    groups.get(it.module).items.push(it);
  }
  return [...groups.values()];
}

async function lowVoltage(elm, minVoltage) {
  const v = d.parseVoltage(await elm.send('ATRV'));
  if (v === null) return "the battery voltage couldn't be read";
  if (v < minVoltage) return `the battery is at ${v} V and coding needs at least ${minVoltage} V (connect a charger)`;
  return null;
}

function backupRecord(reading, it) {
  const m = reading.modules.find((x) => x.key === it.module) || {};
  return {
    vin: reading.vin,
    platform: reading.platform.id,
    module: it.module,
    name: it.name,
    tx: it.tx,
    rx: it.rx,
    did: it.did,
    hex: it.before,
    partNo: m.partNo || null,
    swVersion: m.swVersion || null,
    reason: 'before-write',
    at: new Date().toISOString(),
  };
}

const RESPONSE_PENDING = (m) => m.data[0] === 0x7f && m.data[1] === 0x2e && m.data[2] === 0x78;

// 2E write -> finalReply, { error } when it was never sent (refused or the
// ISO-TP transfer failed), or null when no final answer came.
async function sendWrite(elm, it, pendingMs) {
  let raw;
  try {
    raw = await elm.sendPayload(`2E${it.did}${it.after}`, 15000);
  } catch (err) {
    if (err.code === 'REFUSED' || err.code === 'ISOTP') return { error: err.message };
    throw err;
  }
  const reply = d.finalReply(raw, 0x2e);
  // Only "response pending" (7F 2E 78) came back: give the module time to
  // finish; the read-back then shows whether the write went in.
  if (!reply && d.parseMessages(raw).some(RESPONSE_PENDING)) await sleep(pendingMs);
  return reply;
}

// What the read-back says about one write. readback is only given when the
// car holds the new coding, or something that is neither old nor new.
function outcome(it, reply, back) {
  const now = back.hex;
  if (now === it.after) return { ok: true, readback: now };
  if (reply && reply.error) return { ok: false, error: reply.error };
  const refused = reply && !reply.ok ? writeError(reply.nrc) : null;
  if (now === undefined) {
    if (refused) return { ok: false, error: refused };
    const said = reply ? 'written' : 'no clear answer from the module';
    return { ok: false, error: `${said}, but it couldn't be read back to check (${back.error}); read the car again` };
  }
  if (now === it.before) {
    if (refused) return { ok: false, error: `${refused}; nothing was changed` };
    return { ok: false, error: reply ? 'the module accepted it but still has the old coding' : 'no answer from the module; nothing was changed' };
  }
  return { ok: false, error: "the coding read back doesn't match what was written; restore the backup", readback: now };
}

// All writes to one module: re-read, back up, battery check, 10 03, each 2E,
// 10 01 (always, once 10 03 was tried), then read back. Returns why the
// remaining modules must not be written, or null to carry on.
async function writeModule(ctx, { mod, items }) {
  const { elm, onProgress } = ctx;
  const open = new Set(items);
  const sent = new Set();
  const done = (it, fields) => {
    open.delete(it);
    ctx.results.push({ module: it.module, name: it.name, did: it.did, before: it.before, after: it.after, ...fields });
  };
  const failRest = (error) => [...open].forEach((it) => done(it, { ok: false, error }));
  try {
    await target(elm, mod);
    onProgress(`Checking ${mod.name}`);
    const ready = [];
    for (const it of items) {
      const now = await readDid(elm, it.didNum);
      if (now.hex === it.before) ready.push(it);
      else if (now.hex === undefined) done(it, { ok: false, error: `couldn't read it first (${now.error}); nothing was written` });
      else done(it, { ok: false, error: 'the coding changed since the car was read; read the car again (nothing was written)' });
    }
    if (!ready.length) return null;

    onProgress(`Backing up ${mod.name}`);
    for (const it of ready) {
      try {
        await ctx.backup(backupRecord(ctx.reading, it));
      } catch (err) {
        failRest(`the backup couldn't be saved (${err.message}); nothing was written`);
        return 'not written: a backup could not be saved';
      }
    }

    const low = await lowVoltage(elm, ctx.minVoltage);
    if (low) {
      failRest(`${low}; nothing was written`);
      return `not written: ${low}`;
    }

    onProgress(`Writing ${mod.name}`);
    const replies = new Map();
    let session = null;
    try {
      session = await request(elm, '1003', 0x10);
      if (session && session.ok) {
        for (const it of ready) {
          sent.add(it);
          replies.set(it, await sendWrite(elm, it, ctx.pendingMs));
        }
      }
    } finally {
      await request(elm, '1001', 0x10, 1).catch(() => null);
    }
    if (!session || !session.ok) {
      failRest(`${session ? writeError(session.nrc) : 'no answer to the extended session request'}; nothing was written`);
      return null;
    }

    onProgress(`Checking ${mod.name}`);
    for (const it of ready) done(it, outcome(it, replies.get(it), await readDid(elm, it.didNum)));
  } catch (err) {
    for (const it of [...open]) {
      done(it, { ok: false, error: sent.has(it) ? `adapter error after writing (${err.message}); read the car again to check` : `adapter error (${err.message}); nothing was written` });
    }
    return `not written: adapter error (${err.message})`;
  }
  return null;
}

// options: { backup(record) (required, awaited before each write; a throw
// stops that write and the rest), onProgress, minVoltage = 12.4,
// pendingMs = 1500, platforms, features }.
// Throws before writing anything when the plan, battery or VIN don't check out.
async function writeCoding(adapter, reading, plan, options = {}) {
  const { backup, onProgress = () => {}, minVoltage = 12.4, pendingMs = 1500 } = options;
  const { platform, features } = writeContext(reading, options);
  if (typeof backup !== 'function') throw new Error('A backup is needed before writing.');
  const items = checkPlan(platform, features, reading, plan);
  const transcript = [];
  const result = { at: new Date().toISOString(), vin: reading.vin, platform: platform.id, results: [], transcript };
  if (!items.length) return result;

  const elm = recorder(adapter, transcript, codingAllowed(platform, features));
  const ctx = { elm, reading, backup, onProgress, minVoltage, pendingMs, results: result.results };
  try {
    onProgress('Resetting adapter');
    await init(elm);
    await elm.send('STI');
    const low = await lowVoltage(elm, minVoltage);
    if (low) throw new Error(`Not written: ${low}.`);

    onProgress('Connecting to car');
    const error = await connect(elm);
    if (error) throw new Error(error);
    await elm.send('ATSH7DF');
    await elm.send('ATCRA7E8');
    const vin = d.parseVin(await elm.send('0902'));
    if (!vin || vin !== reading.vin) throw new Error(`This isn't the car that was read (VIN ${vin || 'not readable'}). Read the car again; nothing was written.`);

    let stop = null;
    for (const group of byModule(items)) {
      if (stop) group.items.forEach((it) => ctx.results.push({ module: it.module, name: it.name, did: it.did, before: it.before, after: it.after, ok: false, error: stop }));
      else stop = await writeModule(ctx, group);
    }
  } finally {
    // Back to normal ISO-TP framing and replies whatever happened above.
    for (const c of ['ATCAF1', 'ATR1', 'ATFCSM0', 'ATCRA']) await elm.send(c).catch(() => {});
  }
  onProgress('Done');
  return result;
}

module.exports = { CODE_SIDS, codingAllowed, readCoding, planChanges, planRestore, writeCoding, writeError, featureState };
