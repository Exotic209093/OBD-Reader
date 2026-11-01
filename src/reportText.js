// Plain-text version of a scan report, for copying to a garage or forum.

const SEV = { stop: 'STOP', caution: 'FIX SOON', info: 'INFO', ok: 'OK' };

function faultLine(f) {
  const code = f.number || f.sae;
  const when = f.time ? `  [${f.time}${f.mileageKm ? `, ${f.mileageKm} km` : ''}]` : '';
  return `  - ${code}: ${f.description || 'unknown'} (${f.flags.join(', ')})${when}`;
}

// Freeze frame values in reading order, e.g. "2150 rpm, 54 km/h, load 62%".
const FREEZE_FIELDS = [
  ['rpm', (v) => `${Math.round(v)} rpm`],
  ['speed', (v) => `${v} km/h`],
  ['load', (v) => `load ${Math.round(v)}%`],
  ['throttle', (v) => `throttle ${Math.round(v)}%`],
  ['map', (v) => `manifold ${v} kPa`],
  ['coolant', (v) => `coolant ${v} °C`],
  ['iat', (v) => `intake ${v} °C`],
  ['stft', (v) => `short trim ${v.toFixed(1)}%`],
  ['ltft', (v) => `long trim ${v.toFixed(1)}%`],
];

const freezeText = (values) => FREEZE_FIELDS.filter(([k]) => values[k] !== undefined).map(([k, fmt]) => fmt(values[k])).join(', ');

function reportText(r) {
  const L = [];
  const e = r.engine;
  L.push('OBD READER SCAN REPORT');
  L.push(`Date: ${new Date(r.finishedAt).toLocaleString()}`);
  if (r.vin) L.push(`VIN: ${r.vin}${r.make && r.make.name ? ` (${r.make.name})` : ''}`);
  L.push(`Adapter: ${r.adapter}   Battery: ${r.voltage ? `${r.voltage} V` : '-'}`);
  L.push('');
  if (r.cleared) {
    L.push(`CODES CLEARED ${new Date(r.cleared.at).toLocaleString()} (report below is the rescan after)`);
    for (const c of r.cleared.results) L.push(`  ${c.ok ? 'cleared' : 'NOT cleared'}: ${c.name}${c.ok ? '' : ` (${c.error})`}`);
    L.push('');
  }
  if (r.advice) {
    L.push(`VERDICT: ${r.advice.verdict}`);
    for (const a of r.advice.items) {
      L.push(`  [${SEV[a.severity]}] ${a.title}${a.code ? ` (${a.code})` : ''}`);
      if (a.what) L.push(`      ${a.what}`);
      for (const fix of a.fixes || []) L.push(`      * ${fix}`);
      if (a.cost) L.push(`      Rough cost: ${a.cost}`);
    }
    L.push('');
  }
  L.push('ENGINE');
  L.push(`  Check engine light: ${e.monitor ? (e.monitor.mil ? 'ON' : 'off') : '-'}`);
  L.push(`  Coolant: ${e.coolantC ?? '-'} C   RPM: ${e.rpm ?? '-'}`);
  const generic = [...e.stored.map((g) => g.code), ...e.pending.map((g) => `${g.code} (pending)`), ...e.permanent.map((g) => g.code)];
  L.push(`  Generic OBD codes: ${generic.length ? [...new Set(generic)].join(', ') : 'none'}`);
  L.push('  Fault memory:');
  if (e.memory.error) L.push(`  - could not read (${e.memory.error})`);
  else if (e.memory.faults.length) e.memory.faults.forEach((f) => L.push(faultLine(f)));
  else L.push('  - none');
  if (e.freezeFrame) L.push(`  Freeze frame (${e.freezeFrame.dtc}): ${freezeText(e.freezeFrame.values)}`);
  if (e.misfires.length) {
    L.push(`  Misfires (avg last 10 drives): ${e.misfires.map((m) => `cyl${m.cylinder}=${m.recent}`).join('  ')}`);
    if (e.misfires.some((m) => m.current !== null && m.current !== undefined)) {
      L.push(`  Misfires (this drive): ${e.misfires.map((m) => `cyl${m.cylinder}=${m.current ?? '-'}`).join('  ')}`);
    }
  }
  if (e.monitor && e.monitor.readiness) {
    const waiting = e.monitor.readiness.filter((r) => !r.complete).map((r) => r.name);
    L.push(`  Readiness: ${waiting.length ? `not finished: ${waiting.join(', ')}` : 'all finished'}`);
  }
  L.push('');
  L.push('OTHER MODULES');
  if (r.make && !r.make.verified) {
    L.push(`  (Module list for ${r.make.name || 'this car'} not yet checked on a real car; "no answer" may just mean a different address.)`);
  }
  for (const m of r.modules) {
    const state = m.skipped ? 'skipped (no answer in recent scans)' : !m.responded ? 'no answer' : m.error ? `could not read (${m.error})` : m.faults.length ? `${m.faults.length} fault(s)` : 'no faults';
    L.push(`  ${m.name}${m.found ? ' [found by search]' : ''}: ${state}`);
    m.faults.forEach((f) => L.push(`  ${faultLine(f)}`));
  }
  if (r.comparison) {
    const c = r.comparison;
    L.push('');
    L.push(`SINCE PREVIOUS SCAN (${new Date(c.previousAt).toLocaleString()})`);
    L.push(`  New: ${c.added.map((f) => f.label).join('; ') || 'none'}`);
    L.push(`  Gone: ${c.gone.map((f) => f.label).join('; ') || 'none'}`);
    L.push(`  Still there: ${c.still.map((f) => f.label).join('; ') || 'none'}`);
    if (c.misfires.some((m) => m.before !== null)) {
      L.push(`  Misfire averages: ${c.misfires.map((m) => `cyl${m.cylinder} ${m.before ?? '-'} -> ${m.now ?? '-'}`).join('  ')}`);
    }
  }
  L.push('');
  L.push(r.cleared ? 'Scan is read-only; codes were cleared only as listed above, on request.' : 'Read-only scan. No codes were cleared.');
  return L.join('\n');
}

module.exports = { reportText };
