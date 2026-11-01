// Dev helper: electron scripts/diag.js COM7 COM5 ...
// Runs the real app, triggers a scan on each port through the UI bridge and
// logs results and any uncaught main-process errors.
const { app } = require('electron');

const ports = process.argv.slice(2).filter((a) => /^COM\d+$/i.test(a));
process.on('uncaughtException', (err) => console.log('UNCAUGHT (main):', err.stack || err));

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (_ev, level, message) => console.log('renderer:', message));
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    console.log('ports:', JSON.stringify(await js('window.obd.listPorts()')));
    for (const p of ports) {
      const t = Date.now();
      const res = await js(
        `window.obd.scan('${p}').then(r => 'OK ' + (r.error || (r.engine.memory.faults.length + ' engine faults'))).catch(e => 'ERR ' + e.message)`,
      );
      console.log(`${p}: ${res} (${Math.round((Date.now() - t) / 1000)} s)`);
    }
    app.quit();
  });
});

require('../src/main.js');
