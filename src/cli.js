// Command-line scan: node src/cli.js [COMx] [--json] [--search]
// Saves to the same history as the app and prints the text report.
const path = require('node:path');
const { Elm } = require('./elm');
const { scan } = require('./scan');
const { buildAdvice } = require('./advice');
const { History, compareReports } = require('./history');
const { reportText } = require('./reportText');

const HISTORY_DIR = path.join(process.env.APPDATA || path.join(require('node:os').homedir(), '.config'), 'obd-reader', 'history');

async function main() {
  const args = process.argv.slice(2);
  let portPath = args.find((a) => !a.startsWith('--'));
  if (!portPath) {
    const ports = await Elm.listPorts();
    portPath = (ports.find((p) => p.likelyAdapter) || ports[0] || {}).path;
    if (!portPath) throw new Error('No serial ports found');
  }
  const elm = new Elm();
  try {
    await elm.open(portPath);
    const history = new History(HISTORY_DIR);
    const memory = (vin) => history.carMemory(vin);
    const report = await scan(elm, (label) => console.error(`.. ${label}`), { search: args.includes('--search'), memory });
    if (report.error) throw new Error(report.error);
    report.advice = buildAdvice(report, history.adviceContext(report));
    const prev = history.latest(report.vin);
    if (prev) report.comparison = compareReports(prev, report);
    history.save(report);
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : reportText(report));
  } finally {
    await elm.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
