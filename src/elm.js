// Minimal ELM327 / OBDLink transport over a serial port.
const { SerialPort } = require('serialport');

const BAUD_RATES = [115200, 38400, 9600, 230400, 500000];

function friendlyError(path, err) {
  const msg = err.message || String(err);
  if (/access denied/i.test(msg)) return new Error(`${path} is in use by another program (close OBDwiz or similar).`);
  if (/not found|file not found/i.test(msg)) return new Error(`${path} not found. Is the cable plugged in?`);
  if (/error code 121|operation aborted|semaphore/i.test(msg)) {
    return new Error(`${path} didn't respond. If it's a Bluetooth link, it isn't your OBD cable; pick the USB cable port.`);
  }
  return new Error(`${path}: ${msg}`);
}

function classify(p) {
  const text = `${p.vendorId || ''} ${p.manufacturer || ''} ${p.friendlyName || ''} ${p.pnpId || ''}`;
  if (/0403|ftdi|obd|elm|stn|ch340|prolific|scantool/i.test(text)) return 'adapter';
  if (/bthenum|bluetooth/i.test(text)) return 'bluetooth';
  return 'other';
}

class Elm {
  constructor(onLog = () => {}) {
    this.port = null;
    this.path = null;
    this.buffer = '';
    this.waiter = null;
    this.onLog = onLog;
  }

  static async listPorts() {
    const ports = await SerialPort.list();
    const label = {
      adapter: (p) => `${p.path} - USB OBD cable`,
      bluetooth: (p) => `${p.path} - Bluetooth link (not a cable)`,
      other: (p) => [p.path, p.friendlyName || p.manufacturer].filter(Boolean).join(' - '),
    };
    const order = { adapter: 0, other: 1, bluetooth: 2 };
    return ports
      .map((p) => ({ path: p.path, kind: classify(p) }))
      .map((p, i) => ({ ...p, label: label[p.kind](ports[i]), likelyAdapter: p.kind === 'adapter' }))
      .sort((a, b) => order[a.kind] - order[b.kind]);
  }

  async open(path) {
    for (const baudRate of BAUD_RATES) {
      await this.openAt(path, baudRate);
      let reply = '';
      try {
        reply = await this.send('ATI', 1500);
      } catch (err) {
        // A port that can't even be written to won't work at any baud rate.
        if (!/^Timeout/.test(err.message)) {
          await this.close();
          throw err;
        }
      }
      if (/ELM|STN|OBD/i.test(reply)) {
        this.onLog(`Connected on ${path} at ${baudRate} baud`);
        return baudRate;
      }
      await this.close();
    }
    throw new Error(`No OBD adapter answered on ${path}. Check it's the USB cable port and the cable is plugged into the car.`);
  }

  openAt(path, baudRate) {
    return new Promise((resolve, reject) => {
      this.buffer = '';
      this.path = path;
      const port = new SerialPort({ path, baudRate, autoOpen: false });
      this.port = port;
      port.on('data', (chunk) => this.onData(chunk.toString('latin1')));
      // Without this listener a serial error crashes the main process.
      port.on('error', (err) => this.fail(friendlyError(path, err)));
      port.on('close', (err) => {
        if (err && err.disconnected) this.fail(new Error('The cable was unplugged.'));
        if (this.port === port) this.port = null;
      });
      port.open((err) => {
        if (!err) return resolve();
        this.port = null;
        reject(friendlyError(path, err));
      });
    });
  }

  fail(err) {
    this.onLog(`! ${err.message}`);
    if (!this.waiter) return;
    const { reject, timer } = this.waiter;
    this.waiter = null;
    clearTimeout(timer);
    reject(err);
  }

  onData(text) {
    this.buffer += text;
    if (this.waiter && this.buffer.includes('>')) {
      const out = this.buffer.replace(/>/g, '').trim();
      this.buffer = '';
      const { resolve, timer } = this.waiter;
      this.waiter = null;
      clearTimeout(timer);
      resolve(out);
    }
  }

  send(cmd, timeoutMs = 8000) {
    if (!this.port) return Promise.reject(new Error('Not connected'));
    if (this.waiter) return Promise.reject(new Error('Command already in progress'));
    this.buffer = '';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`Timeout waiting for reply to ${cmd}`));
      }, timeoutMs);
      this.waiter = {
        resolve: (out) => {
          this.onLog(`> ${cmd}\n${out}`);
          resolve(out);
        },
        reject,
        timer,
      };
      this.port.write(`${cmd}\r`, (err) => {
        if (err) this.fail(friendlyError(this.path, err));
      });
    });
  }

  // Listen to bus traffic (ATMA) for `ms`, then stop it with a keypress.
  // Listen-only: nothing is sent to the car.
  monitor(ms) {
    if (!this.port) return Promise.reject(new Error('Not connected'));
    if (this.waiter) return Promise.reject(new Error('Command already in progress'));
    this.buffer = '';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error('Timeout stopping bus monitor'));
      }, ms + 5000);
      this.waiter = {
        resolve: (out) => {
          this.onLog(`> ATMA (${ms} ms)\n${out.split(/\r?\n|\r/).length} lines`);
          resolve(out);
        },
        reject,
        timer,
      };
      this.port.write('ATMA\r');
      setTimeout(() => this.port && this.port.write('\r'), ms);
    });
  }

  close() {
    return new Promise((resolve) => {
      const port = this.port;
      this.port = null;
      if (!port || !port.isOpen) return resolve();
      port.close(() => resolve());
    });
  }
}

module.exports = { Elm, friendlyError };
