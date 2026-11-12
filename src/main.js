const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const { Elm } = require('./elm');
const { scan } = require('./scan');
const { clearFaults } = require('./clear');
const { ReplayElm } = require('./replay');
const { LiveSession, samplesToCsv } = require('./live');
const { buildAdvice } = require('./advice');
const { History, compareReports } = require('./history');
const { reportText } = require('./reportText');
const { readCoding, planChanges, writeCoding, planRestore } = require('./coding');
const { CodingStore } = require('./codingStore');
const { PLATFORMS, canWrite } = require('./codingCatalog');

// --demo replays a recorded scan instead of using a real cable.
const DEMO = process.argv.includes('--demo');
const DEMO_PORT = { path: 'DEMO', label: 'Demo (recorded Audi S1 scan)', likelyAdapter: true };

let win;
let busy = null; // 'scan' | 'live' | 'clear' | 'coding'
let live = null;
let history;
let codingStore;
let lastReading = null; // coding plans are always built from this, never from renderer data

function createWindow() {
  win = new BrowserWindow({
    width: 1140,
    height: 860,
    minWidth: 780,
    backgroundColor: '#0f1115',
    title: 'OBD Reader',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

const sendToUi = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

function adapterFor(portPath, log, delayMs = 0) {
  return portPath === DEMO_PORT.path ? new ReplayElm(log, delayMs) : new Elm(log);
}

function claim(kind) {
  if (busy) {
    throw new Error(
      busy === 'live' ? 'Stop the live dashboard first.' : busy === 'coding' ? 'Car coding is already in progress. Wait for it to finish.' : 'A scan is already running.',
    );
  }
  busy = kind;
}

ipcMain.handle('ports:list', async () => (DEMO ? [DEMO_PORT] : Elm.listPorts()));

async function scanAndSave(elm, options, extra = {}) {
  const memory = (vin) => history.carMemory(vin);
  const report = await scan(elm, (label) => sendToUi('scan:progress', label), { ...options, memory });
  if (report.error) return report;
  Object.assign(report, extra);
  report.advice = buildAdvice(report, history.adviceContext(report));
  const prev = history.latest(report.vin);
  if (prev) report.comparison = compareReports(prev, report);
  history.save(report);
  return report;
}

ipcMain.handle('scan:run', async (_e, portPath, options = {}) => {
  claim('scan');
  const elm = adapterFor(portPath, (line) => sendToUi('scan:log', line));
  try {
    await elm.open(portPath);
    return await scanAndSave(elm, { search: options.search === true });
  } finally {
    await elm.close();
    busy = null;
  }
});

// Clear the chosen codes, after a native confirmation the page can't skip,
// then rescan so the report shows what actually went.
ipcMain.handle('clear:run', async (_e, portPath, targets, options = {}) => {
  const names = [...(targets.engine ? ['Engine (codes, misfire counters, freeze frame)'] : []), ...(targets.modules || []).map((m) => m.name)];
  if (!names.length) return null;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Clear all fault codes',
    message: `Clear all fault codes (${names.length} module${names.length > 1 ? 's' : ''})?`,
    detail: `${names.join('\n')}\n\nClearing doesn't fix anything: a real fault comes straight back. It also resets the emissions readiness monitors, so the car can't pass an MOT emissions test until it has been driven for a while. Engine off, ignition on.`,
    buttons: ['Cancel', 'Clear codes'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return null;
  claim('clear');
  const elm = adapterFor(portPath, (line) => sendToUi('scan:log', line));
  try {
    await elm.open(portPath);
    const cleared = await clearFaults(elm, targets, (label) => sendToUi('scan:progress', label));
    return await scanAndSave(elm, { search: options.search === true }, { cleared });
  } finally {
    await elm.close();
    busy = null;
  }
});

// ---------- coding (feature unlocking; the only path that writes to the car) ----------

const didKey = (d) => (typeof d === 'number' ? d : parseInt(String(d), 16)).toString(16).toUpperCase().padStart(4, '0');
const hex2 = (v) => (typeof v === 'number' ? v.toString(16).toUpperCase().padStart(2, '0') : String(v));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function checkPort(portPath) {
  if (typeof portPath !== 'string' || !portPath || portPath.length > 200) throw new Error('Pick the USB cable port first.');
  return portPath;
}

// The page is untrusted: accept only these two shapes and rebuild them from scratch.
function validateChanges(changes) {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 64) throw new Error('Invalid change list.');
  return changes.map((c) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('Invalid change.');
    const keys = Object.keys(c).sort().join(',');
    if (keys === 'featureId,value') {
      if (typeof c.featureId !== 'string' || !/^[\w.-]{1,100}$/.test(c.featureId)) throw new Error('Invalid setting id.');
      if (!Number.isInteger(c.value) || c.value < 0 || c.value > 0xff) throw new Error('Invalid setting value.');
      return { featureId: c.featureId, value: c.value };
    }
    if (keys === 'did,hex,module') {
      if (typeof c.module !== 'string' || !/^\w{1,16}$/.test(c.module)) throw new Error('Invalid module.');
      const did = typeof c.did === 'number' ? c.did : typeof c.did === 'string' && /^[0-9a-fA-F]{4}$/.test(c.did) ? parseInt(c.did, 16) : NaN;
      if (!Number.isInteger(did) || did < 0 || did > 0xffff) throw new Error('Invalid data identifier.');
      if (typeof c.hex !== 'string' || !/^([0-9a-fA-F]{2}){1,256}$/.test(c.hex)) throw new Error('Invalid coding bytes.');
      return { module: c.module, did: did.toString(16).toUpperCase().padStart(4, '0'), hex: c.hex };
    }
    throw new Error('Invalid change.');
  });
}

function checkBackupId(id) {
  if (typeof id !== 'string' || !/^[\w.-]{1,200}$/.test(id) || id.includes('..')) throw new Error('Invalid backup id.');
  return id;
}

function checkVin(vin) {
  if (typeof vin !== 'string' || !/^[A-Za-z0-9]{6,32}$/.test(vin)) throw new Error('Invalid VIN.');
  return vin;
}

// Plain-text list of everything that is about to be written (the native confirm shows it).
function describePlan(reading, plan) {
  const lines = [];
  if (reading.platform && !reading.platform.verified) {
    lines.push(`This car's coding list (${reading.platform.label}) has not been checked on a real car yet.`, '');
  }
  for (const item of plan) {
    lines.push(item.restore ? `${item.name} (restore saved coding from ${item.restore.at || 'a backup'})` : item.name);
    for (const s of item.settings || []) lines.push(`  - ${s.name}: ${s.before} -> ${s.after}`);
    for (const e of item.edits || []) {
      const label = e.features && e.features.length ? e.features.join(', ') : 'Raw coding edit';
      lines.push(`    ${label}: byte ${e.byte}: ${hex2(e.before)} -> ${hex2(e.after)}   (data ${didKey(item.did)})`);
    }
    if (item.unverified && item.unverified.length) lines.push(`  NOT YET CONFIRMED ON A CAR: ${item.unverified.join(', ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function confirmPlan(reading, plan, { title, verb }) {
  if (!plan.length) throw new Error('Nothing to change: the car already has those settings.');
  const moduleCount = new Set(plan.map((p) => p.module)).size;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title,
    message: `${verb} ${plural(plan.length, 'change')} in ${plural(moduleCount, 'module')}?`,
    detail: `${describePlan(reading, plan)}\nThe old values are saved first so they can be restored. Engine off, ignition on, battery at 12.4 V or more (a charger is best), and don't unplug the cable until it finishes.`,
    buttons: ['Cancel', verb],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return response === 1;
}

// Demo coding state is shared by every ReplayElm, so demo writes persist between reads.
const codingAdapter = (portPath) => adapterFor(portPath, (line) => sendToUi('scan:log', line));

// Claims the adapter for coding (so it can't overlap a scan or live session), runs fn, releases it.
async function withCoding(portPath, fn) {
  claim('coding');
  const elm = codingAdapter(portPath);
  try {
    await elm.open(portPath);
    return await fn(elm);
  } finally {
    await elm.close();
    busy = null;
  }
}

const sendProgress = (label) => sendToUi('scan:progress', label);

// Reads the car, keeps the reading for planning, and saves each module's first-seen coding as its original.
async function readAndRemember(elm) {
  const reading = await readCoding(elm, sendProgress);
  if (reading.error) throw new Error(reading.error); // not a usable reading: don't keep it or save originals
  try {
    codingStore.saveOriginals(reading);
  } catch (err) {
    console.error('saveOriginals failed', err);
  }
  lastReading = reading;
  const { transcript, ...forUi } = reading;
  return forUi;
}

// Writes a plan, logs it, then re-reads the car so the UI shows what is really stored now.
async function applyPlan(elm, plan, changes) {
  const reading = lastReading;
  const outcome = await writeCoding(elm, reading, plan, { backup: (rec) => codingStore.saveBackup(rec), onProgress: sendProgress });
  try {
    codingStore.logChange({ vin: reading.vin, at: outcome.at, changes, plan, results: outcome.results });
  } catch (err) {
    console.error('logChange failed', err);
  }
  const fresh = await readAndRemember(elm);
  return { results: outcome.results, reading: fresh };
}

ipcMain.handle('coding:platforms', () =>
  PLATFORMS.map((p) => ({ id: p.id, label: p.label, writable: canWrite(p), verified: p.verified === true })),
);

ipcMain.handle('coding:read', (_e, portPath) => {
  checkPort(portPath);
  return withCoding(portPath, readAndRemember);
});

ipcMain.handle('coding:write', async (_e, portPath, changes) => {
  checkPort(portPath);
  const valid = validateChanges(changes);
  if (!lastReading) throw new Error('Read the car first.');
  claim('coding');
  const elm = codingAdapter(portPath);
  try {
    const plan = planChanges(lastReading, valid); // from main's own reading, not from the page
    if (!(await confirmPlan(lastReading, plan, { title: 'Write to car', verb: 'Write to car' }))) return null;
    await elm.open(portPath);
    return await applyPlan(elm, plan, valid);
  } finally {
    await elm.close();
    busy = null;
  }
});

ipcMain.handle('coding:backups', (_e, vin) => codingStore.list(checkVin(vin)));

ipcMain.handle('coding:restore', async (_e, portPath, backupId) => {
  checkPort(portPath);
  checkBackupId(backupId);
  if (!lastReading) throw new Error('Read the car first.');
  claim('coding');
  const elm = codingAdapter(portPath);
  try {
    const record = codingStore.load(backupId);
    if (!record || record.vin !== lastReading.vin) throw new Error('That backup is for a different car.');
    const plan = planRestore(lastReading, record);
    if (!(await confirmPlan(lastReading, plan, { title: 'Restore saved coding', verb: 'Restore' }))) return null;
    await elm.open(portPath);
    return await applyPlan(elm, plan, [{ restore: backupId }]);
  } finally {
    await elm.close();
    busy = null;
  }
});

ipcMain.handle('live:start', async (_e, portPath) => {
  claim('live');
  const elm = adapterFor(portPath, () => {}, 40);
  try {
    await elm.open(portPath);
  } catch (err) {
    busy = null;
    throw err;
  }
  live = new LiveSession(elm, (sample) => sendToUi('live:data', sample));
  live
    .start()
    .catch((err) => sendToUi('live:error', err.message))
    .finally(async () => {
      await elm.close();
      live = null;
      busy = null;
      sendToUi('live:stopped');
    });
});

ipcMain.handle('live:stop', () => {
  if (live) live.stop();
});

// The user fixed something (e.g. new coils and plugs): note it for this car,
// then redo the advice for the shown scan so it takes the repair into account.
ipcMain.handle('repair:mark', (_e, id, note) => {
  const saved = history.load(String(id));
  if (!saved.vin) throw new Error('This scan has no VIN, so the repair can\'t be linked to the car.');
  history.addRepair(saved.vin, typeof note === 'string' ? note.slice(0, 200) : '');
  // adviceContext only counts repairs made before the scan; this one is newer.
  saved.advice = buildAdvice(saved, { ...history.adviceContext(saved), repairs: history.repairs(saved.vin) });
  history.save(saved);
  return saved;
});

ipcMain.handle('live:saveCsv', async (_e, samples) => {
  if (!Array.isArray(samples) || !samples.length) return null;
  const stamp = new Date(samples[0].t).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), `live-data-${stamp}.csv`),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, samplesToCsv(samples));
  return filePath;
});

ipcMain.handle('history:list', () => history.list());
ipcMain.handle('history:load', (_e, id) => history.load(id));
ipcMain.handle('history:remove', (_e, id) => history.remove(id));

ipcMain.handle('report:copy', (_e, report) => {
  clipboard.writeText(reportText(report));
});

ipcMain.handle('report:save', async (_e, report, format) => {
  const stamp = (report.finishedAt || new Date().toISOString()).slice(0, 16).replace(/[:T]/g, '-');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), `car-scan-${stamp}.${format}`),
    filters: format === 'pdf' ? [{ name: 'PDF', extensions: ['pdf'] }] : [{ name: 'Text', extensions: ['txt'] }],
  });
  if (canceled || !filePath) return null;
  if (format === 'pdf') {
    const toggle = (on) => win.webContents.executeJavaScript(`document.body.classList.toggle('printing', ${on})`);
    await toggle(true);
    try {
      const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
      fs.writeFileSync(filePath, pdf);
    } finally {
      await toggle(false);
    }
  } else {
    fs.writeFileSync(filePath, reportText(report));
  }
  return filePath;
});

// Last-resort guard: show serial/IO errors in the app instead of a crash dialog.
process.on('uncaughtException', (err) => {
  console.error(err);
  sendToUi('app:error', err.message);
});

app.whenReady().then(() => {
  history = new History(path.join(app.getPath('userData'), DEMO ? 'history-demo' : 'history'));
  codingStore = new CodingStore(path.join(app.getPath('userData'), DEMO ? 'coding-demo' : 'coding'));
  createWindow();
});
app.on('window-all-closed', () => {
  if (live) live.stop();
  app.quit();
});
