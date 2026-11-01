// Pure decoders for ELM327 text output (ATH1 ATS1, CAN). No I/O here.

const hexBytes = (s) => s.trim().split(/\s+/).filter(Boolean).map((h) => parseInt(h, 16));

// Turn raw ELM output into reassembled ISO-TP messages per CAN id.
// Returns [{ id, data: number[] }] in arrival order.
function parseMessages(raw) {
  const lines = raw
    .split(/[\r\n|]+/)
    .map((l) => l.trim())
    .filter((l) => /^[0-9A-F]{3}( [0-9A-F]{2})+$/i.test(l));
  const messages = [];
  const open = new Map();
  for (const line of lines) {
    const [idHex, ...rest] = line.split(/\s+/);
    const id = idHex.toUpperCase();
    const bytes = rest.map((h) => parseInt(h, 16));
    const type = bytes[0] >> 4;
    if (type === 0) {
      messages.push({ id, data: bytes.slice(1, 1 + (bytes[0] & 0x0f)) });
    } else if (type === 1) {
      const len = ((bytes[0] & 0x0f) << 8) | bytes[1];
      const msg = { id, data: bytes.slice(2), len };
      open.set(id, msg);
      messages.push(msg);
    } else if (type === 2) {
      const msg = open.get(id);
      if (msg) msg.data.push(...bytes.slice(1));
    }
  }
  for (const m of messages) {
    if (m.len !== undefined) {
      m.data = m.data.slice(0, m.len);
      delete m.len;
    }
  }
  return messages;
}

// Final (non "response pending") reply to a request with the given service id.
function finalReply(raw, sid) {
  const msgs = parseMessages(raw);
  let reply = null;
  for (const m of msgs) {
    if (m.data[0] === sid + 0x40) reply = { ok: true, ...m };
    else if (m.data[0] === 0x7f && m.data[1] === sid && m.data[2] !== 0x78) {
      reply = { ok: false, nrc: m.data[2], ...m };
    }
  }
  return reply;
}

const NRC = {
  0x10: 'general reject',
  0x11: 'service not supported',
  0x12: 'sub-function not supported',
  0x13: 'bad message length',
  0x21: 'busy, repeat request',
  0x22: 'conditions not correct',
  0x31: 'request out of range',
  0x33: 'security access denied',
  0x7e: 'not supported in active session',
  0x7f: 'not supported in active session',
};

// SAE J2012 two-byte DTC -> "P0301"
function saeDtc(b1, b2) {
  const letter = 'PCBU'[b1 >> 6];
  const d = (b1 >> 4) & 0x03;
  return `${letter}${d}${(b1 & 0x0f).toString(16)}${b2.toString(16).padStart(2, '0')}`.toUpperCase();
}

// Mode 03 / 07 / 0A on CAN: [43, count, hi, lo, hi, lo, ...]
function parseObdDtcs(raw, sid) {
  const out = [];
  for (const m of parseMessages(raw)) {
    if (m.data[0] !== sid + 0x40) continue;
    const body = m.data.slice(2);
    for (let i = 0; i + 1 < body.length; i += 2) {
      if (body[i] === 0 && body[i + 1] === 0) continue;
      out.push({ ecu: m.id, code: saeDtc(body[i], body[i + 1]) });
    }
  }
  return out;
}

// Readiness monitors in 01 01 bytes C (supported) and D (1 = not finished yet),
// by bit. Byte B bit 3 says which table applies.
const SPARK_MONITORS = ['Catalyst', 'Heated catalyst', 'Evaporative system', 'Secondary air', null, 'Oxygen sensor', 'Oxygen sensor heater', 'EGR / VVT'];
const DIESEL_MONITORS = ['NMHC catalyst', 'NOx / SCR', null, 'Boost pressure', null, 'Exhaust gas sensor', 'Particulate filter', 'EGR / VVT'];
// Byte B bits 0-2 supported, 4-6 not finished.
const COMMON_MONITORS = ['Misfire', 'Fuel system', 'Components'];

function parseMonitorStatus(raw) {
  const m = parseMessages(raw).find((x) => x.data[0] === 0x41 && x.data[1] === 0x01);
  if (!m) return null;
  const out = { mil: (m.data[2] & 0x80) !== 0, dtcCount: m.data[2] & 0x7f };
  const [b, c, dd] = m.data.slice(3, 6);
  if (dd === undefined) return out;
  const diesel = (b & 0x08) !== 0;
  const readiness = [];
  COMMON_MONITORS.forEach((name, i) => {
    if (b & (1 << i)) readiness.push({ name, complete: (b & (0x10 << i)) === 0 });
  });
  (diesel ? DIESEL_MONITORS : SPARK_MONITORS).forEach((name, i) => {
    if (name && c & (1 << i)) readiness.push({ name, complete: (dd & (1 << i)) === 0 });
  });
  return { ...out, ignition: diesel ? 'compression' : 'spark', readiness };
}

// Mode 01/02 PIDs this app decodes. pid: [bytes, key, decode]
const PIDS = {
  0x04: [1, 'load', ([a]) => (a * 100) / 255],
  0x05: [1, 'coolant', ([a]) => a - 40],
  0x06: [1, 'stft', ([a]) => ((a - 128) * 100) / 128],
  0x07: [1, 'ltft', ([a]) => ((a - 128) * 100) / 128],
  0x0b: [1, 'map', ([a]) => a],
  0x0c: [2, 'rpm', ([a, b]) => (a * 256 + b) / 4],
  0x0d: [1, 'speed', ([a]) => a],
  0x0e: [1, 'timing', ([a]) => a / 2 - 64],
  0x0f: [1, 'iat', ([a]) => a - 40],
  0x10: [2, 'maf', ([a, b]) => (a * 256 + b) / 100],
  0x11: [1, 'throttle', ([a]) => (a * 100) / 255],
  0x33: [1, 'baro', ([a]) => a],
  0x42: [2, 'voltage', ([a, b]) => (a * 256 + b) / 1000],
};

// Mode 02 freeze frame reply: 42 <pid> <frame> <data>.
// PID 02 is the code that stored the frame (00 00 = no frame).
function parseFreezeFrame(raw, pid) {
  const m = parseMessages(raw).find((x) => x.data[0] === 0x42 && x.data[1] === pid);
  if (!m) return null;
  const bytes = m.data.slice(3);
  if (pid === 0x02) return bytes.length >= 2 && (bytes[0] || bytes[1]) ? saeDtc(bytes[0], bytes[1]) : null;
  const spec = PIDS[pid];
  if (!spec || bytes.length < spec[0]) return null;
  return { [spec[1]]: spec[2](bytes.slice(0, spec[0])) };
}

function parseVin(raw) {
  const m = parseMessages(raw).find((x) => x.data[0] === 0x49 && x.data[1] === 0x02);
  if (!m) return null;
  return String.fromCharCode(...m.data.slice(3).filter((b) => b >= 0x20 && b < 0x7f));
}

function parseCoolant(raw) {
  const m = parseMessages(raw).find((x) => x.data[0] === 0x41 && x.data[1] === 0x05);
  return m ? m.data[2] - 40 : null;
}

function parseRpm(raw) {
  const m = parseMessages(raw).find((x) => x.data[0] === 0x41 && x.data[1] === 0x0c);
  return m ? ((m.data[2] << 8) | m.data[3]) / 4 : null;
}

// ELM protocol numbers (ATDPN, "A" prefix = found by auto search).
const PROTOCOLS = {
  1: 'SAE J1850 PWM (older Ford)',
  2: 'SAE J1850 VPW (older GM)',
  3: 'ISO 9141-2 (K-line)',
  4: 'KWP2000 slow init (K-line)',
  5: 'KWP2000 fast init (K-line)',
  6: 'CAN 11-bit 500k',
  7: 'CAN 29-bit 500k',
  8: 'CAN 11-bit 250k',
  9: 'CAN 29-bit 250k',
};

function parseProtocol(raw) {
  const m = raw.trim().match(/^A?([1-9A-C])$/i);
  return m ? parseInt(m[1], 16) : null;
}

function parseVoltage(raw) {
  const m = raw.match(/(\d+(?:\.\d+)?)V/);
  return m ? parseFloat(m[1]) : null;
}

// Mode 06 misfire monitor for one cylinder MID (A2 = cyl 1 ...).
// TID 0B = average misfires over last 10 driving cycles, TID 0C = current cycle.
function parseMisfire(raw, mid) {
  const m = parseMessages(raw).find((x) => x.data[0] === 0x46 && x.data[1] === mid);
  if (!m) return null;
  const res = { recent: null, current: null };
  const body = m.data.slice(1);
  for (let i = 0; i + 8 < body.length; i += 9) {
    if (body[i] !== mid) continue;
    const value = (body[i + 3] << 8) | body[i + 4];
    if (body[i + 1] === 0x0b) res.recent = value;
    if (body[i + 1] === 0x0c) res.current = value;
  }
  return res;
}

const STATUS_BITS = [
  [0x01, 'failing now'],
  [0x04, 'pending'],
  [0x08, 'confirmed'],
  [0x20, 'failed since clear'],
  [0x80, 'warning lamp'],
];

function describeStatus(status) {
  return STATUS_BITS.filter(([bit]) => status & bit).map(([, label]) => label);
}

// GMLAN and KWP2000 status bits aren't confirmed against a real car yet; only
// the warning lamp bit is labelled. The raw byte is kept on each fault.
const describeOemStatus = (status) => (status & 0x80 ? ['reported', 'warning lamp'] : ['reported']);

// Status bits that mean the fault actually happened (not just "not tested yet").
const isReal = (status) => (status & 0xad) !== 0;

// UDS 19 02 reply -> [{ dtc: [b0,b1,b2], status }]
function parseUdsDtcs(data) {
  const out = [];
  for (let i = 3; i + 3 < data.length; i += 4) {
    out.push({ dtc: data.slice(i, i + 3), status: data[i + 3] });
  }
  return out;
}

// VCDS-style display number for a VAG UDS DTC, plus SAE form when it maps.
function vagDtcId([b0, b1, b2]) {
  const hex = [b0, b1, b2].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  if (b0 === 0) {
    const num = (b1 << 8) | b2;
    // Legacy VAG numbering: 16384 + decimal P0xxx number.
    const sae = num >= 16384 && num < 16384 + 1000 ? `P${String(num - 16384).padStart(4, '0')}` : null;
    return { hex, number: String(num).padStart(5, '0'), sae };
  }
  return { hex, number: null, sae: `${saeDtc(b0, b1)} ${b2.toString(16).padStart(2, '0').toUpperCase()}` };
}

// Read `n` bits MSB-first starting at absolute bit offset.
function readBits(bytes, offset, n) {
  let v = 0;
  for (let i = 0; i < n; i++) {
    const bit = offset + i;
    v = (v << 1) | ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
  }
  return v;
}

// UDS 19 06 extended data (VAG layout): mileage (km) and a bit-packed
// timestamp (year-2000:7 month:4 day:5 hour:5 min:6 sec:6).
function parseVagExtData(data) {
  if (data[0] !== 0x59 || data[1] !== 0x06) return null;
  const e = data.slice(6);
  if (e.length < 15) return null;
  const mileageKm = (e[5] << 16) | (e[6] << 8) | e[7];
  const base = 9 * 8 + 7;
  const year = 2000 + readBits(e, base, 7);
  const month = readBits(e, base + 7, 4);
  const day = readBits(e, base + 11, 5);
  const hour = readBits(e, base + 16, 5);
  const minute = readBits(e, base + 21, 6);
  const second = readBits(e, base + 27, 6);
  const pad = (n) => String(n).padStart(2, '0');
  const valid = month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour < 24 && minute < 60;
  return {
    mileageKm,
    time: valid ? `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}` : null,
  };
}

// KWP2000 18 reply: [58, count, (hi, lo, status) * count]
function parseKwpDtcs(data) {
  const out = [];
  for (let i = 2; i + 2 < data.length; i += 3) {
    if (data[i] === 0 && data[i + 1] === 0) continue;
    out.push({ dtc: [data[i], data[i + 1], 0], status: data[i + 2] });
  }
  return out;
}

// CAN ids seen in raw adapter output (e.g. ATMA bus monitor).
function frameIds(raw) {
  const ids = new Set();
  for (const line of raw.split(/[\r\n]+/)) {
    const m = line.trim().match(/^([0-9A-F]{3}) [0-9A-F]{2}/i);
    if (m) ids.add(m[1].toUpperCase());
  }
  return [...ids];
}

// UDS 22 reply carrying a text DID (e.g. F197 system name) -> trimmed string.
function parseAsciiDid(data, did) {
  if (data[0] !== 0x62 || ((data[1] << 8) | data[2]) !== did) return null;
  const text = String.fromCharCode(...data.slice(3).filter((b) => b >= 0x20 && b < 0x7f)).trim();
  return text || null;
}

// Raw CAN frames (ATCAF0 output): [{ id, data }] with every byte kept.
function parseFrames(raw) {
  return raw
    .split(/[\r\n|]+/)
    .map((l) => l.trim())
    .filter((l) => /^[0-9A-F]{3}( [0-9A-F]{2})+$/i.test(l))
    .map((l) => {
      const [id, ...rest] = l.split(/\s+/);
      return { id: id.toUpperCase(), data: rest.map((h) => parseInt(h, 16)) };
    });
}

// GMLAN A9 81 reply, sent with ATCAF0 so PCI bytes are visible.
// The module answers on its UUDT id with one frame per DTC:
// [81, hi, lo, failure type, status], ending with an all-zero DTC.
// A refusal comes back on the normal reply id as [03, 7F, A9, nrc].
function parseGmlanDtcs(raw, uudt) {
  let refused = null;
  const dtcs = [];
  let any = false;
  for (const f of parseFrames(raw)) {
    if (f.id === uudt && f.data[0] === 0x81 && f.data.length >= 5) {
      any = true;
      const [, hi, lo, ftb, status] = f.data;
      if (hi === 0 && lo === 0) continue;
      dtcs.push({ dtc: [hi, lo, ftb], status });
    } else if (f.data[1] === 0x7f && f.data[2] === 0xa9 && f.data[3] !== 0x78) {
      refused = f.data[3];
    }
  }
  if (any) return { ok: true, dtcs };
  if (refused !== null) return { ok: false, nrc: refused };
  return null;
}

// SAE code plus failure type byte when set (GM, non-VAG UDS) ("P0134" / "P0420 71").
function saeDtcId([hi, lo, ftb]) {
  const hex = [hi, lo, ftb].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const sae = saeDtc(hi, lo);
  return { hex, number: null, sae: ftb ? `${sae} ${ftb.toString(16).padStart(2, '0').toUpperCase()}` : sae };
}

module.exports = {
  hexBytes,
  parseMessages,
  parseFrames,
  parseGmlanDtcs,
  saeDtcId,
  finalReply,
  NRC,
  saeDtc,
  parseObdDtcs,
  parseMonitorStatus,
  PIDS,
  parseFreezeFrame,
  parseVin,
  parseCoolant,
  parseRpm,
  PROTOCOLS,
  parseProtocol,
  parseVoltage,
  parseMisfire,
  describeStatus,
  describeOemStatus,
  parseKwpDtcs,
  frameIds,
  parseAsciiDid,
  isReal,
  parseUdsDtcs,
  vagDtcId,
  parseVagExtData,
};
