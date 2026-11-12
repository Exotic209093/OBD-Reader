// Coding backups and change log on disk: <dir>/<VIN>/<name>.json per backup,
// <dir>/<VIN>/changes.jsonl for the log. A module's first-read coding is its
// "original" backup, which the app never overwrites or deletes.
const fs = require('node:fs');
const path = require('node:path');
const { platformForVin } = require('./codingCatalog');

const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;
// Backup ids are "<VIN>_<file name>", so load(id) needs nothing else and
// neither part can climb out of the folder.
const ID = /^([A-HJ-NPR-Z0-9]{17})_([\w-]{1,80})$/;
const LOG = 'changes.jsonl';

function checkVin(vin) {
  if (typeof vin !== 'string' || !VIN.test(vin)) throw new Error('Bad VIN for coding backups');
  return vin;
}

const text = (v, max = 100) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const matching = (v, re) => (typeof v === 'string' && re.test(v) ? v.toUpperCase() : null);

// Keeps only known, checked fields. Platform and addresses missing from the
// record are filled in from the catalogue.
function clean(record, reason) {
  if (!record || typeof record !== 'object') throw new Error('Bad coding backup');
  const vin = checkVin(record.vin);
  if (typeof record.module !== 'string' || !/^[A-Z0-9]{1,8}$/i.test(record.module)) throw new Error('Bad module in coding backup');
  const did = Number.isInteger(record.did) && record.did >= 0 && record.did <= 0xffff
    ? record.did.toString(16).toUpperCase().padStart(4, '0')
    : matching(record.did, /^[0-9A-F]{4}$/i);
  if (!did) throw new Error('Bad DID in coding backup');
  const hex = matching(record.hex, /^(?:[0-9A-F]{2}){1,4095}$/i);
  if (!hex) throw new Error('Bad coding bytes in backup');
  const platform = platformForVin(vin);
  const mod = platform && platform.modules.find((m) => m.key === record.module);
  const at = typeof record.at === 'string' && !Number.isNaN(Date.parse(record.at)) ? new Date(record.at).toISOString() : new Date().toISOString();
  return {
    vin,
    platform: matching(record.platform, /^[\w-]{1,40}$/) ? record.platform : platform ? platform.id : null,
    module: record.module,
    name: text(record.name) || (mod ? mod.name : record.module),
    tx: matching(record.tx, /^[0-9A-F]{3}$/i) || (mod ? mod.tx : null),
    rx: matching(record.rx, /^[0-9A-F]{3}$/i) || (mod ? mod.rx : null),
    did,
    hex,
    partNo: text(record.partNo),
    swVersion: text(record.swVersion),
    reason,
    at,
  };
}

class CodingStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(id) {
    const m = typeof id === 'string' ? id.match(ID) : null;
    if (!m) throw new Error('Bad backup id');
    return path.join(this.dir, m[1], `${m[2]}.json`);
  }

  // Exclusive create: an existing file is never overwritten (throws EEXIST).
  write(rec, name) {
    fs.mkdirSync(path.join(this.dir, rec.vin), { recursive: true });
    const id = `${rec.vin}_${name}`;
    fs.writeFileSync(this.file(id), JSON.stringify(rec, null, 2), { flag: 'wx' });
    return id;
  }

  // First coding seen for this VIN + module + DID. Returns the id, or null if
  // an original is already kept.
  saveOriginal(record) {
    const rec = clean(record, 'original');
    try {
      return this.write(rec, `original-${rec.module}-${rec.did}`);
    } catch (err) {
      if (err.code === 'EEXIST') return null;
      throw err;
    }
  }

  // Saves every module's coding in a reading as its original (if none yet).
  saveOriginals(reading) {
    const ids = [];
    if (!reading || !reading.platform || !reading.vin) return ids;
    for (const m of reading.modules || []) {
      for (const [did, hex] of Object.entries(m.data || {})) {
        const id = this.saveOriginal({ vin: reading.vin, platform: reading.platform.id, module: m.key, name: m.name, tx: m.tx, rx: m.rx, did, hex, partNo: m.partNo, swVersion: m.swVersion, at: reading.at });
        if (id) ids.push(id);
      }
    }
    return ids;
  }

  // Coding just before a write. Throws if it can't be saved, which stops the write.
  saveBackup(record) {
    const rec = clean(record, 'before-write');
    const base = `${rec.at.replace(/[:.]/g, '-')}-${rec.module}-${rec.did}`;
    for (let n = 0; ; n++) {
      try {
        return this.write(rec, n ? `${base}-${n}` : base);
      } catch (err) {
        if (err.code !== 'EEXIST' || n >= 20) throw err;
      }
    }
  }

  // All backups of one car, newest first; originals flagged.
  list(vin) {
    const dir = path.join(this.dir, checkVin(vin));
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => /^[\w-]{1,80}\.json$/.test(f))
      .map((f) => {
        try {
          return this.load(`${vin}_${f.slice(0, -5)}`);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  load(id) {
    const rec = JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
    return { ...rec, id, original: rec.reason === 'original' };
  }

  // One line per write (or restore): what was asked and what happened.
  logChange(entry) {
    const vin = checkVin(entry && entry.vin);
    fs.mkdirSync(path.join(this.dir, vin), { recursive: true });
    fs.appendFileSync(path.join(this.dir, vin, LOG), `${JSON.stringify({ ...entry, at: entry.at || new Date().toISOString() })}\n`);
  }

  // Logged changes of one car, newest first.
  changes(vin) {
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(this.dir, checkVin(vin), LOG), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .reverse();
  }
}

module.exports = { CodingStore };
