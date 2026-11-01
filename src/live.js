// Live data: polls mode 01 PIDs and mode 06 misfire counters.
const d = require('./decode');

const { PIDS } = d;

const FAST = [0x0c, 0x0d, 0x0b, 0x11, 0x04, 0x0f];
const SLOW = [0x05, 0x42, 0x0e, 0x06, 0x07, 0x10];

// Parse a (possibly multi-PID) mode 01 reply into { key: value }.
function parsePids(raw) {
  const out = {};
  for (const m of d.parseMessages(raw)) {
    if (m.data[0] !== 0x41) continue;
    let i = 1;
    while (i < m.data.length) {
      const spec = PIDS[m.data[i]];
      if (!spec) break;
      const [len, key, fn] = spec;
      const bytes = m.data.slice(i + 1, i + 1 + len);
      if (bytes.length < len) break;
      out[key] = fn(bytes);
      i += 1 + len;
    }
  }
  return out;
}

const hex = (n) => n.toString(16).padStart(2, '0').toUpperCase();

class LiveSession {
  constructor(elm, onData) {
    this.elm = elm;
    this.onData = onData;
    this.running = false;
    this.multi = true;
  }

  async request(pids) {
    if (this.multi) {
      const values = parsePids(await this.elm.send(`01${pids.map(hex).join('')}`, 3000));
      if (Object.keys(values).length) return values;
      this.multi = false; // ECU doesn't accept grouped requests; fall back.
    }
    const values = {};
    for (const p of pids) Object.assign(values, parsePids(await this.elm.send(`01${hex(p)}`, 2000)));
    return values;
  }

  async misfires() {
    const counts = [];
    for (const [i, mid] of [0xa2, 0xa3, 0xa4, 0xa5].entries()) {
      const m = d.parseMisfire(await this.elm.send(`06${hex(mid)}`, 3000), mid);
      if (!m) break;
      counts.push({ cylinder: i + 1, current: m.current, recent: m.recent });
    }
    return counts;
  }

  async start() {
    this.running = true;
    for (const c of ['ATZ', 'ATE0', 'ATL0', 'ATH1', 'ATS1', 'ATCAF1', 'ATSP6', 'ATSH7E0', 'ATCRA7E8', 'ATFCSH7E0', 'ATFCSD300000', 'ATFCSM1', 'ATST 32']) {
      await this.elm.send(c, c === 'ATZ' ? 4000 : 2000);
    }
    const { baro = 101 } = await this.request([0x33]);
    let tick = 0;
    let slow = {};
    let misfires = [];
    while (this.running) {
      const fast = await this.request(FAST);
      if (!Object.keys(fast).length && tick === 0) throw new Error('The engine computer is not answering. Is the ignition on?');
      if (tick % 4 === 0) slow = await this.request(SLOW);
      if (tick % 20 === 0) misfires = await this.misfires();
      const v = { ...slow, ...fast };
      if (v.map !== undefined) v.boost = (v.map - baro) / 100;
      this.onData({ t: Date.now(), values: v, misfires });
      tick++;
    }
  }

  stop() {
    this.running = false;
  }
}

// Recorded live samples -> CSV, one row per sample, misfires as this-drive counts.
const CSV_COLUMNS = ['rpm', 'speed', 'boost', 'throttle', 'load', 'coolant', 'iat', 'voltage', 'timing', 'stft', 'ltft', 'maf'];

function samplesToCsv(samples) {
  const cylinders = Math.max(0, ...samples.map((s) => (s.misfires || []).length));
  const cyl = Array.from({ length: cylinders }, (_, i) => i + 1);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '');
  const rows = [['time', ...CSV_COLUMNS, ...cyl.map((n) => `misfires_cyl${n}`)].join(',')];
  for (const s of samples) {
    const mf = cyl.map((n) => {
      const m = (s.misfires || []).find((x) => x.cylinder === n);
      return num(m && m.current);
    });
    rows.push([new Date(s.t).toISOString(), ...CSV_COLUMNS.map((k) => num(s.values[k])), ...mf].join(','));
  }
  return `${rows.join('\r\n')}\r\n`;
}

module.exports = { LiveSession, parsePids, PIDS, samplesToCsv };
