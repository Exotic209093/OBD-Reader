# Contributing

Thanks for helping. Start with [ARCHITECTURE.md](ARCHITECTURE.md) for how the app fits together.

## How changes get in

1. Fork the repo and make a branch.
2. `npm install`, make the change, run `npm test`.
3. Open a pull request using the template.

`main` is protected: every pull request needs the tests to pass on Ubuntu and Windows and an
approving review from the maintainer, who merges it. Nobody can push straight to `main`.

## Most useful contributions

- **Real captures from other makes.** Scan the car, then attach the saved scan's `transcript`
  (from `%APPDATA%/obd-reader/history`) to an issue. **Replace the VIN first**, because it
  identifies your car. Say the make, model, year and cable.
- **Fault code descriptions and fixes** in `src/codes.js`.
- **Confirming module addresses** for Vauxhall/Opel, Ford and Hyundai/Kia (`src/makes.js`).

## Rules

- Scans must stay read-only. Don't add service IDs to `READ_SIDS`, and never add session
  changes (10), security access (27), writes (2E), routines (31) or resets (11).
- New behaviour comes with a test using recorded or synthetic replies (`src/replay.js`).
- No real VINs, names or locations in fixtures, screenshots or logs.
- Security problems: report privately, see [SECURITY.md](SECURITY.md).
