# OBD Reader

Electron app (plain HTML/JS, no build step) that does a read-only fault scan,
opt-in code clearing, live data and scan history over an ELM327/OBDLink cable. Built for a 2016 Audi
S1 (VAG UDS over 11-bit CAN); adapter is the USB OBDLink on COM7 (FTDI 0403:6015).
Also used on a 2013 Vauxhall Zafira B: its engine refuses
UDS 19 (NRC 11); the GMLAN A9 path in `src/scan.js` is not yet confirmed on the car.

## Commands

- `npm start` – run the app (`npm run demo` replays a recorded scan, no car needed)
- `npm test` – node:test suite; S1 fixtures are real replies, GM/Ford/KWP/search/clear ones are synthetic
- `npm run scan -- COM7 [--json] [--search]` – CLI scan (`--search` = probe every address)
- `electron scripts/snapshot.js <dir>` – demo screenshots + PDF for visual checks

T3 Code sets `ELECTRON_RUN_AS_NODE=1`; `npm start`/`npm run demo` go through
`scripts/launch.js`, which clears it. Unset it yourself when calling `electron` directly.

## Map

- `src/elm.js` serial transport; `src/decode.js` pure parsers (ISO-TP, DTCs, VAG extended data)
- `src/makes.js` per-make profiles + `MAKES` table (VIN WMI -> profile, tool); add new brands here.
  Only `vag` is `verified`; gm/ford/hyundaiKia addresses are from public docs, not yet tried on a car
- `src/scan.js` scan sequence, UDS/KWP/GMLAN fault readers, module search (0x600-0x7F7 after an
  ATMA listen; skips ids seen on the bus), `READ_SIDS` allowlist; `src/live.js` live PID polling
- `src/clear.js` code clearing (mode 04, UDS/KWP 14, GMLAN 04) with its own `CLEAR_SIDS` allowlist
- `src/codes.js` code knowledge base (advice text, rough UK costs); `src/advice.js` verdict logic
- `src/history.js` saved scans (`%APPDATA%/obd-reader/history`) + comparison; `carMemory(vin)` (modules
  the last search found, profile modules silent 3 scans running) feeds `scan({ memory })` so only a
  car's first scan sweeps every address; `repairs.json` (user-marked repairs) feeds `buildAdvice(report, ctx)`
- `src/reportText.js` text export; `src/replay.js` recorded/simulated adapter for demo + tests
  (`ReplayElm.fromTranscript(report.transcript)` replays any saved scan; scans save their raw transcript
  with per-request ms as a 4th column, plus `report.timings` per step)
- `recorder().ensure()` skips AT settings already in effect; `target()` uses it, so per-module setup is cheap
- `src/main.js` Electron main + IPC; `src/preload.js` bridge; `renderer/` UI

## Rules

- Scanning must stay read-only: `scan()` never sends 04/14; `READ_SIDS` enforces it and
  `test/scan.test.js` asserts it. Clearing only via `clearFaults()`, triggered from the UI after the
  native confirm in `main.js` (`clear:run`), and always followed by a rescan.
- No session (10), security (27), writes (2E), routines (31) or resets (11), even for clearing.
- VAG timestamp in 19 06 extended data is bit-packed from byte 9 bit 0 (see `parseVagExtData`).
