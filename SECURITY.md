# Security policy

## Supported versions

Only the latest release gets fixes.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately through
GitHub: **Security → Report a vulnerability** on this repository. You'll get a reply within
7 days, and a fix or a plan within 30 days for confirmed issues.

Include what you found, how to reproduce it, and what it lets someone do.

## What counts

This app talks to a car's diagnostic bus, so safety matters as much as data security.
Treat these as vulnerabilities:

- **Anything that makes a scan write to the car.** Scans must stay read-only: no clearing
  (OBD 04, UDS/KWP 14), session changes (10), security access (27), writes (2E), routines (31)
  or resets (11). The `READ_SIDS` allowlist in `src/scan.js` and `CLEAR_SIDS` in `src/clear.js`
  enforce this.
- **Clearing codes without the user confirming** in the native dialog (`clear:run` in `src/main.js`).
- **Coding that goes beyond its allowlist** (`codingAllowed` in `src/coding.js`): any write without
  the native confirm (`coding:write`/`coding:restore`), without a backup saved first, to a module
  that isn't codeable (engine, gearbox, ABS, airbags, power steering never are), to a DID outside
  the catalogue, or any flashing (34-37), routine (31), reset (11) or comms-control (28) request.
- **The renderer reaching Node or the serial port directly**, bypassing the preload bridge
  (`contextIsolation`, `sandbox`, the Content Security Policy in `renderer/index.html`).
- **Path traversal or file writes outside** the history folder and the files the user picks.
- **Leaking personal data.** Saved scans hold the car's VIN; it should never leave the
  computer unless the user exports it.

## Not in scope

- Faults in the car, the adapter's firmware or cheap clone adapters.
- Wrong or missing advice text for a fault code: open a normal issue.
