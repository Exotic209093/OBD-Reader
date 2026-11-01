// Saved scans on disk plus comparison between two scans.
const fs = require('node:fs');
const path = require('node:path');

const faultKey = (moduleName, f) => `${moduleName}|${f.hex}`;

// Saved scan files are named from their finish time (2026-10-30T17-52-42-446Z.json).
const SCAN_FILE = /^\d{4}-[\w-]+\.json$/;
const REPAIRS_FILE = 'repairs.json';

// A listed module that hasn't answered in this many scans in a row is skipped
// until the next "search every address".
const SILENT_AFTER = 3;

function allFaults(report) {
  const out = new Map();
  if (!report || !report.engine) return out;
  const engine = report.engine.memory;
  for (const f of engine.faults) out.set(faultKey(engine.name, f), { module: engine.name, ...f });
  for (const m of report.modules || []) {
    for (const f of m.faults) out.set(faultKey(m.name, f), { module: m.name, ...f });
  }
  return out;
}

function compareReports(prev, cur) {
  const a = allFaults(prev);
  const b = allFaults(cur);
  const label = (f) => `${f.number || f.sae} ${f.description || ''}`.trim();
  const added = [...b].filter(([k]) => !a.has(k)).map(([, f]) => ({ module: f.module, label: label(f) }));
  const gone = [...a].filter(([k]) => !b.has(k)).map(([, f]) => ({ module: f.module, label: label(f) }));
  const still = [...b].filter(([k]) => a.has(k)).map(([, f]) => ({ module: f.module, label: label(f) }));
  const misfires = (cur.engine.misfires || []).map((m) => {
    const before = ((prev.engine && prev.engine.misfires) || []).find((p) => p.cylinder === m.cylinder);
    return { cylinder: m.cylinder, before: before ? before.recent : null, now: m.recent };
  });
  return { previousAt: prev.finishedAt, added, gone, still, misfires };
}

class History {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(id) {
    if (!/^[\w-]+$/.test(id)) throw new Error('Bad history id');
    return path.join(this.dir, `${id}.json`);
  }

  ids() {
    return fs
      .readdirSync(this.dir)
      .filter((f) => SCAN_FILE.test(f))
      .sort()
      .reverse()
      .map((f) => f.slice(0, -5));
  }

  list() {
    return this.ids()
      .map((id) => {
        try {
          const r = this.load(id);
          return {
            id,
            at: r.finishedAt,
            vin: r.vin,
            overall: r.advice ? r.advice.overall : null,
            faults: allFaults(r).size,
            voltage: r.voltage ?? null,
            engineRunning: Boolean(r.engine && r.engine.rpm > 0),
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  load(id) {
    return JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
  }

  latest(vin) {
    const entry = this.list().find((e) => !vin || e.vin === vin);
    return entry ? this.load(entry.id) : null;
  }

  // Full saved scans of one car, newest first, optionally only those before a time.
  reportsFor(vin, before = null) {
    const out = [];
    for (const id of this.ids()) {
      try {
        const r = this.load(id);
        if (r.vin === vin && (!before || r.finishedAt < before)) out.push(r);
      } catch {
        // Skip unreadable files.
      }
    }
    return out;
  }

  // What earlier scans learned about this car's modules (used by scan()).
  carMemory(vin) {
    const reports = vin ? this.reportsFor(vin) : [];
    const searched = reports.find((r) => r.search);
    const found = searched
      ? searched.modules.filter((m) => m.found).map(({ name, tx, rx, uudt }) => ({ name, tx, rx, ...(uudt ? { uudt } : {}) }))
      : null;
    const recent = reports.slice(0, SILENT_AFTER);
    const silent = recent.length < SILENT_AFTER
      ? []
      : recent[0].modules
          .filter((m) => !m.found && recent.every((r) => r.modules.some((x) => x.tx === m.tx && !x.found && !x.responded)))
          .map((m) => m.tx);
    return { found, silent };
  }

  // Repairs the user has marked ("new coils and plugs"), for the advice.
  readRepairs() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, REPAIRS_FILE), 'utf8'));
    } catch {
      return [];
    }
  }

  repairs(vin) {
    return this.readRepairs().filter((r) => r.vin === vin);
  }

  addRepair(vin, note, at = new Date().toISOString()) {
    const all = [...this.readRepairs(), { vin, at, note }];
    fs.writeFileSync(path.join(this.dir, REPAIRS_FILE), JSON.stringify(all, null, 2));
    return all.filter((r) => r.vin === vin);
  }

  // Context buildAdvice() uses: repairs and earlier misfire counts for this car.
  adviceContext(report) {
    if (!report.vin) return {};
    const at = report.finishedAt;
    return {
      repairs: this.repairs(report.vin).filter((r) => !at || r.at <= at),
      previous: this.reportsFor(report.vin, at).map((r) => ({ at: r.finishedAt, misfires: (r.engine && r.engine.misfires) || [] })),
    };
  }

  save(report) {
    const id = report.finishedAt.replace(/[:.]/g, '-');
    report.id = id;
    fs.writeFileSync(this.file(id), JSON.stringify(report, null, 2));
    return id;
  }

  remove(id) {
    fs.rmSync(this.file(id), { force: true });
  }
}

module.exports = { History, compareReports };
