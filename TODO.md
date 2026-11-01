# To do

All items from 30/10/2026 are built (1/11/2026) but not yet tried on the car:

- Faster scans: CAN tried first (no ATSP0 search), repeated adapter settings skipped, address
  search only on a car's first scan or on request, silent modules skipped. Replay of the S1's
  30/10 scan: about 1,070 adapter commands down to 90. Check the real time on the car.
- Clear all codes in one click (engine always, plus every module with faults); misfire averages
  before → after shown in the clear result.
- Misfire advice after a repair ("Mark as repaired"), readiness monitors, freeze frame (mode 02),
  battery trend, live data CSV, per-step timings in saved scans.

## Still open

- **Zafira (2013 Zafira B):** confirm the GMLAN A9 read path and GMLAN 04 clear on the car.
- **Check gm/ford/hyundaiKia module lists on real cars** and mark them `verified` in `src/makes.js`.
- **Freeze frame on the S1:** decoder tested on synthetic replies only; check against a real stored code.
