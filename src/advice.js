// Turns a scan report into a prioritised, plain-English action list.
const { lookup } = require('./codes');
const { PROFILES } = require('./makes');

const RANK = { stop: 0, caution: 1, info: 2, ok: 3 };
const PENDING = 0x04;

function faultAdvice(fault, moduleName, tool) {
  const k = lookup(fault);
  const active = (fault.status & 0x01) !== 0;
  const pending = fault.status === PENDING;
  const code = [fault.number, fault.sae].filter(Boolean).join(' / ');
  if (!k) {
    return {
      severity: 'info',
      title: `Unknown fault ${code} in ${moduleName}`,
      what: active
        ? 'The module reports this fault as active right now, but this app doesn\'t know what it means yet.'
        : pending
          ? 'Pending fault (seen once, not confirmed yet) that this app doesn\'t recognise.'
          : 'Stored fault this app doesn\'t recognise yet.',
      fixes: [`Read this module with ${tool} to get the full description.`],
      code,
      module: moduleName,
    };
  }
  return {
    // A pending code was seen once and not confirmed: one step less urgent.
    severity: pending ? { stop: 'caution', caution: 'info' }[k.severity] || 'info' : k.severity || 'info',
    title: pending ? `${k.title} (pending)` : k.title,
    what: k.what || null,
    fixes: k.fixes || [],
    cost: k.cost || null,
    code,
    module: moduleName,
    active,
  };
}

// Misfires on the current drive at or above this mean the fault is still there.
const STILL_MISFIRING = 5;

const day = (iso) => new Date(iso).toLocaleDateString('en-GB');

// ctx.repairs: [{ at, note }] marked by the user; ctx.previous: earlier scans of
// this car, newest first ({ at, misfires }). The ECU's "recent" figure is an
// average over 10 drives, so after a repair it falls slowly; the current-drive
// count shows straight away whether the fix worked.
function misfireAdvice(misfires, engineName, ctx = {}) {
  if (!misfires || !misfires.length) return null;
  const counts = misfires.map((m) => m.recent || 0);
  const worst = counts.indexOf(Math.max(...counts));
  const peak = counts[worst];
  if (peak < 10) return null;
  const others = counts.filter((_, i) => i !== worst);
  const single = others.every((c) => c * 4 < peak);
  const cyl = misfires[worst].cylinder;
  const now = misfires[worst].current;
  const cleanNow = now !== null && now !== undefined && now < STILL_MISFIRING;
  const repair = (ctx.repairs || []).at(-1);
  const earlier = (ctx.previous || []).map((p) => (p.misfires.find((m) => m.cylinder === cyl) || {}).recent).filter((v) => typeof v === 'number');
  const trend = [...earlier.slice(0, 4).reverse(), peak];
  const falling = earlier.length > 0 && earlier[0] > peak;

  if (single && repair && cleanNow) {
    return {
      severity: 'info',
      title: `Cylinder ${cyl} misfires going away since the repair`,
      what: `Repair noted on ${day(repair.at)}${repair.note ? ` (${repair.note})` : ''}. This drive: ${now} misfire${now === 1 ? '' : 's'} on cylinder ${cyl}. The ${peak} is the engine's average over the last 10 drives, which still includes drives before the repair, so it falls a little with each drive${trend.length > 1 ? ` (${trend.join(' → ')})` : ''}.`,
      fixes: [`Scan again after a few drives. If "this drive" goes to ${STILL_MISFIRING} or more again, the misfire is still there.`],
      code: 'Mode 06',
      module: engineName,
    };
  }
  if (single && repair && !cleanNow && now !== null && now !== undefined) {
    return {
      severity: 'caution',
      title: `Cylinder ${cyl} still misfiring after the repair`,
      what: `Repair noted on ${day(repair.at)}${repair.note ? ` (${repair.note})` : ''}, but cylinder ${cyl} misfired ${now} times on this drive.`,
      fixes: [
        `Check the coil connector and plug gap on cylinder ${cyl}.`,
        'If the new parts are fitted correctly, a garage can check that cylinder\'s injector and compression.',
      ],
      code: 'Mode 06',
      module: engineName,
    };
  }
  if (single && falling && now === 0) {
    return {
      severity: 'info',
      title: `Cylinder ${cyl} misfires are falling`,
      what: `No misfires on cylinder ${cyl} this drive and its 10-drive average is going down (${trend.join(' → ')}). If you've just fixed it, press "Mark as repaired".`,
      fixes: ['Scan again after a few drives to confirm.'],
      code: 'Mode 06',
      module: engineName,
    };
  }
  return {
    severity: 'caution',
    title: single ? `Cylinder ${worst + 1} is misfiring` : 'Several cylinders are misfiring',
    what: single
      ? `Cylinder ${worst + 1} averages ${peak} misfires per drive; the others average ${others.join(', ')}. One cylinder on its own almost always means its coil pack or spark plug.`
      : `Misfire counts per cylinder: ${counts.join(', ')}. Misfires on several cylinders point to something shared: plugs due, fuel pressure, a vacuum leak or low battery voltage.`,
    fixes: single
      ? [`Swap coil ${worst + 1} with a neighbouring cylinder and see if the misfire follows it.`, 'Replace plugs if due.']
      : ['Replace plugs if due, then check for vacuum/boost leaks and fuel pressure.'],
    code: 'Mode 06',
    module: engineName,
  };
}

function batteryAdvice(voltage, engineRunning) {
  if (!voltage) return null;
  if (engineRunning) {
    if (voltage < 13.2) {
      return {
        severity: 'caution',
        title: 'Battery not charging properly',
        what: `${voltage.toFixed(1)} V with the engine running; it should be about 13.5-14.8 V. Check the alternator and its belt.`,
        fixes: ['Have the alternator and charging system tested.'],
      };
    }
    return null;
  }
  if (voltage < 12.2) {
    return {
      severity: 'caution',
      title: 'Battery voltage low',
      what: `${voltage.toFixed(1)} V with the engine off (a healthy battery rests at 12.4-12.7 V). A weak battery can cause random warning lights and faults.`,
      fixes: [
        'Charge it overnight and re-test, or get a free battery test at a parts shop.',
        'Cars with start/stop need an AGM/EFB replacement, and many need it registered/coded to the car.',
      ],
      cost: 'Battery £120-200 + coding',
    };
  }
  return null;
}

// Emissions self-tests not finished yet: normal after codes were cleared or
// the battery was disconnected; they finish after some mixed driving.
function readinessAdvice(monitor, engineName) {
  if (!monitor || !monitor.readiness || monitor.mil) return null;
  const waiting = monitor.readiness.filter((r) => !r.complete).map((r) => r.name);
  if (!waiting.length) return null;
  return {
    severity: 'info',
    title: `Emissions self-tests not finished: ${waiting.join(', ').toLowerCase()}`,
    what: 'The engine hasn\'t finished checking these yet. That is normal for a while after codes are cleared or the battery is disconnected. Some emissions tests (and garages) check these are finished.',
    fixes: ['Drive normally for a few days, including a steady 10-20 minute run at 40-60 mph, then scan again.'],
    code: 'Readiness',
    module: engineName,
  };
}

// ctx (optional, from History.adviceContext): repairs and earlier scans of this car.
function buildAdvice(report, ctx = {}) {
  const items = [];
  if (!report.engine) return { overall: 'info', items };
  const e = report.engine;
  const engineName = e.memory.name;
  // Scans saved before make profiles existed were all from the Audi S1.
  const tool = report.make ? report.make.tool || PROFILES[report.make.profile].tool : PROFILES.vag.tool;

  if (e.monitor && e.monitor.mil) {
    items.push({
      severity: 'caution',
      title: 'Check engine light is on',
      what: 'The engine has a confirmed emissions-related fault. If the light is flashing, an active misfire is damaging the catalytic converter: pull over.',
      fixes: ['See the faults listed below.'],
    });
  }

  for (const f of e.memory.faults) items.push(faultAdvice(f, engineName, tool));
  const generic = [...e.stored, ...e.permanent].map((g) => [g, 0x08]).concat(e.pending.map((g) => [g, PENDING]));
  const seen = new Set();
  for (const [g, status] of generic) {
    if (seen.has(g.code) || e.memory.faults.some((f) => f.sae && f.sae.startsWith(g.code))) continue;
    seen.add(g.code);
    items.push(faultAdvice({ sae: g.code, number: null, status }, engineName, tool));
  }
  const mf = misfireAdvice(e.misfires, engineName, ctx);
  if (mf) items.push({ ...mf, kind: 'misfire' });
  const ready = readinessAdvice(e.monitor, engineName);
  if (ready) items.push(ready);
  const bat = batteryAdvice(report.voltage, e.rpm > 0);
  if (bat) items.push(bat);
  for (const m of report.modules || []) {
    for (const f of m.faults) items.push(faultAdvice(f, m.name, tool));
  }

  // Active faults first within each severity.
  items.sort((a, b) => RANK[a.severity] - RANK[b.severity] || (b.active ? 1 : 0) - (a.active ? 1 : 0));
  const overall = items.length ? items[0].severity : 'ok';
  const verdict = {
    ok: 'No problems found.',
    info: 'Minor items to look into when convenient.',
    caution: 'Safe to drive gently. Get these fixed soon.',
    stop: 'Avoid driving until this is checked.',
  }[overall];
  return { overall, verdict, items };
}

module.exports = { buildAdvice };
