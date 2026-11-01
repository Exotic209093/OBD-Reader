// Per-make scan profiles, picked from the VIN's manufacturer code (WMI).
// A profile says how to read fault memory (which read-only services to try,
// in order) and which module addresses to ask. Unknown makes get the generic
// profile: standard OBD-II plus engine/gearbox fault memory.
// `verified` = module list checked against a real car.
//
// Fault-read protocols (all read-only):
//   uds   - UDS 19 02 (VAG, most 2015+ cars)
//   kwp   - KWP2000 18 (older ECUs on CAN)
//   gmlan - GMLAN A9 81 (GM/Vauxhall/Opel); replies arrive as single frames on
//           a separate "UUDT" id, so each GM module lists `uudt`.

const VAG_MODULES = [
  { name: '02 Transmission', tx: '7E1', rx: '7E9' },
  { name: '03 ABS / ESC', tx: '713', rx: '77D' },
  { name: '09 Central electrics', tx: '70E', rx: '778' },
  { name: '15 Airbags', tx: '715', rx: '77F' },
  { name: '16 Steering column', tx: '70C', rx: '776' },
  { name: '17 Instruments', tx: '714', rx: '77E' },
  { name: '19 Gateway', tx: '710', rx: '77A' },
  { name: '44 Power steering', tx: '712', rx: '77C' },
  { name: '46 Comfort', tx: '70A', rx: '774' },
];

// GMLAN high-speed CAN addresses: request 0x240+n, reply 0x640+n, UUDT 0x540+n.
// Body/comfort modules on the 95k mid-speed bus (pins 3/11) or single-wire
// bus (pin 1) can't be reached by a standard ELM/OBDLink cable.
const GM_MODULES = [
  { name: 'Transmission (TCM)', tx: '7E2', rx: '7EA', uudt: '5EA' },
  { name: 'ABS / ESP (EBCM)', tx: '243', rx: '643', uudt: '543' },
  { name: 'Body control (BCM)', tx: '241', rx: '641', uudt: '541' },
  { name: 'Airbags (SDM)', tx: '247', rx: '647', uudt: '547' },
  { name: 'Instruments (IPC)', tx: '24C', rx: '64C', uudt: '54C' },
];

// Ford UDS addresses on the high-speed bus (as used by FORScan).
const FORD_MODULES = [
  { name: 'Transmission (TCM)', tx: '7E1', rx: '7E9' },
  { name: 'ABS / ESP', tx: '760', rx: '768' },
  { name: 'Airbags (RCM)', tx: '737', rx: '73F' },
  { name: 'Body control (BCM)', tx: '726', rx: '72E' },
  { name: 'Instruments (IPC)', tx: '720', rx: '728' },
  { name: 'Power steering (PSCM)', tx: '730', rx: '738' },
];

const HYUNDAI_KIA_MODULES = [
  { name: 'Transmission (TCM)', tx: '7E1', rx: '7E9' },
  { name: 'ABS / ESC', tx: '7D1', rx: '7D9' },
  { name: 'Airbags', tx: '7D2', rx: '7DA' },
  { name: 'Power steering (MDPS)', tx: '7D4', rx: '7DC' },
  { name: 'Body control (BCM)', tx: '7A0', rx: '7A8' },
  { name: 'Instruments', tx: '7C6', rx: '7CE' },
];

// 7E0-7E7 are the standard OBD addresses, so every make's gearbox lives here.
const GENERIC_MODULES = [{ name: 'Transmission (TCM)', tx: '7E1', rx: '7E9' }];

const PROFILES = {
  vag: {
    id: 'vag',
    label: 'VW Group',
    engine: { name: '01 Engine', tx: '7E0', rx: '7E8' },
    protocols: ['uds'],
    extData: true,
    dtcStyle: 'vag',
    modules: VAG_MODULES,
    tool: 'VCDS or OBDeleven',
    verified: true,
  },
  gm: {
    id: 'gm',
    label: 'GM (Vauxhall / Opel)',
    engine: { name: 'Engine (ECM)', tx: '7E0', rx: '7E8', uudt: '5E8' },
    // Older Vauxhalls (Astra H, Zafira B, Insignia A) use GMLAN; newer ones UDS.
    protocols: ['uds', 'gmlan', 'kwp'],
    extData: false,
    dtcStyle: 'sae',
    modules: GM_MODULES,
    tool: 'Op-Com, Tech2 or a GM-capable scanner',
    verified: false,
  },
  ford: {
    id: 'ford',
    label: 'Ford',
    engine: { name: 'Engine (PCM)', tx: '7E0', rx: '7E8' },
    protocols: ['uds', 'kwp'],
    extData: false,
    dtcStyle: 'sae',
    modules: FORD_MODULES,
    tool: 'FORScan',
    verified: false,
  },
  hyundaiKia: {
    id: 'hyundaiKia',
    label: 'Hyundai / Kia',
    engine: { name: 'Engine (ECM)', tx: '7E0', rx: '7E8' },
    protocols: ['uds', 'kwp'],
    extData: false,
    dtcStyle: 'sae',
    modules: HYUNDAI_KIA_MODULES,
    tool: 'Hyundai/Kia GDS or a brand-capable scanner',
    verified: false,
  },
  generic: {
    id: 'generic',
    label: 'Generic OBD-II',
    engine: { name: 'Engine', tx: '7E0', rx: '7E8' },
    protocols: ['uds', 'kwp'],
    extData: false,
    dtcStyle: 'sae',
    modules: GENERIC_MODULES,
    tool: 'a scanner made for this make',
    verified: false,
  },
};

// Make -> profile, dealer-level tool to suggest, and VIN WMIs (first 3 characters).
// Makes on the generic profile get the standard OBD scan plus engine/gearbox
// fault memory; their other modules need make-specific addressing.
const MAKES = [
  ['Audi', 'vag', null, ['WAU', 'WUA', 'TRU']],
  ['Volkswagen', 'vag', null, ['WVW', 'WVG', 'WV1', 'WV2']],
  ['SEAT / Cupra', 'vag', null, ['VSS']],
  ['Skoda', 'vag', null, ['TMB']],
  ['Vauxhall / Opel', 'gm', null, ['W0L', 'W0V']],
  ['Ford', 'ford', null, ['WF0', 'SFA', '1FA', '1FM', '1FT', '3FA']],
  ['Hyundai', 'hyundaiKia', null, ['KMH', 'TMA', 'NLH', 'MAL', '5NP']],
  ['Kia', 'hyundaiKia', null, ['KNA', 'KND', 'KNE', 'U5Y', '5XY']],
  // Stellantis-era Vauxhalls (2019+ Corsa F etc.) are PSA underneath, not GM.
  ['Vauxhall / Opel (Stellantis)', 'generic', 'Diagbox or a PSA-capable scanner', ['VXK']],
  ['Peugeot', 'generic', 'Diagbox or a PSA-capable scanner', ['VF3', 'VR3']],
  ['Citroen / DS', 'generic', 'Diagbox or a PSA-capable scanner', ['VF7', 'VR7', 'VR1']],
  ['Renault', 'generic', 'Renault CLIP or DDT4All', ['VF1']],
  ['Dacia', 'generic', 'Renault CLIP or DDT4All', ['UU1']],
  ['BMW', 'generic', 'ISTA, BimmerLink or Carly', ['WBA', 'WBS', 'WBY', '5UX', '4US']],
  ['Mini', 'generic', 'ISTA, BimmerLink or Carly', ['WMW']],
  ['Mercedes-Benz', 'generic', 'Xentry or Carly', ['WDB', 'WDD', 'WDC', 'WDF', 'W1K', 'W1N', 'W1V']],
  ['Toyota', 'generic', 'Toyota Techstream', ['JTD', 'JTN', 'JTM', 'JTE', 'SB1', 'NMT', 'VNK']],
  ['Lexus', 'generic', 'Toyota Techstream', ['JTH', 'JTJ']],
  ['Honda', 'generic', 'Honda HDS', ['SHH', 'SHS', 'JHM', 'JHL']],
  ['Nissan', 'generic', 'Nissan Consult', ['SJN', 'JN1', 'JN8', 'VSK']],
  ['Mazda', 'generic', 'FORScan (covers Mazda) or Mazda IDS', ['JMZ', 'JM1', 'JM3']],
  ['Fiat', 'generic', 'MultiECUScan', ['ZFA']],
  ['Alfa Romeo', 'generic', 'MultiECUScan', ['ZAR']],
  ['Volvo', 'generic', 'Volvo VIDA', ['YV1', 'YV4']],
  ['Land Rover', 'generic', 'JLR SDD/Pathfinder', ['SAL']],
  ['Jaguar', 'generic', 'JLR SDD/Pathfinder', ['SAJ', 'SAD']],
  ['Suzuki', 'generic', null, ['JSA', 'TSM']],
  ['Mitsubishi', 'generic', null, ['JMB', 'JMY']],
  ['Subaru', 'generic', null, ['JF1', 'JF2']],
  ['Tesla', 'generic', null, ['5YJ', 'LRW', '7SA']],
];

function profileForVin(vin) {
  const wmi = (vin || '').toUpperCase().slice(0, 3);
  const hit = MAKES.find(([, , , wmis]) => wmis.includes(wmi));
  if (!hit) return { ...PROFILES.generic, make: null };
  const [make, profile, tool] = hit;
  return { ...PROFILES[profile], make, tool: tool || PROFILES[profile].tool };
}

module.exports = { PROFILES, MAKES, profileForVin };
