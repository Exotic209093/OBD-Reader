# Coding research: Audi S1 (8X) and Vauxhall Corsa F

Researched 2026-11-12 from public web sources only. Nothing here was tested on a car.
Confidence labels: **2 sources** = two listings that agree (they may share an origin, the
VCDS wiki and forum lists copy each other); **1 source** = a single listing; **none** = not found.

Design and schema: `docs/coding.md`. Entries that made it into code: `src/codingFeatures.js`.

## 1. Audi S1 (8X, PQ25 modules, VAG UDS)

### Conventions and part numbers

- Long coding is DID `0x0600`. VCDS "Byte N" is zero-based, which matches the offset into the 0600 data.
  Evidence: the VCDS wiki copy uses "Byte 0" for the first byte of the RLS sub-coding
  ([Scribd copy of vcds.fandom.com A1 8X page](https://www.scribd.com/document/771142090/Audi-A1-8X-VCDS-Wiki-codierungen)).
  A shared-Audi-module reference says byte 0 holds the model code, 08 = A1 8X
  ([VWVortex reference](https://www.vwvortex.com/threads/a4-module-coding-adaptation-reference.9501572/), found via search snippet, **not** checked for PQ25).
  Cheap sanity check once the car is read: byte 0 of module 09 coding should be `08`.
  If it is not, stop and recheck the indexing before writing anything.
- Module 09 (central electronics) part number: VCDS scans of A1 8X show label file `8X0-907-063.clb`,
  e.g. "8X0 907 063 N" / "8X0 907 063 G" (search snippet of [a1-forum VCDS thread](https://www.a1-forum.co.uk/threads/how-to-vcds-coding.4473/page-22),
  [parts listing 8X0907063A Hella](https://www.centralinemotore.com/en/product-page/8x0907063a-centralina-body-computer-bcm-audi-a1-sportback)).
  **No source says which suffixes (A..N) share a bit layout.** The code matches the base number only.
- Module 17 (cluster) and 46 (comfort): **no part number found anywhere.** Read 22 F187 from the S1 and add them.
- The 2020 A1 (GB) is different: its BCM (5Q0 937 084) has no long coding, only named adaptation channels
  ([Ross-Tech forum](https://forums.ross-tech.com/index.php?threads/26150/)). Do not apply any list here to it.
- The Ross-Tech wiki has no 8X tweaks page and no Polo 6R/6C one (both URLs returned 404 when tried).
  The lists below come from the VCDS wiki mirror, VCDS-Expert and the a1-forum thread.
- Adaptation channels (VCDS function 10): the sources give **names and values but no DID numbers**, so
  none are in `codingFeatures.js`. Reading DIDs from the car's channel map is an open task.

### Features owners commonly enable

"In code" = present in `src/codingFeatures.js`. Polarity is the value that turns the feature on.

| Feature | Module | Mechanism | Hardware | Location known? | In code | Caveats |
|---|---|---|---|---|---|---|
| Cornering light via fog lights | 09 | DID 0600 byte 14, bit 7 (0x80); 1 = on, default 0 | Fog lights | 2 sources: [VCDS-Expert](https://vcds-expert.com/2015/06/07/audi-a1-vcds-coding-list/), [VCDS wiki copy](https://www.scribd.com/document/771142090/Audi-A1-8X-VCDS-Wiki-codierungen) | yes | Needs fitted fog lights. No part number in either source. |
| LED DRL dimming when indicating | 09 | byte 15, bit 3 (0x08); 1 = dim (default), 0 = no dim | LED DRL | 2 sources (same two) | yes | DRL stays on either way, so this is not "disabling DRLs". |
| Tail lights with DRL | 09 | byte 18, bit 0 (0x01); value 0x72 -> 0x73 | Xenon (per source) | 3 sources (same two, plus a1-forum snippet) | yes | Side effects per source: switch light stays lit, nav map stays in night mode. Unclear whether 72/73 is hex or decimal; both give bit 0, so the mask is the same. |
| Coming/leaving home: which lamps | 09 | byte 17, bit 3 (0x08); checked = via fog lights, unchecked = via xenon | Fog or xenon | 2 sources: [vag-coding.fr](https://www.vag-coding.fr/audi/a1-8x/a1-8x-coming-leaving-home-avec-les-xenons/), [VCDS wiki copy](https://www.scribd.com/document/771142090/Audi-A1-8X-VCDS-Wiki-codierungen) | no | Only picks the lamp source. **No source gives the bit that turns coming/leaving home on.** One a1-forum user found no such option in the helper. |
| Coming/leaving home via DRL | 09 | byte 14, bit 0 (0x01), "Front fog-light installed" cleared | LED DRL | 1 source: [vag-coding.fr](https://www.vag-coding.fr/audi/a1-8x/a1-8x-coming-leaving-home-avec-les-feux-de-jour-drl/) | no | The page is incoherent: it says to untick "fog light installed", which may disable real fog lights. Not usable. |
| Coming/leaving home duration | 09 | adaptation "Coming Home Time" (default 15 s), "Leaving Home Time" (default 60 s), max 60 s | none | names only: [VCDS-Expert](https://vcds-expert.com/2015/06/07/audi-a1-vcds-coding-list/) | no | No DID. |
| Needle sweep | 17 | adaptation "staging / Inszenierung" set active | none | name only: [AS.Coding](https://www.ascoding.ch/en/audi-a1-8x-e/) (search snippet), VCDS wiki copy | no | No DID. Other cars use long coding byte 1 bit 0; not sourced for 8X. |
| Refuel quantity display, lap timer, oil temp in cluster | 17 | adaptation / long coding labels only | cluster-dependent | labels only (AS.Coding, search snippet) | no | No byte, bit or DID. |
| Horn confirmation on lock | 09 | long coding byte 5 bits 1 and 4 (0x12) plus adaptation channel 63, 0x40 -> 0x44 | horn | 1 source: [VCDS wiki copy](https://www.scribd.com/document/771142090/Audi-A1-8X-VCDS-Wiki-codierungen) | no | Needs both parts; the adaptation has no DID. Another list puts the bit at byte 6, bit 1 (the "alarm siren type" entry), so the sources conflict. |
| Mirror dip in reverse, auto-fold | 52 / 42 | long coding byte 4 (bit 6 dip, bit 4 fold) | electric folding / memory mirrors | 1 source: VCDS wiki copy | no | Door modules 42/52 are not in the app's module list. Polarity not given. |
| Rear wiper in reverse off | 09 | byte 21, bit 6 | none | 1 source: VCDS-Expert | no | No polarity given. |
| MMI hidden menu | 5F | adaptation channel 06 -> 1 (VCDS wiki copy, "Navigation+") | MMI nav | name only | no | Channel numbers vary; no DID. |

**Not located for S1 at all:** welcome/coming-home enable bit on module 09; any module 46 item.
The OBDeleven forum lists byte 6, bits 0-7 for coming/leaving home but that list is for the B8/MLB-era
module and an A4 thread said not to apply it to the 8X ([OBDeleven forum](https://forum.obdeleven.com/thread/3954/long-coding-options-control-modules)).

## 2. Vauxhall Corsa F (Stellantis CMP, same base as Peugeot 208 II)

### Practical answer for welcome lighting

Check the car's own menu first. The 2020-2026 Corsa F manual lists "Entry lighting", "Exit lighting
(follow me home)", "Vehicle locator lighting" and "Peripheral lighting" under its lighting features
([manual index](https://www.mycarusermanual.com/vauxhall/corsa/4-door/2020/lighting); the page text was
truncated, so the menu path and equipment conditions were **not** confirmed). The 2023 manual, as
summarised by a search result, says welcome lighting can be switched on/off in vehicle personalisation settings
([Auto User Guide](https://www.autouserguide.com/vauxhall/2023-vauxhall-corsa-interior-and-exterior-lighting-user-manual/), search snippet only).
On the Peugeot 208 II these are ordinary Driving/Vehicle menu settings, not hidden
([Otoideal](https://www.otoideal.com/en/blog/peugeot-hidden-features-guide), a commercial page, treat with care).
If the lights do not come on, likely causes are the setting being off, or the trim lacking the
hardware it needs. Coding cannot add lamps. The old Corsa D "P-menu" trick does not apply.

### Feature table

No BSI zone or bit for welcome lighting or follow-me-home was found for CMP cars. Nothing is in `codingFeatures.js`.

| Feature | Module | Mechanism | Hardware | Location known? | Caveats |
|---|---|---|---|---|---|
| Welcome / entry lighting | BSI | zone unknown | lamps and trim dependent | **none** | Also needs the menu entry shown on the infotainment (see below). |
| Follow-me-home / exit lighting | BSI | zone unknown | as above | **none** | Same. |
| Show hidden menu entries (lighting, DRL, etc.) | BSI + NAC | BSI "presence in personalisation menu" parameter, then add the entry in NAC zone 2127 | none | partly: menu paths only, no zone/bit. [Peugeot-Talk](https://www.peugeottalk.de/index.php?thread%2F9566-nac-arduino-parameters-bsi-configuration%2F=) (508 RXH, old NAC, not CMP) | Poster says the menu items "just displayed" until BSI config changed: NAC is only the display. |
| Driver Welcome (seat memory move) | BSI 234C (0/1) + NAC 2127 | UDS 2E write after 27 03 unlock, then 2E 2901 traceability | electric seat | 1 source: [Mittns](https://www.mittns.de/thread/2179-freigabe-der-driver-welcome-funktion/) | A 2018 3008 GT, not CMP. Not a lighting feature. Shown only as proof of the write sequence. |

### Addresses and protocol

- BSI: `0x752` / `0x652` (UDS). Cluster (COMBINE/IPC): `0x75F` / `0x65F`. Infotainment (NAC, IVI, "head unit", TELEMAT row): `0x764` / `0x664`.
  Source: [ECU_LIST.md](https://github.com/ludwig-v/arduino-psa-diag/blob/master/ECU_LIST.md).
  That page labels the column "IDs command" without saying which side is request; the sketch itself uses
  `CAN_EMIT_ID = 0x752`, `CAN_RECV_ID = 0x652` for the BSI ([sketch](https://github.com/ludwig-v/arduino-psa-diag/blob/master/arduino-psa-diag/arduino-psa-diag.ino)),
  so request is the first number. 11-bit, 500 kbit/s.
- UDS vs KWP: the sketch treats session `C0` as KWP and anything else as UDS; the BSI, COMBINE_UDS and NAC rows are UDS variants
  ([README](https://github.com/ludwig-v/arduino-psa-diag)). The Corsa F's exact BSI variant (`BMF_UDS_PSA_NEA` shares 752/652) is not confirmed on a car.
- Other ids seen on 208 II/e-208: `0x6A2`/`0x682` (VCU), `0x6B4`/`0x694` (battery) ([OpenVehicles](https://www.openvehicles.com/node/2505)).
- **OBD pins (hardware catch).** On the 208 II / e-208 only pins 1, 3, 4, 5, 6, 8, 14, 16 are wired. Pins 6/14 are the standard
  bus; the PSA diagnostic CAN is on pins 3 (H) / 8 (L), both 500 kbit/s ([OpenVehicles](https://www.openvehicles.com/node/2505),
  [Mittns pinouts](https://www.mittns.de/thread/884-obd-diagnose-anschl%C3%BCsse-fundorte-und-pin-belegungen/)). One poster says newer or updated cars
  expose it on the standard pins, with no detail. An ELM327/OBDLink uses pins 6/14, so it **may not reach the BSI at all** without a pin-swap adapter
  (SpeakEV reports an adapter that routes 8 -> 14 and 3 -> 6). Whether the Corsa F answers 752/652 on pins 6/14 is **unconfirmed**.

### Session and security

- Session: `10 03` ("UDS Coding"); `10 02` is the download session; KWP uses `10 C0` ([README](https://github.com/ludwig-v/arduino-psa-diag)).
  The app's coding rules allow only `10 01` / `10 03`, which is enough.
- Security: `27 03` requests the seed for configuration, key goes back with `27 04 <key>` within 5 seconds of the seed.
  `27 01` / `27 02` is the download level, which the app must never use. Errors: `7F 27 36` too many attempts, `7F 27 13` wrong key length/answer.
- Algorithm: public, with C/Python/JS sources in [psa-seedkey-algorithm](https://github.com/ludwig-v/psa-seedkey-algorithm) (GPL-3.0).
  Per-ECU secret: a 2-byte key per ECU variant, listed by supplier/variant in
  [ECU_KEYS.md](https://github.com/ludwig-v/psa-seedkey-algorithm/blob/master/ECU_KEYS.md) (BSI, instrument panel and NAC sections exist; not split by level).
  The Corsa F's BSI variant (Delphi EL3, "EL HW D6" per the [Elektroda thread](https://www.elektroda.com/rtvforum/topic3743099-30.html)) was **not** matched to a key
  in this research. Verify the key against the exact variant before use; a wrong key burns attempts (`7F 27 36`).
- Writes: `2E <zone> <data>` after unlock. The documented Mittns sequence is
  `10 03`, `22 234C`, `27 03` unlock, `2E 234C 01`, `2E 2901 FD000000010101` ("secured traceability"), `10 01`.
  The README says a configuration write must be followed by the 2901 traceability write, otherwise the ECU logs DTC **B1003**
  and (per the Elektroda summary) can go into a locked mode until 2901 is written.
  **The app's rule 2 currently allows only 2E for catalogue DIDs, so the 2901 write needs to be a catalogue DID for PSA.**
- Effect: the sources show a re-read right after the write and `10 01`; none state whether an ignition cycle or reset is needed. **Unknown.**

### Secure Gateway (SGW)

- Stellantis SGW blocks writes from the diagnostic socket without authentication and leaves reads open (general sources:
  [Klavkarr](https://www.klavkarr.com/blog/65-security-gateway-stellantis-fca-psa), [Auto-Diagnostik](https://auto-diagnostik.de/en/blogs/blog/autel-secure-gateway-sgw-freischaltung)).
  The Diagbox 9.268 notes name the **308 III, 408 and Astra L** (EMP2, 2021+) as the models with the new gateway design
  (forum changelog text, e.g. [garageforum](https://garageforum.org/archive/index.php?thread-20105.html=); pirate-software forums, low reliability).
- **No source names the Corsa F or 208 II as having an SGW, or as not having one.** All in-car evidence is that the BSI is reached
  by raw UDS on 752/652; but the public Corsa F/208 II work was done at the BSI pads on the bench, not through the OBD socket
  ([Elektroda](https://www.elektroda.com/rtvforum/topic3743099-30.html), summarised by search results, page itself timed out). So SGW on a 2020+ Corsa F is **unresolved**.
  Also unresolved: whether the facelift (2023+) changed anything.
- Read-only probing is safe: a refusal or silence from `10 03` / `22` will tell us. Keep `writable: false` until then.

### VIN / WMI

- Corsa F VINs start **VXK**; model letter at position 4 is **U** (Corsa F and Mokka B), plant 4 = Zaragoza. Example VIN `VXKUPHNK6L4123456`
  ([Opel Team Niedersachsen](https://www.opel-team-niedersachsen.de/fahrgestellnr.html)). VXK is listed there as PSA Automobiles SA, later Stellantis.
- The GM-era codes are `W0L` (Opel and Vauxhall until 06/2017) and `W0V` (Opel from 07/2017, e.g. Astra K, Corsa E). One decoder site lists W0V for the Corsa; the stronger source does not.
- **How to tell them apart:** WMI `VXK` and position 4 `U` = Stellantis Corsa F; `W0V`/`W0L` with position 6 `E` for Corsa E (pos 5 `X`) = GM.
  Caveat: Corsa-e and Vauxhall-badged cars were not shown separately in any source; they should be VXK too (Vauxhall cars were built with Opel's WMIs), **unconfirmed**.
  (Peugeot's own WMI, `VR3` from general knowledge, was not sourced here.) The app's `W0V -> gm` mapping is right for GM-era cars but a Stellantis Vauxhall needs `VXK` -> psa-cmp.
  Other VXK vehicles (Astra L, Grandland B, Crossland, Mokka B) share the WMI but not the architecture, so match position 4 `U` as well.

### Infotainment ("tablet") and cluster hidden options

- Addresses: NAC/IVI `0x764`/`0x664`, cluster `0x75F`/`0x65F` (above). NAC config goes through zone 2127 (menu entries) with the
  separate [arduino-psa-nac_rcc_cirocco](https://github.com/ludwig-v/arduino-psa-nac_rcc_cirocco) tools; that repo mentions no Corsa F or 208 II.
- Whether the Corsa F touchscreen is a "NAC" or a newer unit is **not established**; the zone 2127 menu paths in the sources are from the 508 RXH and 3008 era.
- Hidden cluster options: nothing sourced.

## 3. Excluded on purpose (the app must never offer these)

Seatbelt chime or warning (VCDS 17 "disable seatbelt warning" is documented but excluded), airbag/SRS, ABS/ESC/XDS/hill hold/brake disc drying, TPMS,
video-in-motion, disabling DRLs, headlight washer removal, speed limiters or speed warnings, start-stop defeat, emissions/exhaust/DPF/engine/gearbox
changes, steering or power-steering assistance, key/immobiliser/PIN work, mileage, and PSA download-level (27 01) or traceability tricks beyond the one
required write. Module keys 03, 15, 16, 19, 44 stay non-codeable.

## 4. Subscription and online features (not codeable)

These are server-side and cannot be enabled by writing coding: Vauxhall/Opel Connect and PSA connected services (remote lock, vehicle status, SOS/assistance
via the app), live/online navigation (traffic, online POI), over-the-air updates, smartphone app features, and any feature whose menu item exists but
needs an account or a paid plan. Coding can only reveal a menu entry; the function behind it still needs the server or a hardware module
(the Peugeot-Talk poster saw entries appear that "didn't work", only displayed).
On the Audi side, Audi connect/MMI online services are likewise not coding items.

## 5. Open questions only a car can answer

1. S1: does `22 0600` return long coding on 09/17/46? Is byte 0 of 09 equal to `08`? Which 22 F187 part number and software does the 09 module report (the code matches `8X0 907 063` only)?
2. S1: do the three 09 entries match this car's equipment (fog lights, LED DRL, xenon or LED headlights)? Does the module accept a 2E write without security access?
3. S1: what are the DIDs of the adaptation channels (coming home time, needle sweep, horn confirm)? Where is the coming/leaving-home enable bit on this module?
4. Corsa F: does the BSI answer on 752/652 over OBD pins 6/14, or only on 3/8? Does `10 03` give `50 03`?
5. Corsa F: is there an SGW or equivalent that blocks `27 03` / `2E` from the OBD socket? Which model year?
6. Corsa F: which BSI variant, and is its seed/key key listed in ECU_KEYS? What is the infotainment type and its address?
7. Corsa F: which BSI zone holds welcome lighting and follow-me-home on a CMP car (a read-only zone dump compared before and after toggling the menu setting would find it)?
8. Corsa F: does a write need an ignition cycle or reset?
