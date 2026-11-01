// Starts Electron with ELECTRON_RUN_AS_NODE cleared (some hosts, e.g. T3 Code,
// set it, which would make Electron run as plain Node). Extra args pass through.
const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
