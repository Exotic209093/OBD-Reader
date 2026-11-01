// Dev helper: electron scripts/snapshot.js <outDir>
// Runs the app in demo mode and saves scan.png, clear.png, live.png, history.png and report.pdf.
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const outDir = process.argv[process.argv.length - 1];
process.argv.push('--demo');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => {
      const height = await js('document.body.scrollHeight');
      win.setContentSize(1140, Math.min(height + 20, 2200));
      await wait(400);
      fs.writeFileSync(path.join(outDir, name), (await win.webContents.capturePage()).toPNG());
    };
    try {
      await wait(500);
      await js("document.getElementById('scan').click()");
      await wait(1500);
      await shot('scan.png');
      await js("document.getElementById('clear-open').click()");
      await wait(200);
      fs.writeFileSync(path.join(outDir, 'clear.png'), (await win.webContents.capturePage()).toPNG());
      await js("document.getElementById('clear-cancel').click()");

      await js("document.body.classList.add('printing')");
      fs.writeFileSync(path.join(outDir, 'report.pdf'), await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' }));
      await shot('print.png');
      await js("document.body.classList.remove('printing')");

      await js("document.querySelector('[data-view=live]').click(); document.getElementById('live-toggle').click()");
      await wait(6000);
      await shot('live.png');
      await js("document.querySelector('.charts').scrollIntoView()");
      await wait(300);
      fs.writeFileSync(path.join(outDir, 'live-charts.png'), (await win.webContents.capturePage()).toPNG());
      await js("document.getElementById('live-toggle').click()");
      await wait(500);

      await js("document.querySelector('[data-view=history]').click()");
      await wait(500);
      await shot('history.png');
    } catch (err) {
      console.error(err);
    }
    app.quit();
  });
});

require('../src/main.js');
