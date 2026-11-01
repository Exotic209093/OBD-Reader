// Fake adapter that replays replies captured from a 2016 Audi S1 on 2026-10-26.
// Used by tests and by `npm start -- --demo`.

const R = (...lines) => lines.join('\r');

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

class ReplayElm {
  // delayMs mimics adapter round-trip time so the live demo doesn't spin.
  constructor(onLog = () => {}, delayMs = 0, replies = REPLIES) {
    this.header = '7DF';
    this.onLog = onLog;
    this.delayMs = delayMs;
    this.replies = replies;
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
    if (cmd.startsWith('ATSH')) {
      this.header = cmd.slice(4);
      out = 'OK';
    } else if (cmd.startsWith('AT')) {
      out = this.replies[cmd] || 'OK';
    } else if (this.replies[`${this.header}:${cmd}`]) {
      out = this.replies[`${this.header}:${cmd}`];
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
}

module.exports = { ReplayElm, simulatePids };
