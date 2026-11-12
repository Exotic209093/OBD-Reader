const $ = (id) => document.getElementById(id);

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c !== null && c !== undefined && c !== false) node.append(c);
  }
  return node;
};

let currentReport = null;
let currentView = 'scan';

// ---------- shared ----------

function setStatus(id, text, isError = false) {
  $(id).textContent = text;
  $(id).classList.toggle('error', isError);
}

const cleanError = (err) => err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

let portKey = '';

// Re-reads ports; keeps the user's choice unless the cable has just appeared.
async function loadPorts() {
  const ports = await window.obd.listPorts();
  const key = ports.map((p) => p.path).join(',');
  if (key === portKey) return;
  portKey = key;
  const select = $('port');
  const previous = ports.find((p) => p.path === select.value);
  const adapter = ports.find((p) => p.likelyAdapter);
  const options = ports.map((p) => el('option', { value: p.path, ...(p.likelyAdapter ? { 'data-adapter': '' } : {}) }, p.label));
  if (!adapter) options.unshift(el('option', { value: '' }, 'USB cable not detected - plug it in'));
  select.replaceChildren(...options);
  if (adapter && !(previous && previous.likelyAdapter)) select.value = adapter.path;
  else select.value = previous ? previous.path : '';
}

function checkPortChoice() {
  const opt = $('port').selectedOptions[0];
  if (opt && opt.value && !opt.hasAttribute('data-adapter') && /Bluetooth/.test(opt.textContent)) {
    setStatus('status', `${opt.value} is a Bluetooth link, not your OBD cable. Pick the USB cable port.`, true);
    return false;
  }
  return true;
}

function showView(name) {
  currentView = name;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.view === name);
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${name}`;
  if (name === 'history') renderHistory();
  // Only the Features tab can write to the car; say so in the header.
  const writing = name === 'features';
  const tag = $('mode-tag');
  tag.textContent = writing ? 'can write to car' : 'read-only scan';
  tag.classList.toggle('write', writing);
  tag.title = writing
    ? 'This tab can change settings in the car, but only after you review the changes and confirm. Every change is backed up first.'
    : 'Scans never change anything. Codes are only cleared when you press Clear codes and confirm.';
  if (writing) loadPlatforms();
}

// ---------- scan report ----------

const SEVERITY = {
  stop: { label: 'Stop', icon: '⛔' },
  caution: { label: 'Fix soon', icon: '⚠️' },
  info: { label: 'Info', icon: 'ℹ️' },
  ok: { label: 'All good', icon: '✅' },
};

function card(label, value, tone = '', extraClass = '') {
  return el('div', { class: `card ${extraClass}` }, el('div', { class: 'k' }, label), el('div', { class: `v ${tone}` }, value));
}

function chips(flags) {
  return flags.map((f) => {
    const tone = f === 'failing now' ? 'now' : f === 'pending' ? 'pending' : '';
    return el('span', { class: `chip ${tone}` }, f);
  });
}

function codeCell(f) {
  return el('td', {}, el('div', { class: 'code' }, f.number || f.sae), f.number && f.sae ? el('div', { class: 'sub' }, f.sae) : null);
}

function faultTable(faults, withWhen) {
  const head = el('tr', {}, el('th', {}, 'Code'), el('th', {}, 'Meaning'), el('th', {}, 'Status'), withWhen ? el('th', {}, 'When') : null);
  const rows = faults.map((f) =>
    el(
      'tr',
      {},
      codeCell(f),
      el('td', {}, f.description || el('span', { class: 'sub' }, `Unknown code (raw ${f.hex})`)),
      el('td', {}, chips(f.flags)),
      withWhen ? el('td', {}, f.time || '-', f.mileageKm ? el('div', { class: 'sub' }, `${f.mileageKm.toLocaleString()} km`) : null) : null,
    ),
  );
  return el('table', {}, el('thead', {}, head), el('tbody', {}, rows));
}

function renderAdvice(advice) {
  const sev = SEVERITY[advice.overall];
  $('verdict').className = `verdict ${advice.overall}`;
  $('verdict').replaceChildren(el('span', { class: 'icon' }, sev.icon), el('div', {}, el('strong', {}, advice.verdict), el('div', { class: 'sub' }, `${advice.items.length} item${advice.items.length === 1 ? '' : 's'} below, most important first.`)));
  $('advice').replaceChildren(
    ...advice.items.map((a) =>
      el(
        'details',
        { class: `advice-item ${a.severity}`, ...(a.severity !== 'info' ? { open: '' } : {}) },
        el(
          'summary',
          {},
          el('span', { class: `badge ${a.severity}` }, SEVERITY[a.severity].label),
          el('span', { class: 'title' }, a.title),
          a.active ? el('span', { class: 'chip now' }, 'happening now') : null,
          el('span', { class: 'sub' }, [a.code, a.module].filter(Boolean).join(' · ')),
        ),
        a.what ? el('p', {}, a.what) : null,
        a.fixes && a.fixes.length ? el('ol', {}, a.fixes.map((f) => el('li', {}, f))) : null,
        a.cost ? el('p', { class: 'sub' }, `Rough cost: ${a.cost}`) : null,
        a.kind === 'misfire' ? repairForm() : null,
      ),
    ),
  );
}

// "I've fixed it": notes the repair for this car so the misfire advice reads
// the slowly-falling 10-drive average in that light.
function repairForm() {
  if (!currentReport || !currentReport.id) return null;
  const note = el('input', { type: 'text', class: 'repair-note', placeholder: 'What was done, e.g. new coils and plugs', maxlength: '200' });
  const button = el('button', { class: 'ghost small' }, 'Mark as repaired today');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const fromHistory = $('report-title').textContent.startsWith('Saved scan');
      showReport(await window.obd.markRepaired(currentReport.id, note.value.trim()), fromHistory);
      setStatus('status', 'Repair noted. Scan again after a few drives to check the misfire has gone.');
    } catch (err) {
      setStatus('status', cleanError(err), true);
      button.disabled = false;
    }
  });
  return el('div', { class: 'repair no-print' }, note, button);
}

function renderComparison(c) {
  const box = $('comparison');
  if (!c) return box.replaceChildren();
  const list = (title, items, tone) =>
    el('div', { class: `cmp ${tone}` }, el('div', { class: 'k' }, title), items.length ? el('ul', {}, items.map((i) => el('li', {}, `${i.label}`, el('span', { class: 'sub' }, ` · ${i.module}`)))) : el('div', { class: 'sub' }, 'none'));
  const mf = c.misfires.filter((m) => m.before !== null && m.before !== m.now);
  box.replaceChildren(
    el('h2', {}, 'Since last scan ', el('small', {}, new Date(c.previousAt).toLocaleString())),
    el('div', { class: 'cmp-grid' }, list('New faults', c.added, 'bad'), list('Gone', c.gone, 'ok'), list('Still there', c.still, '')),
  );
  if (mf.length) box.append(el('p', { class: 'sub' }, `Misfire averages: ${mf.map((m) => `cyl ${m.cylinder} ${m.before} → ${m.now}`).join(', ')}`));
}

function renderSummary(r) {
  const e = r.engine;
  const engineFaults = e.memory.faults.length;
  const active = e.memory.faults.filter((f) => f.status & 0x01).length;
  const moduleFaults = r.modules.reduce((n, m) => n + m.faults.length, 0);
  const volts = r.voltage;
  $('summary').replaceChildren(
    card('Check engine light', e.monitor ? (e.monitor.mil ? 'ON' : 'Off') : '-', e.monitor && e.monitor.mil ? 'bad' : 'ok'),
    card('Engine faults', `${engineFaults}${active ? ` (${active} active)` : ''}`, engineFaults ? 'warn' : 'ok'),
    card('Other module faults', String(moduleFaults), moduleFaults ? 'warn' : 'ok'),
    card('Battery', volts ? `${volts.toFixed(1)} V` : '-', volts && volts < 12.2 ? 'warn' : 'ok'),
    card('Coolant', e.coolantC !== null ? `${e.coolantC} °C` : '-'),
    card('Engine', e.rpm ? `${e.rpm} rpm` : 'Not running'),
    card('Car', r.make && r.make.name ? r.make.name : (r.make ? 'Unknown make (generic OBD only)' : '-')),
    card('VIN', r.vin || '-', '', 'wide'),
  );
}

function renderEngine(e) {
  const generic = [...new Set([...e.stored.map((g) => g.code), ...e.pending.map((g) => `${g.code} (pending)`), ...e.permanent.map((g) => g.code)])];
  const box = $('engine-faults');
  box.replaceChildren();
  if (e.memory.faults.length) box.append(faultTable(e.memory.faults, true));
  else if (e.memory.error) box.append(el('div', { class: 'none' }, `Could not read the engine fault memory (${e.memory.error}).`));
  else box.append(el('div', { class: 'none' }, 'No faults stored in the engine.'));
  if (generic.length) box.append(el('p', { class: 'sub' }, `Generic OBD codes: ${generic.join(', ')}`));
  if (e.freezeFrame) box.append(freezeFrameTable(e.freezeFrame));

  const max = Math.max(10, ...e.misfires.map((m) => m.recent || 0));
  $('misfires').replaceChildren(
    ...(e.misfires.length
      ? e.misfires.map((m) => {
          const n = m.recent || 0;
          const tone = n >= 20 ? 'bad' : n >= 5 ? 'warn' : '';
          const fill = el('div', { class: `fill ${tone}` });
          fill.style.width = `${Math.max(2, (n / max) * 100)}%`;
          const now = m.current === null || m.current === undefined ? '–' : String(m.current);
          return el('div', { class: 'mf' }, `Cylinder ${m.cylinder}`, el('div', { class: 'track' }, fill), el('span', { class: 'n' }, String(n)), el('span', { class: `n now ${m.current >= 5 ? 'bad' : ''}`, title: 'This drive' }, now));
        })
      : [el('span', { class: 'sub' }, 'Misfire counters not available.')]),
  );
  renderReadiness(e.monitor);
}

const FREEZE_FIELDS = [
  ['rpm', 'Engine speed', (v) => `${Math.round(v)} rpm`],
  ['speed', 'Road speed', (v) => `${v} km/h`],
  ['load', 'Engine load', (v) => `${Math.round(v)} %`],
  ['throttle', 'Throttle', (v) => `${Math.round(v)} %`],
  ['map', 'Manifold pressure', (v) => `${v} kPa`],
  ['coolant', 'Coolant', (v) => `${v} °C`],
  ['iat', 'Intake air', (v) => `${v} °C`],
  ['stft', 'Short fuel trim', (v) => `${v.toFixed(1)} %`],
  ['ltft', 'Long fuel trim', (v) => `${v.toFixed(1)} %`],
];

function freezeFrameTable(ff) {
  const rows = FREEZE_FIELDS.filter(([k]) => ff.values[k] !== undefined).map(([k, label, fmt]) => el('div', { class: 'card' }, el('div', { class: 'k' }, label), el('div', { class: 'v' }, fmt(ff.values[k]))));
  return el('div', { class: 'freeze' }, el('h3', {}, `Freeze frame `, el('small', {}, `conditions when ${ff.dtc} was stored`)), el('div', { class: 'cards' }, rows));
}

function renderReadiness(monitor) {
  const box = $('readiness');
  if (!monitor || !monitor.readiness || !monitor.readiness.length) {
    return box.replaceChildren(el('span', { class: 'sub' }, 'Readiness not reported by this car.'));
  }
  const waiting = monitor.readiness.filter((r) => !r.complete).length;
  box.replaceChildren(
    el('p', { class: waiting ? 'warn' : 'ok' }, waiting ? `${waiting} of ${monitor.readiness.length} self-tests not finished yet. Normal after clearing codes; they finish with driving.` : 'All self-tests finished.'),
    el('div', { class: 'ready-grid' }, monitor.readiness.map((r) => el('span', { class: `chip ${r.complete ? 'done' : 'pending'}` }, `${r.complete ? '✓' : '…'} ${r.name}`))),
  );
}

function renderModules(modules, make) {
  const note = make && !make.verified
    ? el('p', { class: 'sub' }, `Module list for ${make.name || 'this car'} not yet checked on a real car; "No answer" may just mean a different address. For full coverage use ${make.tool}.`)
    : null;
  $('module-list').replaceChildren(
    ...(note ? [note] : []),
    ...modules.map((m) => {
      let state;
      if (m.skipped) state = el('span', { class: 'state', title: 'Didn\'t answer in recent scans. Tick "Search every address again" to re-check it.' }, 'Skipped');
      else if (!m.responded) state = el('span', { class: 'state' }, 'No answer');
      else if (m.error) state = el('span', { class: 'state' }, `Could not read (${m.error})`);
      else if (!m.faults.length) state = el('span', { class: 'state ok' }, 'No faults');
      else state = el('span', { class: 'state bad' }, `${m.faults.length} fault${m.faults.length > 1 ? 's' : ''}`);
      return el('div', { class: 'module' }, el('div', { class: 'grow' }, el('strong', {}, m.name), m.found ? el('span', { class: 'sub' }, ' · found by search') : null, m.faults.length ? el('div', { class: 'faults' }, faultTable(m.faults, false)) : null), state);
    }),
  );
}

function showReport(report, fromHistory = false) {
  currentReport = report;
  $('report-title').textContent = `${fromHistory ? 'Saved scan' : 'Scan'} · ${new Date(report.finishedAt).toLocaleString()}${report.vin ? ` · ${report.vin}` : ''}`;
  if (report.advice) renderAdvice(report.advice);
  renderComparison(report.comparison);
  renderSummary(report);
  renderEngine(report.engine);
  renderModules(report.modules, report.make);
  renderCleared(report.cleared, report.comparison);
  $('report').hidden = false;
  for (const id of ['copy', 'save-txt', 'save-pdf']) $(id).hidden = false;
  $('clear-open').hidden = !clearTargets(report).length;
  $('clear-panel').hidden = true;
}

// Everything "Clear all codes" clears: the engine (OBD mode 04, always, as it
// also resets the misfire counters and freeze frame) and every module that was
// read and holds faults.
function clearTargets(report) {
  if (!report || !report.engine) return [];
  const e = report.engine;
  const engineCodes = new Set([...e.stored, ...e.pending].map((g) => g.code)).size || e.memory.faults.length;
  const out = [{ key: 'engine', label: 'Engine', detail: engineCodes ? `${engineCodes} code${engineCodes > 1 ? 's' : ''} + misfire counters` : 'misfire counters' }];
  for (const m of report.modules) {
    if (m.faults.length && m.protocol && m.tx) {
      out.push({ key: m.tx, label: m.name, detail: `${m.faults.length} code${m.faults.length > 1 ? 's' : ''}`, target: { name: m.name, tx: m.tx, rx: m.rx, protocol: m.protocol } });
    }
  }
  return out;
}

function openClearPanel() {
  const items = clearTargets(currentReport);
  $('clear-list').replaceChildren(...items.map((t) => el('div', { class: 'clear-item' }, el('span', { class: 'grow' }, t.label), el('span', { class: 'sub' }, t.detail))));
  $('clear-panel').hidden = false;
}

async function runClear() {
  const port = $('port').value;
  if (!port) return setStatus('status', 'Plug in the USB cable first.', true);
  if (!checkPortChoice()) return;
  const items = clearTargets(currentReport);
  const targets = { engine: true, modules: items.filter((t) => t.target).map((t) => t.target) };
  for (const id of ['scan', 'clear-run', 'clear-open']) $(id).disabled = true;
  try {
    const report = await window.obd.clear(port, targets, { search: $('search').checked });
    if (!report) return setStatus('status', 'Nothing was cleared.');
    if (report.error) return setStatus('status', report.error, true);
    showReport(report);
    const done = report.cleared.results.filter((r) => r.ok).length;
    setStatus('status', `Cleared ${done} of ${report.cleared.results.length}, then rescanned. Anything still listed below came back or couldn't be cleared.`);
  } catch (err) {
    setStatus('status', cleanError(err), true);
  } finally {
    for (const id of ['scan', 'clear-run', 'clear-open']) $(id).disabled = false;
  }
}

function renderCleared(cleared, comparison) {
  const box = $('cleared');
  if (!cleared) return box.replaceChildren();
  const mf = comparison ? comparison.misfires.filter((m) => m.before !== null) : [];
  box.replaceChildren(
    el(
      'div',
      { class: 'cleared' },
      el('strong', {}, `Codes cleared ${new Date(cleared.at).toLocaleTimeString()}`),
      ...cleared.results.map((r) => el('div', {}, el('span', { class: r.ok ? 'ok' : 'bad' }, r.ok ? '✓ ' : '✗ '), r.name, r.ok ? '' : ` – ${r.error}`)),
      mf.length ? el('div', { class: 'sub' }, `Misfire averages before → after: ${mf.map((m) => `cyl ${m.cylinder} ${m.before} → ${m.now ?? '–'}`).join(', ')}`) : null,
    ),
  );
}

async function runScan() {
  const port = $('port').value;
  if (!port) return setStatus('status', 'Plug in the USB cable first, then press Scan car.', true);
  if (!checkPortChoice()) return;
  $('scan').disabled = true;
  $('log').textContent = '';
  setStatus('status', 'Starting…');
  try {
    const report = await window.obd.scan(port, { search: $('search').checked });
    if (report.error) return setStatus('status', report.error, true);
    showReport(report);
    setStatus('status', `Scan finished ${new Date(report.finishedAt).toLocaleTimeString()} and saved to History. Nothing was cleared.`);
  } catch (err) {
    setStatus('status', cleanError(err), true);
  } finally {
    $('scan').disabled = false;
  }
}

async function exportReport(kind) {
  if (!currentReport) return;
  try {
    if (kind === 'copy') {
      await window.obd.copyReport(currentReport);
      setStatus('status', 'Report copied. Paste it into a message or forum post.');
    } else {
      const file = await window.obd.saveReport(currentReport, kind);
      if (file) setStatus('status', `Saved ${file}`);
    }
  } catch (err) {
    setStatus('status', cleanError(err), true);
  }
}

// ---------- history ----------

// Resting battery voltage per saved scan (engine-off scans only), one line per
// car, oldest on the left, with the healthy 12.4-12.7 V band shaded.
function renderBatteryTrend(items) {
  const box = $('battery-trend');
  const points = items.filter((h) => typeof h.voltage === 'number' && !h.engineRunning).reverse();
  if (points.length < 2) return box.replaceChildren(el('div', { class: 'sub' }, 'Needs two or more engine-off scans.'));
  const canvas = el('canvas', { height: '140' });
  const latest = points.at(-1);
  box.replaceChildren(canvas, el('div', { class: 'sub' }, `Latest ${latest.voltage.toFixed(1)} V on ${new Date(latest.at).toLocaleDateString('en-GB')} · ${points.length} scans`));
  const w = (canvas.width = Math.max(300, box.clientWidth - 28) * devicePixelRatio);
  const h = (canvas.height = 140 * devicePixelRatio);
  const ctx = canvas.getContext('2d');
  const lo = Math.min(11.5, ...points.map((p) => p.voltage)) - 0.1;
  const hi = Math.max(13, ...points.map((p) => p.voltage)) + 0.1;
  const y = (v) => h - ((v - lo) / (hi - lo)) * h;
  const t0 = new Date(points[0].at).getTime();
  const span = Math.max(1, new Date(latest.at).getTime() - t0);
  const pad = 8 * devicePixelRatio;
  const x = (p) => pad + ((new Date(p.at).getTime() - t0) / span) * (w - 2 * pad);
  ctx.fillStyle = 'rgba(60, 207, 142, 0.12)';
  ctx.fillRect(0, y(12.7), w, y(12.4) - y(12.7));
  ctx.fillStyle = '#8a93a6';
  ctx.font = `${11 * devicePixelRatio}px sans-serif`;
  for (const v of [12, 12.5, 13]) ctx.fillText(`${v} V`, 2, y(v) - 2);
  for (const vin of new Set(points.map((p) => p.vin))) {
    const line = points.filter((p) => p.vin === vin);
    ctx.strokeStyle = '#4f8cff';
    ctx.lineWidth = 2 * devicePixelRatio;
    ctx.beginPath();
    line.forEach((p, i) => (i ? ctx.lineTo(x(p), y(p.voltage)) : ctx.moveTo(x(p), y(p.voltage))));
    ctx.stroke();
    for (const p of line) {
      ctx.fillStyle = p.voltage < 12.2 ? '#f0b429' : '#4f8cff';
      ctx.beginPath();
      ctx.arc(x(p), y(p.voltage), 3.5 * devicePixelRatio, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

async function renderHistory() {
  const items = await window.obd.historyList();
  renderBatteryTrend(items);
  const box = $('history-list');
  if (!items.length) return box.replaceChildren(el('div', { class: 'none muted' }, 'No saved scans yet. Every scan is saved here automatically.'));
  box.replaceChildren(
    el(
      'table',
      {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Result'), el('th', {}, 'Faults'), el('th', {}, 'VIN'), el('th', {}, ''))),
      el(
        'tbody',
        {},
        items.map((h) => {
          const sev = SEVERITY[h.overall] || SEVERITY.info;
          const open = el('button', { class: 'ghost small' }, 'Open');
          const del = el('button', { class: 'ghost small danger' }, 'Delete');
          open.addEventListener('click', async () => {
            showReport(await window.obd.historyLoad(h.id), true);
            setStatus('status', 'Showing a saved scan.');
            showView('scan');
          });
          del.addEventListener('click', async () => {
            if (!confirm('Delete this saved scan?')) return;
            await window.obd.historyRemove(h.id);
            renderHistory();
          });
          return el(
            'tr',
            {},
            el('td', {}, new Date(h.at).toLocaleString()),
            el('td', {}, el('span', { class: `badge ${h.overall || 'info'}` }, sev.label)),
            el('td', {}, String(h.faults)),
            el('td', { class: 'sub' }, h.vin || '-'),
            el('td', { class: 'row-actions' }, open, del),
          );
        }),
      ),
    ),
  );
}

// ---------- live ----------

const GAUGES = [
  { key: 'rpm', label: 'RPM', fmt: (v) => Math.round(v).toLocaleString() },
  { key: 'speed', label: 'Speed', unit: 'km/h', fmt: (v) => Math.round(v) },
  { key: 'boost', label: 'Boost', unit: 'bar', fmt: (v) => v.toFixed(2) },
  { key: 'throttle', label: 'Throttle', unit: '%', fmt: (v) => Math.round(v) },
  { key: 'load', label: 'Engine load', unit: '%', fmt: (v) => Math.round(v) },
  { key: 'coolant', label: 'Coolant', unit: '°C', fmt: (v) => Math.round(v), warn: (v) => v > 110 },
  { key: 'iat', label: 'Intake air', unit: '°C', fmt: (v) => Math.round(v), warn: (v) => v > 60 },
  { key: 'voltage', label: 'Battery', unit: 'V', fmt: (v) => v.toFixed(1), warn: (v) => v < 13.2 },
  { key: 'timing', label: 'Ignition timing', unit: '°', fmt: (v) => v.toFixed(1) },
  { key: 'stft', label: 'Short fuel trim', unit: '%', fmt: (v) => v.toFixed(1), warn: (v) => Math.abs(v) > 10 },
  { key: 'ltft', label: 'Long fuel trim', unit: '%', fmt: (v) => v.toFixed(1), warn: (v) => Math.abs(v) > 10 },
  { key: 'maf', label: 'Air flow', unit: 'g/s', fmt: (v) => v.toFixed(1) },
];

// samples: every reading of the current/last session, for Save CSV (about 2
// hours at the usual rate before the oldest are dropped).
const MAX_SAMPLES = 20000;
const liveState = { running: false, series: { rpm: [], boost: [] }, peaks: {}, lastMisfires: {}, samples: [] };

function buildGauges() {
  $('gauges').replaceChildren(
    ...GAUGES.map((g) =>
      el('div', { class: 'gauge', id: `g-${g.key}` }, el('div', { class: 'k' }, g.label), el('div', { class: 'v' }, '–', g.unit ? el('span', { class: 'unit' }, g.unit) : null), el('div', { class: 'peak sub' }, '')),
    ),
  );
}

function drawChart(canvas, points, { min = 0, max, color }) {
  const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
  const h = (canvas.height = 120 * devicePixelRatio);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#262b36';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(0, (h * i) / 4);
    ctx.lineTo(w, (h * i) / 4);
    ctx.stroke();
  }
  if (points.length < 2) return;
  const now = Date.now();
  const top = Math.max(max, ...points.map((p) => p.v));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * devicePixelRatio;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = w - ((now - p.t) / 60000) * w;
    const y = h - ((p.v - min) / (top - min)) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function onLiveData({ t, values, misfires }) {
  liveState.samples.push({ t, values, misfires });
  if (liveState.samples.length > MAX_SAMPLES) liveState.samples.shift();
  setStatus('live-status', `Live · updated ${new Date(t).toLocaleTimeString()} · ${liveState.samples.length} readings recorded`);
  for (const g of GAUGES) {
    const v = values[g.key];
    if (v === undefined) continue;
    const box = $(`g-${g.key}`);
    box.querySelector('.v').firstChild.textContent = g.fmt(v);
    box.classList.toggle('warn', Boolean(g.warn && g.warn(v)));
    const peak = liveState.peaks[g.key];
    if (peak === undefined || v > peak) liveState.peaks[g.key] = v;
    box.querySelector('.peak').textContent = `max ${g.fmt(liveState.peaks[g.key])}`;
  }
  for (const key of ['rpm', 'boost']) {
    if (values[key] === undefined) continue;
    const s = liveState.series[key];
    s.push({ t, v: values[key] });
    while (s.length && t - s[0].t > 60000) s.shift();
  }
  drawChart($('chart-rpm'), liveState.series.rpm, { max: 4000, color: '#4f8cff' });
  drawChart($('chart-boost'), liveState.series.boost, { min: -1, max: 1.5, color: '#3ccf8e' });

  if (misfires && misfires.length) {
    $('live-misfires').replaceChildren(
      ...misfires.map((m) => {
        const prev = liveState.lastMisfires[m.cylinder];
        const rising = prev !== undefined && m.current > prev;
        liveState.lastMisfires[m.cylinder] = m.current;
        return el('div', { class: `lm ${rising ? 'rising' : ''} ${m.current > 0 ? 'some' : ''}` }, el('div', { class: 'k' }, `Cylinder ${m.cylinder}`), el('div', { class: 'v' }, String(m.current ?? '–')));
      }),
    );
  }
}

async function toggleLive() {
  if (liveState.running) {
    $('live-toggle').disabled = true;
    await window.obd.liveStop();
    return;
  }
  const port = $('port').value;
  if (!port) return setStatus('live-status', 'Plug in the USB cable first, then press Start.', true);
  if (!checkPortChoice()) return setStatus('live-status', $('status').textContent, true);
  liveState.series = { rpm: [], boost: [] };
  liveState.peaks = {};
  liveState.lastMisfires = {};
  liveState.samples = [];
  $('live-csv').hidden = true;
  buildGauges();
  setStatus('live-status', 'Connecting…');
  try {
    await window.obd.liveStart(port);
    liveState.running = true;
    $('live-toggle').textContent = 'Stop';
    $('scan').disabled = true;
  } catch (err) {
    setStatus('live-status', cleanError(err), true);
  }
}

window.obd.onLiveData(onLiveData);
window.obd.onLiveError((msg) => setStatus('live-status', msg, true));
window.obd.onLiveStopped(() => {
  liveState.running = false;
  $('live-toggle').textContent = 'Start';
  $('live-toggle').disabled = false;
  $('scan').disabled = false;
  $('live-csv').hidden = !liveState.samples.length;
  if (!$('live-status').classList.contains('error')) setStatus('live-status', liveState.samples.length ? `Stopped. ${liveState.samples.length} readings recorded; Save CSV to keep them.` : 'Stopped.');
});

async function saveLiveCsv() {
  try {
    const file = await window.obd.saveLiveCsv(liveState.samples);
    if (file) setStatus('live-status', `Saved ${file}`);
  } catch (err) {
    setStatus('live-status', cleanError(err), true);
  }
}

// ---------- features (coding) ----------
// The page only ever sends { featureId, value } or raw { module, did, hex }. The main
// process plans from its own reading and asks for confirmation in a native dialog.

const CATEGORY_ORDER = ['Lights', 'Locking', 'Instruments', 'Comfort', 'Infotainment'];
const coding = {
  reading: null,
  pending: new Map(), // featureId -> value
  raw: new Map(), // `${moduleKey}:${did}` -> { module, did, hex }
  rawSel: null, // { key, index }
  busy: false,
  platformsLoaded: false,
};

const didKey = (d) => (typeof d === 'number' ? d : parseInt(d, 16)).toString(16).toUpperCase().padStart(4, '0');
const hexByte = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const bytesOf = (hex) => hex.match(/../g) || [];
const moduleOf = (key) => (coding.reading ? coding.reading.modules.find((m) => m.key === key) : null);
const featureById = (id) => (coding.reading ? coding.reading.features.find((f) => f.id === id) : null);
const canWrite = () => Boolean(coding.reading && coding.reading.platform && coding.reading.platform.writable);
const optionLabel = (f, v) => {
  const o = f.options.find((x) => x.value === v);
  return o ? o.label : 'Unknown';
};
const rawChangedBytes = () => {
  let n = 0;
  for (const [key, r] of coding.raw) {
    const [modKey, did] = key.split(':');
    const orig = bytesOf(moduleOf(modKey).data[did]);
    bytesOf(r.hex).forEach((b, i) => { if (b.toUpperCase() !== orig[i].toUpperCase()) n++; });
  }
  return n;
};
const pendingCount = () => coding.pending.size + rawChangedBytes();

async function loadPlatforms() {
  if (coding.platformsLoaded) return;
  try {
    const list = await window.obd.codingPlatforms();
    coding.platformsLoaded = true;
    $('coding-platforms').replaceChildren(
      el('div', { class: 'k' }, 'Cars with a settings list'),
      ...list.map((p) =>
        el('div', { class: 'platform' }, el('span', {}, p.label), el('span', { class: `badge ${p.verified ? 'ok' : 'caution'}` }, p.verified ? 'checked on a real car' : 'not yet checked on a car'), p.writable ? null : el('span', { class: 'sub' }, 'look only, no changes yet')),
      ),
    );
  } catch {
    // The explainer works without the list.
  }
}

// Why a feature's control is switched off, or null if it can be changed.
function featureLock(f) {
  const m = moduleOf(f.module);
  if (!canWrite()) return 'Changes are switched off for this car until it has been checked on a real car.';
  if (!f.available) return f.reason || 'Not available on this car.';
  if (!m || !m.responded) return "This part of the car didn't answer when it was read.";
  if (!m.codeable) return "This part of the car can't be changed with this app.";
  if (f.current === null || f.current === undefined) return "The car has a setting here that the app doesn't recognise, so it is left alone.";
  if (coding.raw.has(`${f.module}:${didKey(f.did)}`)) return 'Already being changed under Advanced: raw coding. Discard that change first.';
  return null;
}

function featureRow(f) {
  const lock = featureLock(f);
  const row = el('div', { class: 'feature' });
  const state = el('span', { class: 'f-state' });
  const value = () => (coding.pending.has(f.id) ? coding.pending.get(f.id) : f.current);
  const sync = () => {
    const changed = coding.pending.has(f.id);
    row.classList.toggle('changed', changed);
    state.textContent = changed ? `${optionLabel(f, value())} (now ${optionLabel(f, f.current)})` : optionLabel(f, f.current);
  };
  const change = (v) => {
    if (v === f.current) coding.pending.delete(f.id);
    else coding.pending.set(f.id, v);
    sync();
    renderTray();
    renderRaw();
  };

  let control;
  if (f.options.length === 2) {
    const [off, on] = f.options;
    const input = el('input', { type: 'checkbox', 'aria-label': f.name });
    input.checked = value() === on.value;
    input.disabled = Boolean(lock);
    input.addEventListener('change', () => change(input.checked ? on.value : off.value));
    control = el('label', { class: 'switch' }, input, el('span', { class: 'slider' }));
  } else {
    const select = el('select', { 'aria-label': f.name, class: 'f-select' }, f.options.map((o) => el('option', { value: String(o.value) }, o.label)));
    if (value() === null || value() === undefined) {
      select.prepend(el('option', { value: '' }, 'Unknown'));
      select.value = '';
    } else {
      select.value = String(value());
    }
    select.disabled = Boolean(lock);
    select.addEventListener('change', () => change(Number(select.value)));
    control = select;
  }

  const mod = moduleOf(f.module);
  row.append(
    el(
      'div',
      { class: 'f-info' },
      el('div', { class: 'f-name' }, el('strong', {}, f.name), f.verified ? null : el('span', { class: 'badge caution', title: 'The location of this setting comes from public research and has not been tried on a real car yet.' }, 'unverified'), mod ? el('span', { class: 'chip' }, mod.name) : null),
      f.description ? el('div', { class: 'sub' }, f.description) : null,
      f.needs ? el('div', { class: 'sub' }, `Needs: ${f.needs}`) : null,
      lock ? el('div', { class: 'lock' }, lock) : null,
    ),
    el('div', { class: 'f-control' }, state, control),
  );
  sync();
  return row;
}

function renderCar() {
  const r = coding.reading;
  const box = $('coding-car');
  box.hidden = !r;
  if (!r) return;
  const p = r.platform;
  const answered = r.modules.filter((m) => m.responded).length;
  const v = r.voltage;
  const voltOk = typeof v === 'number' && v >= 12.4;
  const tile = (k, main, sub, tone = '') => el('div', { class: 'card' }, el('div', { class: 'k' }, k), el('div', { class: `v ${tone}` }, main), sub ? el('div', { class: 'sub' }, sub) : null);
  box.replaceChildren(
    el(
      'section',
      { class: 'cards car-strip' },
      tile('Car', p ? p.label : 'Not in the list', p ? (p.verified ? 'Checked on a real car' : 'Not yet checked on a real car') : 'No coding list for this car yet', p ? '' : 'warn'),
      tile('Battery', typeof v === 'number' ? `${v.toFixed(1)} V` : '-', voltOk ? 'Good enough to write' : 'Needs 12.4 V or more to write', voltOk ? 'ok' : 'warn'),
      tile('Parts of the car read', `${answered} of ${r.modules.length}`, answered < r.modules.length ? "The others didn't answer" : 'All answered'),
      tile('VIN', r.vin || '-', ''),
    ),
  );
}

function renderList() {
  const r = coding.reading;
  const box = $('coding-list');
  if (!r) return box.replaceChildren();
  if (!r.platform) {
    return box.replaceChildren(el('div', { class: 'panel' }, el('strong', {}, 'No coding list for this car yet'), el('p', { class: 'sub' }, "The app doesn't know which settings this car has, so nothing is shown here and nothing can be changed.")));
  }
  const out = [];
  if (!r.platform.writable) {
    out.push(el('div', { class: 'note' }, "Writes are off for this car until it has been checked on a real car. You can look at its settings, but not change them."));
  }
  if (!r.features.length) out.push(el('div', { class: 'none muted' }, 'No settings in the list for the parts of this car that answered.'));
  const cats = [...new Set(r.features.map((f) => f.category))].sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a);
    const ib = CATEGORY_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  for (const cat of cats) {
    out.push(el('h2', {}, cat), el('div', { class: 'feature-group' }, r.features.filter((f) => f.category === cat).map(featureRow)));
  }
  box.replaceChildren(...out);
}

// ---- pending tray + review ----

function featureBytes(f) {
  const m = moduleOf(f.module);
  const hex = m && m.data && m.data[didKey(f.did)];
  if (!hex) return null;
  const before = parseInt(bytesOf(hex)[f.byte], 16);
  let after = before;
  for (const g of coding.reading.features) {
    if (coding.pending.has(g.id) && g.module === f.module && didKey(g.did) === didKey(f.did) && g.byte === f.byte) after = (after & ~g.mask & 0xff) | coding.pending.get(g.id);
  }
  return { before, after };
}

function renderReview() {
  const rows = [];
  for (const [id, value] of coding.pending) {
    const f = featureById(id);
    const b = featureBytes(f);
    rows.push(el('tr', {}, el('td', {}, el('strong', {}, f.name), el('div', { class: 'sub' }, (moduleOf(f.module) || {}).name || f.module)), el('td', {}, optionLabel(f, f.current)), el('td', {}, optionLabel(f, value)), el('td', { class: 'code sub' }, b ? `byte ${f.byte}: ${hexByte(b.before)} → ${hexByte(b.after)}` : '-')));
  }
  for (const [key, r] of coding.raw) {
    const [modKey, did] = key.split(':');
    const m = moduleOf(modKey);
    const orig = bytesOf(m.data[did]);
    bytesOf(r.hex).forEach((b, i) => {
      if (b.toUpperCase() === orig[i].toUpperCase()) return;
      rows.push(el('tr', {}, el('td', {}, el('strong', {}, 'Raw coding'), el('div', { class: 'sub' }, m.name)), el('td', { class: 'code' }, orig[i].toUpperCase()), el('td', { class: 'code' }, b.toUpperCase()), el('td', { class: 'code sub' }, `data ${did.toUpperCase()}, byte ${i}`)));
    });
  }
  $('coding-review').replaceChildren(
    el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Setting'), el('th', {}, 'Now'), el('th', {}, 'After'), el('th', {}, 'Raw bytes'))), el('tbody', {}, rows)),
    el('p', { class: 'sub' }, "Nothing is written yet. You'll be asked to confirm once more, and the old values are saved first."),
  );
}

function renderTray() {
  const n = pendingCount();
  $('coding-tray').hidden = n === 0;
  $('coding-tray-count').textContent = `${n} change${n === 1 ? '' : 's'} ready`;
  if (!n) $('coding-review').hidden = true;
  else if (!$('coding-review').hidden) renderReview();
  $('coding-review-btn').textContent = $('coding-review').hidden ? 'Review' : 'Hide review';
}

function discardPending() {
  coding.pending.clear();
  coding.raw.clear();
  coding.rawSel = null;
  renderList();
  renderRaw();
  renderTray();
}

// ---- advanced: raw coding ----

function setRawByte(m, did, orig, index, value) {
  const key = `${m.key}:${did}`;
  const cur = coding.raw.has(key) ? coding.raw.get(key).hex : orig;
  const arr = bytesOf(cur);
  arr[index] = hexByte(value);
  const next = arr.join('');
  if (next.toUpperCase() === orig.toUpperCase()) coding.raw.delete(key);
  else coding.raw.set(key, { module: m.key, did, hex: next });
  renderRaw();
  renderList();
  renderTray();
}

function rawBlock(m, did, orig) {
  const key = `${m.key}:${did}`;
  const cur = coding.raw.has(key) ? coding.raw.get(key).hex : orig;
  const was = bytesOf(orig);
  const now = bytesOf(cur);
  const featureTouches = [...coding.pending.keys()].some((id) => {
    const f = featureById(id);
    return f && f.module === m.key && didKey(f.did) === did;
  });
  let why = null;
  if (!canWrite()) why = 'Read only for this car.';
  else if (!m.codeable) why = "This part of the car can't be changed with this app.";
  else if (featureTouches) why = 'This data is already being changed from the list above. Discard that first.';
  const sel = coding.rawSel && coding.rawSel.key === key ? coding.rawSel.index : null;

  const grid = el(
    'div',
    { class: 'bytes' },
    now.map((b, i) => {
      const btn = el('button', { class: `byte${b.toUpperCase() !== was[i].toUpperCase() ? ' changed' : ''}${sel === i ? ' sel' : ''}`, title: `Byte ${i}` }, b.toUpperCase());
      btn.addEventListener('click', () => {
        coding.rawSel = sel === i ? null : { key, index: i };
        renderRaw();
      });
      return btn;
    }),
  );
  let bits = null;
  if (sel !== null) {
    const val = parseInt(now[sel], 16);
    bits = el(
      'div',
      { class: 'bits' },
      el('span', { class: 'sub' }, `Byte ${sel} (${hexByte(parseInt(was[sel], 16))} when read), bits 7 to 0`),
      [7, 6, 5, 4, 3, 2, 1, 0].map((bit) => {
        const input = el('input', { type: 'checkbox' });
        input.checked = Boolean((val >> bit) & 1);
        input.disabled = Boolean(why);
        input.addEventListener('change', () => setRawByte(m, did, orig, sel, val ^ (1 << bit)));
        return el('label', { class: 'bit' }, input, String(bit));
      }),
    );
  }
  return el('div', { class: 'raw-block' }, el('div', { class: 'raw-title' }, el('strong', {}, m.name), el('span', { class: 'sub' }, ` · data ${did.toUpperCase()} · ${was.length} bytes`)), why ? el('div', { class: 'lock' }, why) : null, grid, bits);
}

function renderRaw() {
  const r = coding.reading;
  const mods = r ? r.modules.filter((m) => m.responded && m.data && Object.keys(m.data).length) : [];
  $('coding-raw').hidden = !mods.length;
  $('coding-raw-body').replaceChildren(...mods.flatMap((m) => Object.entries(m.data).map(([did, hex]) => rawBlock(m, did, hex))));
}

// ---- actions ----

function codingPort() {
  const port = $('port').value;
  if (!port) {
    setStatus('coding-status', 'Plug in the USB cable first.', true);
    return null;
  }
  if (!checkPortChoice()) {
    setStatus('coding-status', $('status').textContent, true);
    return null;
  }
  return port;
}

function setCodingBusy(b) {
  coding.busy = b;
  $('view-features').classList.toggle('working', b);
  for (const id of ['coding-read', 'coding-backups-btn', 'coding-write', 'coding-discard']) $(id).disabled = b;
  $('scan').disabled = b || liveState.running;
}

function renderCodingAll() {
  renderCar();
  renderList();
  renderRaw();
  renderTray();
}

async function readCar() {
  if (coding.busy) return;
  const port = codingPort();
  if (!port) return;
  if (pendingCount() && !confirm('Discard your pending changes and read the car again?')) return;
  setCodingBusy(true);
  setStatus('coding-status', 'Starting…');
  try {
    const reading = await window.obd.codingRead(port);
    if (reading && reading.error) return setStatus('coding-status', reading.error, true);
    coding.reading = reading;
    coding.pending.clear();
    coding.raw.clear();
    coding.rawSel = null;
    $('coding-intro').hidden = true;
    $('coding-results').hidden = true;
    $('coding-backups').hidden = true;
    renderCodingAll();
    const usable = reading.features.filter((f) => f.available).length;
    setStatus('coding-status', reading.platform ? `Read ${new Date(reading.at).toLocaleTimeString()}. ${usable} setting${usable === 1 ? '' : 's'} available. Nothing has been changed.` : 'Read finished. No coding list for this car yet.');
  } catch (err) {
    setStatus('coding-status', cleanError(err), true);
  } finally {
    setCodingBusy(false);
  }
}

function openBackupsButton() {
  const b = el('button', { class: 'ghost' }, 'Open Backups');
  b.addEventListener('click', toggleBackups);
  return b;
}

function showResults(results, names, heading) {
  const failed = results.filter((r) => !r.ok);
  const box = $('coding-results');
  box.replaceChildren(
    el('h3', {}, failed.length ? 'Not everything went through' : `${heading}: written and checked`),
    ...results.map((r) => {
      const m = moduleOf(r.module);
      const what = names.get(r.module);
      return el(
        'div',
        { class: 'result' },
        el('span', { class: r.ok ? 'ok' : 'bad' }, r.ok ? '✓ ' : '✗ '),
        el('strong', {}, m ? m.name : String(r.module)),
        what ? el('span', { class: 'sub' }, ` · ${what.join(', ')}`) : null,
        el('div', { class: r.ok ? 'sub' : 'bad' }, r.ok ? 'Written, then read back from the car to check it.' : `Not written: ${r.error || 'the car did not accept it'}.${r.readback ? ' The car stored something different from what was sent. Use Backups to put the old setting back.' : ''}`),
      );
    }),
    el('p', {}, failed.length ? "Anything marked ✗ is unchanged unless it says otherwise. You can restore earlier settings from Backups." : 'Now switch the ignition off, wait about 10 seconds, then switch it on again so the car picks up the new settings.'),
    ...(failed.length ? [el('div', { class: 'actions' }, openBackupsButton())] : []),
  );
  box.hidden = false;
  box.scrollIntoView({ block: 'start' });
}

async function writeNow() {
  if (coding.busy || !pendingCount()) return;
  const port = codingPort();
  if (!port) return;
  const changes = [
    ...[...coding.pending].map(([featureId, value]) => ({ featureId, value })),
    ...[...coding.raw.values()].map((r) => ({ module: r.module, did: r.did, hex: r.hex })),
  ];
  const names = new Map();
  const note = (mod, name) => names.set(mod, [...(names.get(mod) || []), name]);
  for (const id of coding.pending.keys()) note(featureById(id).module, featureById(id).name);
  for (const r of coding.raw.values()) note(r.module, 'raw coding');
  setCodingBusy(true);
  setStatus('coding-status', 'Waiting for your confirmation…');
  try {
    const res = await window.obd.codingWrite(port, changes);
    if (!res) return setStatus('coding-status', 'Cancelled. Nothing was written.');
    coding.reading = res.reading;
    discardPending();
    renderCar();
    showResults(res.results, names, 'Changes');
    setStatus('coding-status', res.results.every((r) => r.ok) ? 'Done. The settings below are what the car now reports.' : 'Some changes did not go through. See the details above.', !res.results.every((r) => r.ok));
    if (!$('coding-backups').hidden) loadBackups();
  } catch (err) {
    setStatus('coding-status', cleanError(err), true);
  } finally {
    setCodingBusy(false);
  }
}

// ---- backups ----

async function toggleBackups() {
  const panel = $('coding-backups');
  if (!panel.hidden) return (panel.hidden = true);
  if (!coding.reading || !coding.reading.vin) return setStatus('coding-status', "Read the car first, so the app knows which car's backups to show.", true);
  loadBackups();
}

async function loadBackups() {
  try {
    const list = await window.obd.codingBackups(coding.reading.vin);
    renderBackups(Array.isArray(list) ? list : []);
  } catch (err) {
    setStatus('coding-status', cleanError(err), true);
  }
}

function renderBackups(list) {
  const panel = $('coding-backups');
  panel.hidden = false;
  const byModule = new Map();
  for (const rec of [...list].sort((a, b) => String(b.at).localeCompare(String(a.at)))) {
    const k = rec.name || rec.module;
    byModule.set(k, [...(byModule.get(k) || []), rec]);
  }
  panel.replaceChildren(
    el('h3', {}, 'Backups'),
    el('p', { class: 'sub' }, 'Saved automatically: the original settings the first time each part of the car was read, and the settings before every change. Restore puts a saved version back on the car.'),
    ...(byModule.size
      ? [...byModule].map(([name, recs]) =>
          el(
            'div',
            { class: 'backup-group' },
            el('strong', {}, name),
            recs.map((rec) => {
              const restore = el('button', { class: 'ghost small' }, 'Restore…');
              restore.disabled = !canWrite() || coding.busy;
              restore.addEventListener('click', () => restoreBackup(rec));
              const original = rec.original === true || /orig/i.test(String(rec.reason));
              return el('div', { class: 'backup' }, el('span', { class: 'grow' }, new Date(rec.at).toLocaleString()), el('span', { class: `badge ${original ? 'ok' : ''}` }, original ? 'Original' : 'Before a change'), restore);
            }),
          ),
        )
      : [el('div', { class: 'none muted' }, 'No backups yet for this car.')]),
  );
}

async function restoreBackup(rec) {
  if (coding.busy) return;
  const port = codingPort();
  if (!port) return;
  if (pendingCount() && !confirm('Discard your pending changes and restore this backup?')) return;
  setCodingBusy(true);
  setStatus('coding-status', 'Waiting for your confirmation…');
  try {
    const res = await window.obd.codingRestore(port, rec.id);
    if (!res) return setStatus('coding-status', 'Cancelled. Nothing was changed.');
    coding.reading = res.reading;
    discardPending();
    renderCar();
    showResults(res.results, new Map([[rec.module, ['restored from backup']]]), 'Restore');
    setStatus('coding-status', res.results.every((r) => r.ok) ? 'Restored. The settings below are what the car now reports.' : 'The restore did not fully go through. See the details above.', !res.results.every((r) => r.ok));
    loadBackups();
  } catch (err) {
    setStatus('coding-status', cleanError(err), true);
  } finally {
    setCodingBusy(false);
  }
}

// ---------- wiring ----------

window.obd.onProgress((label) => setStatus(currentView === 'features' ? 'coding-status' : 'status', `${label}…`));
window.obd.onLog((line) => {
  $('log').textContent += `${line}\n`;
});
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showView(t.dataset.view));
$('refresh').addEventListener('click', () => {
  portKey = '';
  loadPorts();
});
$('port').addEventListener('change', checkPortChoice);
window.obd.onAppError((msg) => setStatus(currentView === 'live' ? 'live-status' : currentView === 'features' ? 'coding-status' : 'status', msg, true));
$('coding-read').addEventListener('click', readCar);
$('coding-backups-btn').addEventListener('click', toggleBackups);
$('coding-write').addEventListener('click', writeNow);
$('coding-discard').addEventListener('click', discardPending);
$('coding-review-btn').addEventListener('click', () => {
  $('coding-review').hidden = !$('coding-review').hidden;
  renderTray();
});
// Notice the cable being plugged in or out.
setInterval(loadPorts, 3000);
$('scan').addEventListener('click', runScan);
$('copy').addEventListener('click', () => exportReport('copy'));
$('save-txt').addEventListener('click', () => exportReport('txt'));
$('save-pdf').addEventListener('click', () => exportReport('pdf'));
$('clear-open').addEventListener('click', openClearPanel);
$('clear-cancel').addEventListener('click', () => ($('clear-panel').hidden = true));
$('clear-run').addEventListener('click', runClear);
$('live-toggle').addEventListener('click', toggleLive);
$('live-csv').addEventListener('click', saveLiveCsv);
$('live-reset').addEventListener('click', () => {
  liveState.peaks = {};
});
buildGauges();
loadPorts();
