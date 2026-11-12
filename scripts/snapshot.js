// Dev helper: electron scripts/snapshot.js <outDir>
// Runs the app in demo mode and saves scan.png, clear.png, live.png, history.png, features*.png and report.pdf.
const fs = require('node:fs');
const path = require('node:path');
const { app, dialog } = require('electron');

// Software rendering: capturePage can fail with UnknownVizError when the GPU process is unavailable.
app.disableHardwareAcceleration();

// There is nobody to click the native "Write to car" confirm: answer yes (button 1).
dialog.showMessageBox = async () => ({ response: 1 });

const outDir = process.argv[process.argv.length - 1];
process.argv.push('--demo');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    win.show();
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

      // Features tab: before reading, after a demo read, then one pending change under Review.
      await js("document.querySelector('[data-view=features]').click()");
      await wait(300);
      await shot('features-intro.png');
      await js("document.getElementById('coding-read').click()");
      await wait(3000);
      await shot('features.png');
      const toggled = await js("(() => { const c = document.querySelector('#coding-list input[type=checkbox]:not(:disabled)'); if (!c) return false; c.click(); return true; })()");
      if (toggled) {
        await js("document.getElementById('coding-review-btn').click()");
        await wait(300);
        await shot('features-review.png');
        // Write it (demo car): the native confirm is answered "yes" here, then show results and backups.
        await js("document.getElementById('coding-write').click()");
        await wait(3000);
        await shot('features-written.png');
        await js("document.getElementById('coding-backups-btn').click()");
        await wait(500);
        await shot('features-backups.png');
        win.setContentSize(780, 1400);
        await wait(400);
        fs.writeFileSync(path.join(outDir, 'features-narrow.png'), (await win.webContents.capturePage()).toPNG());
        win.setContentSize(1140, 860);
      } else {
        console.error('Features: no enabled switch found, skipped features-review.png');
      }
    } catch (err) {
      console.error(err && err.stack || err);
    }
    app.quit();
  });
});

require('../src/main.js');
