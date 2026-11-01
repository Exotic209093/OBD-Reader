# OBD Reader

Read-only fault scanner for ELM327-compatible cables (tested with the USB
OBDLink/FTDI cable on a 2016 Audi S1). Scans never change anything; codes are
only cleared when you press **Clear codes…** → **Clear all codes** and confirm. It
never changes diagnostic sessions or requests security access.

> **Use at your own risk.** This is a hobby tool, not a dealer diagnostic system. Scans are
> read-only, but clearing codes hides faults and resets emissions readiness. Get airbag, ABS and
> brake faults checked by a professional. Only the 2016 Audi S1 has been tested on a real car.

## Requirements

- Windows, macOS or Linux with Node.js 20+
- An ELM327-compatible USB cable (an OBDLink/FTDI cable works best; cheap Bluetooth clones often don't)
- A car on 11-bit 500k CAN (most 2008+ cars)

## Install

```
git clone https://github.com/Exotic209093/OBD-Reader.git
cd OBD-Reader
npm install
npm start
```

## Use

1. Close OBDwiz (only one program can use the cable).
2. Plug in the cable and turn the ignition on.
3. `npm start`, pick the port (auto-selected), press **Scan car**.

The CLI takes the port name your system uses, e.g. `COM7` on Windows or `/dev/ttyUSB0` on Linux.

`npm run demo` replays a recorded scan without the car.
`npm run scan -- COM7` prints the same report as JSON in the terminal.
`npm test` runs decoder and full-scan tests against recorded replies.

## Tabs

- **Scan** – full read-only scan with a verdict (all good / fix soon / stop),
  plain-English advice per fault (what it means, what to check, rough UK cost),
  a "since last scan" comparison, emissions readiness and freeze frame. **Mark as repaired**
  on a misfire tells the advice to read the slowly falling 10-drive average in that light.
  Export with Copy text, Save .txt or Save PDF.
- **Live** – engine running: rpm, speed, boost, throttle, load, temperatures,
  battery, timing, fuel trims, air flow, 60 s rpm/boost charts and per-cylinder
  misfire counters for the current drive (cards flash red when one goes up).
  **Save CSV** after stopping keeps every reading of the session.
- **History** – every scan is saved automatically to
  `%APPDATA%/obd-reader/history`; open or delete old scans. Battery voltage trend on top.
  Repairs you mark are in `repairs.json` in the same folder.

Advice text and costs live in `src/codes.js`; the logic is in `src/advice.js`.
`electron scripts/snapshot.js <dir>` saves demo screenshots and a PDF.

## What it reads

- Check engine light, generic stored/pending/permanent codes, VIN, battery voltage, coolant, rpm
- Engine fault memory via UDS (VAG numbers, mileage and time of each fault)
- Mode 06 misfire counters per cylinder
- Fault memory of other VAG UDS modules (ABS, airbags, instruments, steering, comfort, …)
- Make is picked from the VIN (`src/makes.js`):
  - VW Group (Audi, VW, SEAT/Cupra, Skoda): all modules above, checked on a real car
  - Vauxhall/Opel (GM era, pre-2019): UDS or GMLAN; engine, gearbox, ABS, body, airbags, instruments
  - Ford, Hyundai/Kia: UDS; engine, gearbox, ABS, airbags, body, instruments, power steering
  - BMW, Mini, Mercedes, Toyota, Lexus, Honda, Nissan, Mazda, Peugeot, Citroen/DS, Renault,
    Dacia, Fiat, Alfa, Volvo, Land Rover, Jaguar and others: generic OBD plus engine and
    gearbox fault memory, with the right dealer tool suggested for everything else
  - Non-Audi module lists are not yet checked on real cars; the app says so in the report
- Only 11-bit 500k CAN cars are scanned (most 2008+); other protocols get a clear message
- **Module search**: on a car's first scan, after listening to the bus, asks every diagnostic
  id 600-7F7 that the car isn't already using and reads any module that answers, named from
  its own ID where it gives one. Later scans reuse the modules it found and skip listed modules
  that didn't answer in the last 3 scans. Tick **Search every address again** to redo it.
  Older KWP2000 modules are read too
- **Clear codes…**: clears the engine (codes, misfire counters, freeze frame) and every module
  with faults in one go, with the protocol each was read with, then
  rescans so you can see what really went. Modules that need a dealer session say so
- Each saved scan keeps its raw adapter transcript so it can be replayed in tests

Modules that use the older KWP/TP2.0 protocol (often 09 and 19 on PQ25 cars)
won't answer; use VCDS or OBDeleven for those.

## Layout

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together and the safety rules.

- `src/elm.js` – serial transport for the adapter
- `src/decode.js` – pure parsers (ISO-TP reassembly, DTCs, extended data)
- `src/scan.js` – scan sequence and module list
- `src/codes.js` – known code descriptions (add more here)
- `src/replay.js` – recorded replies for demo mode and tests
- `renderer/` – UI

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Pull requests need passing tests and the maintainer's
review before they're merged. Report security problems privately: see [SECURITY.md](SECURITY.md).

## Licence

GPL-3.0-only. See [LICENSE](LICENSE).
