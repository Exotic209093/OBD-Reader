// Pure ISO-TP (ISO 15765-2) helpers for requests longer than one CAN frame.
// No I/O here: recorder().sendPayload() in scan.js does the sending.

// 12-bit length in a first frame.
const MAX_LENGTH = 4095;

// Strict hex string -> bytes, or null if it isn't whole bytes of hex.
function fromHex(hex) {
  if (typeof hex !== 'string' || !/^(?:[0-9A-F]{2})+$/i.test(hex)) return null;
  return hex.match(/../g).map((h) => parseInt(h, 16));
}

const toHex = (bytes) => bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');

// Split a request into CAN frames: one single frame (<= 7 bytes), or a first
// frame plus consecutive frames (sequence number 1..F, then 0 again). Frames
// are padded to the full 8 bytes, since many modules ignore shorter ones.
function segment(payload, pad = 0x00) {
  if (!payload.length || payload.length > MAX_LENGTH) throw new Error(`Can't send ${payload.length} bytes in one ISO-TP message`);
  const fill = (f) => [...f, ...Array(8 - f.length).fill(pad)];
  if (payload.length <= 7) return [fill([payload.length, ...payload])];
  const frames = [[0x10 | (payload.length >> 8), payload.length & 0xff, ...payload.slice(0, 6)]];
  for (let i = 6, sn = 1; i < payload.length; i += 7, sn++) {
    frames.push(fill([0x20 | (sn & 0x0f), ...payload.slice(i, i + 7)]));
  }
  return frames;
}

// STmin byte -> ms. 00-7F are ms, F1-F9 are 100-900 us; anything else is
// reserved and the standard says to use the longest gap (127 ms).
function stMinMs(b) {
  if (b <= 0x7f) return b;
  if (b >= 0xf1 && b <= 0xf9) return (b - 0xf0) / 10;
  return 0x7f;
}

// Flow control frame [3s, BS, STmin] -> { status, blockSize, stMinMs }, or null
// for any other frame. blockSize 0 = send everything without waiting again.
function parseFlowControl(frame) {
  if (!frame || frame.length < 3 || frame[0] >> 4 !== 3) return null;
  const status = ['continue', 'wait', 'overflow'][frame[0] & 0x0f] || 'invalid';
  return { status, blockSize: frame[1], stMinMs: stMinMs(frame[2]) };
}

// The flow control that decides what happens next, from the frames received
// after a first frame (or the last frame of a block). WAITs are skipped; too
// many, or none followed by "continue", means give up.
function nextFlowControl(frames, maxWaits = 10) {
  let waits = 0;
  for (const f of frames) {
    const fc = parseFlowControl(f);
    if (!fc) continue;
    if (fc.status !== 'wait') return fc;
    if (++waits > maxWaits) break;
  }
  return { status: waits ? 'wait' : 'none' };
}

const FLOW_ERRORS = {
  overflow: 'the module refused the message size (ISO-TP overflow)',
  wait: 'the module kept asking to wait (ISO-TP flow control)',
  none: "the module didn't answer the first frame (no ISO-TP flow control)",
  invalid: 'the module sent a bad ISO-TP flow control frame',
};

// Plain-English reason a transfer was abandoned; nothing reached the module's
// application, since it only acts on a complete message.
const flowError = (status) => `${FLOW_ERRORS[status] || 'ISO-TP transfer failed'}; nothing was written`;

module.exports = { MAX_LENGTH, fromHex, toHex, segment, stMinMs, parseFlowControl, nextFlowControl, flowError };
