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

// --demo replays a recorded scan instead of using a real cable.
const DEMO = process.argv.includes('--demo');
const DEMO_PORT = { path: 'DEMO', label: 'Demo (recorded Audi S1 scan)', likelyAdapter: true };

let win;
let busy = null; // 'scan' | 'live' | 'clear'
let live = null;
let history;

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
  if (busy) throw new Error(busy === 'live' ? 'Stop the live dashboard first.' : 'A scan is already running.');
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
  createWindow();
});
app.on('window-all-closed', () => {
  if (live) live.stop();
  app.quit();
});
