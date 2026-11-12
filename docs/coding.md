# Coding (feature unlocking) — design

Status: in development. Nothing here has been written to a real car yet.

"Coding" changes stored settings in body/comfort modules (e.g. coming-home lights,
needle sweep, comfort indicators). It never reflashes module software, which is what
actually bricks modules. Every write is backed up first and can be restored.

## Safety rules (non-negotiable)

1. **Scans stay read-only.** `scan()`, `READ_SIDS` and `test/scan.test.js` don't change.
   Coding lives in its own module (`src/coding.js`) with its own allowlist.
2. **Allowed services for coding:** everything in `READ_SIDS`, plus
   - `10 01` / `10 03` (default / extended session) — no other sub-functions,
   - `2E <did> ...` only for a DID listed for that module in the platform catalogue,
   - `3E 00` tester present,
   - `27` only for platforms whose `security` is implemented (none yet; PSA later).
   Checked per request (header + full payload), not just per service id.
   **Never:** 04/14 (clearing has its own path), 11 reset, 28, 31 routines,
   34/35/36/37 download/upload, 85.
3. **Only modules marked `codeable` in the catalogue** can be written. Engine, gearbox,
   ABS/ESC, airbags and power steering are never codeable.
4. **Platform gate:** a platform with `writable: false` (e.g. PSA until checked on a car)
   is read-only: reading and backups work, writes are refused.
5. **Before every write:** VIN matches the reading, battery >= 12.4 V (ATRV), the DID is
   re-read and must equal what the plan was built from (else "the car changed, read again"),
   and a backup record is saved to disk. If the backup can't be saved, nothing is written.
6. **After every write:** read the DID back and compare; return to the default session (`10 01`).
   A mismatch is reported with a one-click restore.
7. **The renderer is untrusted.** It sends only `{ featureId, value }` or raw
   `{ module, did, hex }` changes. The main process builds the plan from its *own* last
   reading, validates everything, and shows a native confirm dialog listing every change
   (setting, old -> new, raw bytes) before writing. Unverified features say so in the dialog.
8. The first time a car's module is read, its coding is saved as the **original** backup,
   which is never overwritten or deleted by the app.

## Files

| File | Owner | Job |
|---|---|---|
| `src/isotp.js` | core | Pure ISO-TP helpers: segment a payload into first/consecutive frames, parse a flow-control frame. |
| `src/scan.js` (`recorder`) | core | `allowed` may be an array of SIDs **or** a predicate `(bytes, header) => bool`. New `sendPayload(hex, timeoutMs)`: checks the whole payload against `allowed`, then sends it as one frame (<= 7 bytes), via `STPX` on STN adapters, or as manual frames (`ATCAF0`, wait for flow control, `ATR0` for consecutive frames). `ST` commands: only `STI`/`STDI` pass through `send`; `STPX` only via `sendPayload`. |
| `src/codingCatalog.js` | core | `PLATFORMS` (id, label, VIN match, protocol, modules with tx/rx/key/name/codeable/dids, `writable`, `security`, `verified`) + `platformForVin(vin)` + `featuresFor(platformId)` (from `codingFeatures.js`). |
| `src/codingFeatures.js` | research | `FEATURES` array (data only, schema below). |
| `src/coding.js` | core | `CODE_SIDS`/`codingAllowed`, `readCoding`, `planChanges`, `writeCoding`, `planRestore`. |
| `src/codingStore.js` | core | Backups + change log on disk (`<userData>/coding/<VIN>/...`, demo: `coding-demo`). |
| `src/replay.js` | core | Stateful simulated coding for the demo S1 (22 / 10 / 2E / STPX), so `npm run demo` works end to end. |
| `test/coding.test.js` | core | Tests for all of the above. |
| `src/main.js`, `src/preload.js`, `renderer/*` | ui | IPC + Features tab. |
| `scripts/snapshot.js` | ui | Add a Features tab screenshot. |
| `docs/coding-research.md` | research | What each car can do, addresses, DIDs, sources. |

## Catalogue schema

```js
// codingCatalog.js
{
  id: 'audi-8x',
  label: 'Audi A1 / S1 (8X)',
  match: (vin) => /^(WAU|WUA|TRU)/.test(vin) && vin.slice(6, 8) === '8X',
  protocol: 'vag-uds',            // 'vag-uds' | 'psa-uds'
  security: null,                 // null | 'psa' (not implemented yet)
  writable: true,
  verified: false,                // true once a write+restore was done on a real car
  modules: [
    { key: '09', name: '09 Central electrics', tx: '70E', rx: '778', codeable: true, dids: [0x0600] },
    ...
  ],
}
// A module's readable/writable DIDs = its own `dids` plus every DID a feature uses on it.

// codingFeatures.js
{
  id: 'audi-8x.09.coming-home',   // unique, stable
  platform: 'audi-8x',
  module: '09',                   // module key
  did: 0x0600,                    // 0x0600 = VAG long coding; other DIDs = adaptation channels
  byte: 17, mask: 0x04,           // byte offset inside the DID data, bits it owns
  options: [{ label: 'Off', value: 0x00 }, { label: 'On', value: 0x04 }],  // values within mask
  category: 'Lights',             // Lights | Locking | Instruments | Comfort | Infotainment
  name: 'Coming home / leaving home',
  description: 'Headlights stay on after locking / come on when unlocking in the dark.',
  needs: 'Light sensor',          // hardware note or null
  partNumbers: null,              // optional regex string matched against the module's part number (22 F187)
  source: 'https://...',          // where the location came from
  verified: false,                // true only after checking on a real car
}
```

## coding.js API

```js
readCoding(adapter, onProgress) -> {
  at, vin, voltage, adapter,               // adapter: ATI/STI text
  platform: { id, label, writable, verified, security } | null,
  modules: [{ key, name, tx, rx, codeable, responded, error?,
              partNo?, swVersion?, systemName?,    // 22 F187 / F189 / F197
              data: { '0600': 'HEX...' } }],       // DID (4 hex) -> data hex, no 62/DID prefix
  features: [{ ...feature, current: value|null, available: bool, reason?: string }],
  transcript,
}
planChanges(reading, changes) -> [{ module, name, tx, rx, did, before, after,
                                    edits: [{ byte, before, after, features: [name] }],
                                    unverified: [feature names] }]
  // changes: [{ featureId, value }] or [{ module, did, hex }] (raw, same length as current).
  // Throws on unknown feature/option, non-codeable module, DID not allowed, length change,
  // platform not writable. Multiple changes to one DID merge into one write.
writeCoding(adapter, reading, plan, { backup, onProgress, minVoltage = 12.4 }) -> {
  at, results: [{ module, did, ok, error?, readback? }], transcript }
  // backup(record) is awaited before each write and must not throw.
planRestore(reading, backupRecord) -> plan  // same shape as planChanges
```

## UI: the Features tab

New tab **Features** next to Scan / Live / History. While it's open the header tag reads
"can write to car" in amber instead of "read-only scan".

1. **Before reading:** short explainer (what it does, backups, engine off + ignition on,
   battery >= 12.4 V, charger recommended) and the supported platforms with verified badges.
   Toolbar: status text, **Backups**, **Read car** (primary).
2. **After reading:** a car strip (platform, verified badge, battery voltage pass/fail,
   modules read). Unknown car: "No coding list for this car yet".
3. **Feature list** grouped by category. Each row: name, description, hardware note,
   module chip, "unverified" badge, control on the right (switch for 2 options, select for
   more). Disabled with a reason when the module didn't answer, the current value matches no
   option, or the platform is read-only.
4. Changing a control **doesn't write**: it goes to a sticky **pending changes** tray
   ("2 changes — Review / Discard"). Review shows setting, now, after, and the raw byte diff.
   **Write to car…** goes through the native confirm, then shows progress and per-module
   results (written and checked / refused + reason) and "switch the ignition off and on".
5. **Backups** panel: per module, date and reason (original / before write), **Restore…**.
6. **Advanced: raw coding** (collapsed): per module, the coding bytes as a grid; a byte opens
   its 8 bits as toggles. Edits go into the same pending tray as raw changes.

## IPC

- `coding:read (port)` -> reading (main keeps it as `lastReading`; saves original backups).
- `coding:write (port, changes)` -> plan from `lastReading`, native confirm, `writeCoding`,
  then re-read -> `{ results, reading }`, or `null` if cancelled.
- `coding:backups (vin)` -> list; `coding:restore (port, backupId)` -> confirm, write, re-read.
- Uses the existing `busy` claim, so coding can't run during a scan or live session.

## Phases

1. Read + backups + catalogue + UI + demo (works with nothing written to a car).
2. First real write on the S1: one harmless setting, read back, restore.
3. PSA (Corsa F): read-only probe of the car first; security access (27) and
   `writable: true` only after that.
