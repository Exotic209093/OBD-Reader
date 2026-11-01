const test = require('node:test');
const assert = require('node:assert');
const { friendlyError } = require('../src/elm');

test('serial errors become plain-English messages', () => {
  const cases = [
    ['Opening COM7: Access denied', /in use by another program/],
    ['Opening COM7: File not found', /not found\. Is the cable plugged in/],
    ['Opening COM6: Unknown error code 121', /Bluetooth link/],
    ['Writing to COM port (GetOverlappedResult): Operation aborted', /Bluetooth link/],
  ];
  for (const [raw, expected] of cases) assert.match(friendlyError('COM7', new Error(raw)).message, expected);
});
