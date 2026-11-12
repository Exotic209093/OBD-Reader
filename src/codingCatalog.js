// Which cars can be coded and which modules/DIDs may be touched (design:
// docs/coding.md). The features themselves are data in codingFeatures.js.
// `verified` = a write and restore were done on a real car of this platform.
const { FEATURES } = require('./codingFeatures');

const PLATFORMS = [
  {
    id: 'audi-8x',
    label: 'Audi A1 / S1 (8X)',
    match: (vin) => /^(WAU|WUA|TRU)/.test(vin) && vin.slice(6, 8) === '8X',
    protocol: 'vag-uds',
    security: null,
    writable: true,
    verified: false,
    // 0x0600 = VAG long coding. 5F Information electronics (773/7DD on MQB
    // cars) is left out: not confirmed that the 8X radio/nav answers there.
    modules: [
      { key: '09', name: '09 Central electrics', tx: '70E', rx: '778', codeable: true, dids: [0x0600] },
      { key: '17', name: '17 Instruments', tx: '714', rx: '77E', codeable: true, dids: [0x0600] },
      { key: '46', name: '46 Comfort', tx: '70A', rx: '774', codeable: true, dids: [0x0600] },
    ],
  },
  {
    id: 'psa-cmp',
    label: 'Vauxhall Corsa F / Peugeot 208 II (2019+)',
    // VXK = Stellantis-era Vauxhall/Opel; position 4 'U' = CMP models (Corsa F,
    // Mokka B). Other VXK cars (Astra L, Grandland) share the WMI but not the
    // architecture. VR3 + U = Peugeot 208 II (unsourced; see coding-research.md).
    match: (vin) => /^(VXK|VR3)U/.test(vin),
    protocol: 'psa-uds',
    // Writes need PSA security access (27 03/04), which isn't implemented yet.
    // A PSA write must also be followed by 2E 2901 (else fault B1003).
    security: 'psa',
    writable: false,
    verified: false,
    // Addresses from ludwig-v's PSA ECU list, not yet seen on a Corsa F. On the
    // 208 II the PSA diagnostic bus may be on OBD pins 3/8 rather than 6/14, so
    // a standard cable might not reach these at all: the first read settles it.
    // No DIDs until a read-only probe of the car shows what's there.
    modules: [
      { key: 'BSI', name: 'BSI (body computer)', tx: '752', rx: '652', codeable: true, dids: [] },
      { key: 'CLUSTER', name: 'Instrument cluster', tx: '75F', rx: '65F', codeable: false, dids: [] },
      { key: 'NAC', name: 'Touchscreen (infotainment)', tx: '764', rx: '664', codeable: false, dids: [] },
    ],
  },
];

// Safety-critical modules that are never codeable, whatever the data says:
// OBD engine/gearbox addresses (and the functional 7DF), plus the VAG ABS,
// airbag and power steering addresses. Checked in code by address and by
// VAG module key so a catalogue mistake can't open them up.
const NEVER_CODEABLE_TX = new Set(['7DF', '7E0', '7E1', '7E2', '7E3', '7E4', '7E5', '7E6', '7E7', '713', '715', '712']);
const NEVER_CODEABLE_RX = new Set(['7E8', '7E9', '7EA', '7EB', '7EC', '7ED', '7EE', '7EF', '77D', '77F', '77C']);
const NEVER_CODEABLE_VAG_KEYS = new Set(['01', '02', '03', '15', '44']);

const upper = (s) => String(s || '').toUpperCase();
const didHex = (did) => did.toString(16).toUpperCase().padStart(4, '0');

function isCodeable(platform, mod) {
  if (!mod || mod.codeable !== true) return false;
  if (NEVER_CODEABLE_TX.has(upper(mod.tx)) || NEVER_CODEABLE_RX.has(upper(mod.rx))) return false;
  if (platform && platform.protocol === 'vag-uds' && NEVER_CODEABLE_VAG_KEYS.has(mod.key)) return false;
  return true;
}

// Writes are possible only on a writable platform whose security access (if
// any) is implemented. None is implemented yet.
const SECURITY_IMPLEMENTED = new Set();
const canWrite = (platform) => Boolean(platform && platform.writable === true && (!platform.security || SECURITY_IMPLEMENTED.has(platform.security)));

function platformForVin(vin, platforms = PLATFORMS) {
  if (typeof vin !== 'string' || !vin) return null;
  return platforms.find((p) => p.match(vin.toUpperCase())) || null;
}

const platformById = (id, platforms = PLATFORMS) => platforms.find((p) => p.id === id) || null;

const featuresFor = (platformId, features = FEATURES) => features.filter((f) => f && f.platform === platformId);

// What's wrong with a feature entry (empty = usable). Bad entries are shown
// as unavailable and never planned.
function featureProblems(f, platform) {
  const out = [];
  const int = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
  if (!f || typeof f.id !== 'string' || !f.id) return ['no id'];
  if (!platform || f.platform !== platform.id) out.push('unknown platform');
  else if (!platform.modules.some((m) => m.key === f.module)) out.push(`unknown module ${f.module}`);
  if (!int(f.did, 0xffff)) out.push('bad DID');
  if (!int(f.byte, 4094)) out.push('bad byte offset');
  if (!int(f.mask, 0xff) || !f.mask) out.push('bad mask');
  const opts = Array.isArray(f.options) ? f.options : [];
  if (opts.length < 2) out.push('needs at least two options');
  for (const o of opts) {
    if (!o || typeof o.label !== 'string' || !int(o.value, 0xff) || (o.value & ~f.mask) !== 0) out.push(`bad option ${o && o.label}`);
  }
  if (new Set(opts.map((o) => o && o.value)).size !== opts.length) out.push('duplicate option values');
  if (typeof f.name !== 'string' || !f.name) out.push('no name');
  if (typeof f.verified !== 'boolean') out.push('verified must be true or false');
  if (f.partNumbers !== null && f.partNumbers !== undefined) {
    try {
      new RegExp(f.partNumbers);
    } catch {
      out.push('bad partNumbers pattern');
    }
  }
  return out;
}

// A module's readable/writable DIDs: its own `dids` plus every DID a usable
// feature puts on it.
function moduleDids(platform, mod, features = featuresFor(platform.id)) {
  const dids = new Set(mod.dids || []);
  for (const f of features) {
    if (f && f.module === mod.key && !featureProblems(f, platform).length) dids.add(f.did);
  }
  return [...dids].sort((a, b) => a - b);
}

module.exports = {
  PLATFORMS,
  NEVER_CODEABLE_TX,
  isCodeable,
  canWrite,
  platformForVin,
  platformById,
  featuresFor,
  featureProblems,
  moduleDids,
  didHex,
};
