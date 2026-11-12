// Fake adapter that replays replies captured from a 2016 Audi S1 on 2026-10-26.
// Used by tests and by `npm start -- --demo`.
const isotp = require('./isotp');

const R = (...lines) => lines.join('\r');
const h2 = (b) => b.toString(16).toUpperCase().padStart(2, '0');

const ENGINE_LIST = R('7E8 03 7F 19 78', '7E8 10 0F 59 02 FF 00 3A E2', '7E8 21 60 00 3B 15 60 00 40', '7E8 22 77 65 AA AA AA AA AA');

const ext = (dtc, status, l2, l3, l4) =>
  R(
    '7E8 03 7F 19 78',
    `7E8 10 3C 59 06 ${dtc} ${status}`,
    '7E8 21 01 02 01 02 FF 01 4A',
    l2,
    l3,
    l4,
    '7E8 24 63 39 FB 71 20 96 28',
    '7E8 25 11 0E 04 11 80 08 1D',
  );

const REPLIES = {
  ATI: 'ELM327 v1.4b',
  ATZ: 'ELM327 v1.4b',
  // The demo adapter is an OBDLink (STN chip), so demo coding uses STPX.
  STI: 'STN1130 v4.6.4',
  ATRV: '11.7V',
  '7DF:0100': R('SEARCHING...', '7E8 06 41 00 BE 3E A8 13'),
  '7DF:0101': '7E8 06 41 01 00 07 E1 21',
  '7DF:0105': '7E8 03 41 05 3F',
  '7DF:010C': '7E8 04 41 0C 00 00',
  '7DF:0902': R('7E8 10 14 49 02 01 57 41 55', '7E8 21 5A 5A 5A 38 58 34 47', '7E8 22 42 30 31 32 33 34 35'),
  '7DF:03': '7E8 02 43 00',
  '7DF:07': '7E8 02 47 00',
  '7DF:0A': 'NO DATA',
  '7DF:06A2': R('7E8 10 13 46 A2 0B 24 00 37', '7E8 21 00 00 FF FF A2 0C 24', '7E8 22 00 00 00 00 FF FF AA'),
  '7DF:06A3': R('7E8 10 13 46 A3 0B 24 00 01', '7E8 21 00 00 FF FF A3 0C 24', '7E8 22 00 00 00 00 FF FF AA'),
  '7DF:06A4': R('7E8 10 13 46 A4 0B 24 00 02', '7E8 21 00 00 FF FF A4 0C 24', '7E8 22 00 00 00 00 FF FF AA'),
  '7DF:06A5': R('7E8 10 13 46 A5 0B 24 00 01', '7E8 21 00 00 FF FF A5 0C 24', '7E8 22 00 00 00 00 FF FF AA'),
  '7E0:19022D': ENGINE_LIST,
  '7E0:1906003AE2FF': ext('00 3A E2', '60', '7E8 22 CD 00 00 6A B4 74 A0', '7E8 23 70 20 84 23 45 84 37', ''),
  '7E0:1906003B15FF': ext('00 3B 15', '60', '7E8 22 CD 00 00 6A B4 74 A0', '7E8 23 70 20 55 5D 45 84 38', ''),
  '7E0:1906004077FF': ext('00 40 77', '65', '7E8 22 D0 00 00 6A B4 75 38', '7E8 23 70 2A 48 3C 59 87 3D', ''),
  '713:19022D': R('77D 03 7F 19 78', '77D 10 17 59 02 99 00 04 89', '77D 21 10 00 04 8A 10 00 04', '77D 22 8B 10 00 02 71 08 00', '77D 23 03 8D 08 AA AA AA AA'),
  '715:19022D': R('77F 03 7F 19 78', '77F 03 59 02 99'),
  '714:19022D': R('77E 10 0B 59 02 99 C2 35 00', '77E 21 10 13 06 53 10 AA AA'),
  '712:19022D': R('77C 10 17 59 02 99 10 A8 00', '77C 21 10 10 B5 00 10 10 9A', '77C 22 00 10 10 9B 00 10 10', '77C 23 6B 00 10 AA AA AA AA'),
  '70A:19022D': R('774 10 0F 59 02 19 C1 01 20', '774 21 10 C4 02 20 10 D0 03', '774 22 10 10 AA AA AA AA AA'),
  '70C:19022D': R('776 10 0B 59 02 19 00 02 04', '776 21 10 01 7C 04 10 AA AA'),
};

// Simulated engine for the live dashboard demo (not recorded data).
function simulatePids(pids, t = Date.now() / 1000) {
  const wave = (Math.sin(t / 3) + 1) / 2;
  const rpm = 900 + wave * 2600;
  const maf = Math.round((3 + wave * 90) * 100);
  const raw = {
    0x04: [Math.round(20 + wave * 150)],
    0x05: [130],
    0x06: [128 + Math.round(Math.sin(t) * 4)],
    0x07: [131],
    0x0b: [Math.round(35 + wave * 170)],
    0x0c: [(rpm * 4) >> 8, (rpm * 4) & 0xff],
    0x0d: [Math.round(30 + wave * 50)],
    0x0e: [Math.round(128 + 20 + wave * 10)],
    0x0f: [62],
    0x10: [maf >> 8, maf & 0xff],
    0x11: [Math.round(30 + wave * 180)],
    0x33: [101],
    0x42: [0x36, 0x6a],
  };
  const body = pids.flatMap((p) => (raw[p] ? [p, ...raw[p]] : []));
  if (!body.length) return 'NO DATA';
  const data = [0x41, ...body];
  const h = (b) => b.toString(16).padStart(2, '0').toUpperCase();
  if (data.length <= 7) return `7E8 0${data.length} ${data.map(h).join(' ')}`;
  const lines = [`7E8 10 ${h(data.length)} ${data.slice(0, 6).map(h).join(' ')}`];
  for (let i = 6, n = 1; i < data.length; i += 7, n++) {
    lines.push(`7E8 2${(n & 0xf).toString(16).toUpperCase()} ${data.slice(i, i + 7).map(h).join(' ')}`);
  }
  return R(...lines);
}

// Simulated coding modules (synthetic, NOT recorded from the car): each keeps
// its session and DID values, so a write shows up in later reads. Answers
// 10 / 22 / 2E / 3E, sent plainly, via STPX, or as raw ISO-TP frames.
const SIM_SIDS = [0x10, 0x22, 0x2e, 0x3e];

class CodingSim {
  // modules: { tx: { rx, dids: { 'F187': hex, '0600': hex } } }
  // options: voltage (ATRV once a coding session asked STI: a charger is on),
  //   flowControl (frames a module answers a first frame / block with),
  //   pending (write answered 7F 2E 78 first), refuse (NRC for every write),
  //   ignoreWrites (say yes but keep the old value), mangle (say yes but
  //   store the last byte inverted).
  constructor(modules, options = {}) {
    this.modules = {};
    for (const [tx, m] of Object.entries(modules)) this.modules[tx] = { rx: m.rx, session: 1, dids: { ...m.dids } };
    this.options = { flowControl: [[0x30, 0x00, 0x00]], ...options };
    this.inbound = null;
    this.writes = [];
  }

  knows(tx) {
    return Boolean(this.modules[tx]);
  }

  rx(tx) {
    return this.modules[tx].rx;
  }

  // One request -> reply payloads, or null for services not simulated.
  request(tx, req) {
    const mod = this.modules[tx];
    const [sid] = req;
    const no = (nrc) => [[0x7f, sid, nrc]];
    if (!SIM_SIDS.includes(sid)) return null;
    if (sid === 0x10) {
      if (req.length !== 2 || (req[1] !== 0x01 && req[1] !== 0x03)) return no(0x12);
      mod.session = req[1];
      return [[0x50, req[1], 0x00, 0x32, 0x01, 0xf4]];
    }
    if (sid === 0x3e) return req[1] === 0x00 ? [[0x7e, 0x00]] : no(0x12);
    if (req.length < 3) return no(0x13);
    const did = isotp.toHex(req.slice(1, 3));
    const stored = mod.dids[did];
    if (sid === 0x22) return req.length === 3 && stored ? [[0x62, req[1], req[2], ...isotp.fromHex(stored)]] : no(0x31);
    if (mod.session !== 0x03) return no(0x7f);
    if (!stored || did.startsWith('F1')) return no(0x31);
    const data = req.slice(3);
    if (data.length * 2 !== stored.length) return no(0x13);
    if (this.options.refuse) return no(this.options.refuse);
    this.writes.push({ tx, did, hex: isotp.toHex(data) });
    if (this.options.mangle) data[data.length - 1] ^= 0xff;
    if (!this.options.ignoreWrites) mod.dids[did] = isotp.toHex(data);
    return [...(this.options.pending ? [[0x7f, 0x2e, 0x78]] : []), [0x6e, req[1], req[2]]];
  }

  // One raw frame (ATCAF0) -> { fc: frames } | { replies } | {} (nothing yet),
  // or null when it isn't something simulated.
  frame(tx, f) {
    const type = f[0] >> 4;
    if (type === 0) {
      const replies = this.request(tx, f.slice(1, 1 + (f[0] & 0x0f)));
      return replies && { replies };
    }
    const fcs = this.options.flowControl;
    const cts = fcs.find((x) => x[0] === 0x30);
    if (type === 1) {
      this.inbound = cts ? { tx, len: ((f[0] & 0x0f) << 8) | f[1], data: f.slice(2, 8), sn: 1, block: 0, bs: cts[1] } : null;
      return { fc: fcs };
    }
    const m = this.inbound;
    if (type !== 2 || !m || m.tx !== tx) return {};
    // A frame out of sequence drops the message, as a real module would.
    if ((f[0] & 0x0f) !== (m.sn & 0x0f)) {
      this.inbound = null;
      return {};
    }
    m.sn++;
    m.data.push(...f.slice(1, 8));
    if (m.data.length >= m.len) {
      this.inbound = null;
      return { replies: this.request(tx, m.data.slice(0, m.len)) || [] };
    }
    if (m.bs && ++m.block === m.bs) {
      m.block = 0;
      return { fc: fcs };
    }
    return {};
  }
}

const ascii = (s) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();

// Demo S1 modules 09 / 17 / 46 with made-up but plausible long codings
// (30 / 18 / 10 bytes) and identification.
const DEMO_MODULES = {
  '70E': {
    rx: '778',
    dids: { F187: ascii('8X0907063AH'), F189: ascii('0560'), F197: ascii('BCM PQ25 H+4'), '0600': '0A180A3E0C00A00800040040E80C00102D08003000001400000000000000' },
  },
  '714': {
    rx: '77E',
    dids: { F187: ascii('8X0920930H'), F189: ascii('0711'), F197: ascii('KOMBI'), '0600': '090E2100000C000701000000000000000000' },
  },
  '70A': {
    rx: '774',
    dids: { F187: ascii('8X0959433AB'), F189: ascii('0104'), F197: ascii('KSG PQ25'), '0600': '018D08000C0000000000' },
  },
};

const createDemoCoding = (options = {}) => new CodingSim(DEMO_MODULES, { voltage: '12.6V', ...options });

// Shared by every demo adapter so a demo write shows up on later reads.
let demoCoding = null;

class ReplayElm {
  // delayMs mimics adapter round-trip time so the live demo doesn't spin.
  // options.coding: a CodingSim (tests), or null for none. The default demo
  // replies get the shared demo coding.
  constructor(onLog = () => {}, delayMs = 0, replies = REPLIES, { coding } = {}) {
    this.header = '7DF';
    this.onLog = onLog;
    this.delayMs = delayMs;
    this.replies = replies;
    this.caf = true;
    this.responses = true;
    this.codingSession = false;
    if (coding !== undefined) this.sim = coding;
    else this.sim = replies === REPLIES ? demoCoding || (demoCoding = createDemoCoding()) : null;
  }

  // Replay a scan saved with its transcript ([header, command, reply] rows).
  static fromTranscript(transcript, at = { ATI: 'ELM327 v1.4b', ATRV: '12.5V' }) {
    const replies = { ...at };
    for (const [header, cmd, out] of transcript) replies[cmd === 'ATMA' ? cmd : `${header}:${cmd}`] = out;
    return new ReplayElm(() => {}, 0, replies);
  }

  async open() {}

  async close() {}

  async monitor() {
    return this.replies.ATMA || '';
  }

  async send(cmd) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    let out;
    const simulated = () => (out = this.simulate(cmd)) !== null;
    if (cmd.startsWith('ATSH')) {
      this.header = cmd.slice(4);
      out = 'OK';
    } else if (cmd.startsWith('AT')) {
      out = this.adapterCommand(cmd);
    } else if (this.replies[`${this.header}:${cmd}`]) {
      out = this.replies[`${this.header}:${cmd}`];
    } else if (cmd.startsWith('ST')) {
      out = this.stnCommand(cmd);
    } else if (simulated()) {
      // Simulated coding module answered.
    } else if (this.header === '7E0' && cmd.startsWith('06')) {
      out = this.replies[`7DF:${cmd}`] || 'NO DATA';
    } else if (this.header === '7E0' && cmd.startsWith('01')) {
      out = simulatePids(cmd.slice(2).match(/../g).map((h) => parseInt(h, 16)));
    } else {
      out = 'NO DATA';
    }
    this.onLog(`> ${cmd}\n${out}`);
    return out;
  }

  adapterCommand(cmd) {
    if (cmd === 'ATZ') {
      // A reset puts everything back to defaults, as on a real adapter.
      this.header = '7DF';
      this.caf = true;
      this.responses = true;
    } else if (cmd === 'ATCAF0' || cmd === 'ATCAF1') {
      this.caf = cmd === 'ATCAF1';
    } else if (cmd === 'ATR0' || cmd === 'ATR1') {
      this.responses = cmd === 'ATR1';
    } else if (cmd === 'ATRV' && this.codingSession && this.sim && this.sim.options.voltage) {
      // Demo coding pretends a charger is on: coding needs 12.4 V and the
      // recorded scan was at 11.7 V. Only coding asks STI, so scans keep 11.7.
      return this.sim.options.voltage;
    }
    return this.replies[cmd] || 'OK';
  }

  // STN commands: identity, and STPX on an STN adapter. An ELM says "?".
  stnCommand(cmd) {
    if (cmd === 'STI' || cmd === 'STDI') {
      this.codingSession = true;
      return this.replies[cmd] || '?';
    }
    const px = cmd.match(/^STPX H:([0-9A-F]{3}), D:((?:[0-9A-F]{2})+), R:1$/i);
    if (!px || !/STN/.test(this.replies.STI || '') || !this.sim || !this.sim.knows(px[1].toUpperCase())) return '?';
    const tx = px[1].toUpperCase();
    return this.format(tx, this.sim.request(tx, isotp.fromHex(px[2])) || []);
  }

  // Coding requests to a simulated module, or null to fall back to replies.
  simulate(cmd) {
    if (!this.sim || !this.sim.knows(this.header)) return null;
    // A trailing " 1" is the ELM's "wait for one reply" count.
    const bytes = isotp.fromHex(cmd.split(' ')[0]);
    if (!bytes) return null;
    if (this.caf) {
      const replies = this.sim.request(this.header, bytes);
      return replies && this.format(this.header, replies);
    }
    const r = this.sim.frame(this.header, bytes);
    if (!r) return null;
    if (!this.responses) return '';
    const rx = this.sim.rx(this.header);
    if (r.fc) return R(...r.fc.map((f) => `${rx} ${[...f, ...Array(8 - f.length).fill(0xaa)].map(h2).join(' ')}`));
    return r.replies ? this.format(this.header, r.replies, true) : 'NO DATA';
  }

  // Reply payloads as ELM output (headers on). With formatting on the ELM
  // hides single-frame padding; raw (ATCAF0) shows all 8 bytes.
  format(tx, payloads, raw = false) {
    const rx = this.sim.rx(tx);
    const lines = [];
    for (const p of payloads) {
      const frames = isotp.segment(p, 0xaa);
      if (!raw && frames.length === 1) frames[0] = frames[0].slice(0, 1 + p.length);
      for (const f of frames) lines.push(`${rx} ${f.map(h2).join(' ')}`);
    }
    return lines.length ? R(...lines) : 'NO DATA';
  }
}

module.exports = { ReplayElm, simulatePids, CodingSim, createDemoCoding };
