# Architecture

OBD Reader is a plain Electron app: no build step, no framework. The main process owns the
serial port and does all car communication; the renderer is a sandboxed page that only talks
to the main process through a small preload bridge.

```
 renderer/ (sandboxed page)                 src/main.js (Electron main)
 ┌────────────────────────────┐   IPC     ┌──────────────────────────────────────────┐
 │ renderer.js  Scan / Live / │ ────────► │ scan:run  clear:run  live:*  history:*   │
 │ History tabs, charts       │ ◄──────── │ repair:mark  report:*  (native dialogs)  │
 └────────────────────────────┘ preload.js└───────┬──────────────┬─────────────┬─────┘
                                                  │              │             │
                                  scan.js / clear.js / live.js   │      history.js
                                  (what to ask the car)          │   (%APPDATA%/obd-reader)
                                                  │         advice.js, codes.js,
                                       recorder() allowlist   reportText.js
                                                  │
                                             elm.js (serial) ──► ELM327 / OBDLink ──► car CAN bus
                                             replay.js (demo + tests)
```

## Layers

| Layer | Files | Job |
|---|---|---|
| Transport | `src/elm.js` | Opens the serial port (tries several baud rates), sends one command at a time, waits for the `>` prompt. `monitor()` listens to bus traffic. |
| Fake transport | `src/replay.js` | Same interface, answers from recorded replies. Powers `npm run demo` and every test. `ReplayElm.fromTranscript()` replays any saved scan. |
| Safety wrapper | `recorder()` in `src/scan.js` | Wraps the transport. Every car-bound request is checked against an allowlist of service IDs and logged to the scan's transcript with its timing. `ensure()` skips adapter settings already in effect. |
| Decoding | `src/decode.js` | Pure functions, no I/O: ISO-TP reassembly, DTCs (SAE, VAG, GMLAN, KWP), readiness, freeze frame, misfire counters, VAG extended data. |
| Car knowledge | `src/makes.js`, `src/codes.js` | Per-make profiles picked from the VIN (module addresses, protocols to try, suggested dealer tool) and the fault-code knowledge base. |
| Sequences | `src/scan.js`, `src/clear.js`, `src/live.js` | What to ask, in what order: full scan, clear all codes, live polling. |
| Interpretation | `src/advice.js`, `src/history.js`, `src/reportText.js` | Verdict and advice, scan history and comparison, per-car memory (found modules, repairs), text export. |
| App shell | `src/main.js`, `src/preload.js`, `renderer/` | Window, IPC handlers, native confirm dialogs, UI. |

## A scan, step by step

1. Reset the adapter, read its voltage, connect (11-bit 500k CAN first, protocol search only as a fallback).
2. Engine over generic OBD: readiness and check engine light (01 01), VIN (09 02), stored, pending and
   permanent codes (03, 07, 0A), freeze frame (02), misfire counters (06).
3. Pick the make profile from the VIN. Read the engine's own fault memory, then each listed module,
   trying the profile's protocols in order (UDS 19, GMLAN A9, KWP 18).
4. Extra modules: on a car's first scan, listen to the bus, then ask every free ID from 0x600 to 0x7F7.
   Later scans reuse what was found (`History.carMemory`).
5. Main process adds advice and the comparison with the last scan, then saves it with its transcript.

## Safety rules

- **Scans are read-only.** `READ_SIDS` allows only OBD modes 01-0A except 04, plus 18, 19, 22 and A9.
  Anything else throws before it reaches the cable. `test/scan.test.js` checks every command a scan sends.
- **Clearing is separate.** `clearFaults()` uses its own `CLEAR_SIDS` allowlist (adds 04 and 14), only runs
  after the native dialog in `main.js`, checks the targets it gets from the renderer, and is always
  followed by a rescan.
- **Never:** session changes (10), security access (27), writes (2E), routines (31) or resets (11).
- **Renderer is untrusted:** `contextIsolation`, `sandbox`, no Node in the page, a strict CSP, and every
  IPC argument is checked in the main process.

## Data on disk

`%APPDATA%/obd-reader/history/` (or the platform's app-data folder):

- `<finish time>.json`: one saved scan, including its raw transcript and step timings.
- `repairs.json`: repairs the user marked, per VIN.

Demo mode uses `history-demo/` so it never mixes with real scans.

## Adding a make

Add a profile to `PROFILES` and its VIN prefixes to `MAKES` in `src/makes.js`, then a test with
recorded replies in `test/scan.test.js`. Keep `verified: false` until it has been checked on a real car.
