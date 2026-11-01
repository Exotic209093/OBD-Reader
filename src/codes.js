// Known codes with plain-English advice. VAG numbers are VCDS-style; SAE codes
// apply to any make (the S1 notes call out VAG-specific causes).
// severity: 'stop' (don't drive), 'caution' (drive gently, fix soon), 'info'.
// Costs are rough UK figures (parts / garage fitted) and only a guide.

const misfire = (cyl) => ({
  title: `Cylinder ${cyl} misfire`,
  severity: 'caution',
  what: `Cylinder ${cyl} didn't fire properly. You feel it as a judder or hesitation, often under load at mid revs. Repeated misfires make the engine shut the cylinder off and light EPC.`,
  fixes: [
    `Swap the cylinder ${cyl} coil pack with a neighbour, clear codes, drive. If the misfire moves, the coil is bad.`,
    'Replace spark plugs if they are due (usually every 2-4 years / 37k miles, sooner if tuned).',
    'If coil and plugs are fine: injector, compression or intake valve carbon (garage diagnosis).',
  ],
  cost: 'Coil pack £25-45 each, plug set £30-50; garage fitting £80-150',
});

const VAG = {
  '15074': {
    title: 'Cylinder disabled',
    sae: 'P130A',
    severity: 'caution',
    what: 'The engine switched a cylinder off to protect itself and the catalytic converter after repeated misfires. This is what turns on the EPC light and cuts power.',
    fixes: ['Fix the underlying misfire (see the cylinder misfire fault).'],
    cost: 'Depends on the misfire cause',
  },
  '15125': { ...misfire(1), sae: 'P0301' },
  '15126': { ...misfire(2), sae: 'P0302' },
  '15127': { ...misfire(3), sae: 'P0303' },
  '15128': { ...misfire(4), sae: 'P0304' },
  '16503': {
    title: 'Coolant temperature sensor signal intermittent',
    sae: 'P0119',
    severity: 'caution',
    what: 'The coolant temperature sensor (G62) signal keeps dropping out. Symptoms: hard cold starts, high or hunting idle, temp gauge jumping, radiator fan running oddly.',
    fixes: [
      'Check the sensor plug for corrosion or a broken clip and the wiring for chafing.',
      'Replace the G62 sensor (cheap part, needs a little coolant drained).',
      'Watch the temperature gauge until fixed; pull over if it goes into the red.',
    ],
    cost: 'Sensor £15-30; garage £60-120',
  },
  '16400': {
    title: 'Camshaft/crankshaft position mismatch',
    sae: 'P0016',
    severity: 'stop',
    what: 'Cam and crank timing disagree. On the 2.0 TFSI this can mean a stretched timing chain or failing tensioner, which can wreck the engine if it jumps.',
    fixes: ['Avoid driving; have the timing chain and tensioner inspected.'],
    cost: 'Chain kit fitted £600-1,200',
  },
  '16683': {
    title: 'Turbo boost not reached',
    sae: 'P0299',
    severity: 'caution',
    what: 'The turbo isn\'t making the boost asked for. Usually a boost leak, split hose, diverter valve or wastegate problem.',
    fixes: ['Check intercooler hoses and the diverter valve; smoke test for boost leaks.'],
    cost: 'Hose/DV £30-150; turbo work much more',
  },
};

const SAE = {
  P0016: VAG['16400'],
  P0101: { title: 'Mass air flow sensor range/performance', severity: 'caution' },
  P0117: { title: 'Coolant temperature sensor circuit low', severity: 'caution' },
  P0118: { title: 'Coolant temperature sensor circuit high', severity: 'caution' },
  P0119: VAG['16503'],
  P0130: { title: 'Upstream oxygen sensor circuit fault', severity: 'caution' },
  P0134: {
    title: 'Upstream oxygen sensor not responding',
    severity: 'caution',
    what: 'The oxygen sensor before the catalytic converter (bank 1, sensor 1) is not switching. Fuel economy can drop and the car may fail the MOT emissions test. A one-off pending code on a cold, short trip is common; it matters if it comes back.',
    fixes: [
      'Check the sensor plug and wiring near the exhaust manifold for heat damage or corrosion.',
      'Check the sensor heater fuse; a dead heater often sets this code too.',
      'If wiring is fine, replace the front oxygen sensor.',
    ],
    cost: 'Sensor £30-80; garage fitted £90-180',
  },
  P0171: { title: 'Running lean (too much air / too little fuel)', severity: 'caution', what: 'Often a vacuum leak or PCV valve on the 2.0 TFSI.' },
  P0172: { title: 'Running rich', severity: 'caution' },
  P0234: { title: 'Turbo overboost', severity: 'caution' },
  P0299: VAG['16683'],
  P0300: { ...misfire('(random)'), title: 'Random/multiple cylinder misfire' },
  P0301: VAG['15125'],
  P0302: VAG['15126'],
  P0303: VAG['15127'],
  P0304: VAG['15128'],
  P0420: { title: 'Catalytic converter efficiency low', severity: 'info', what: 'Cat is wearing out, or caused by earlier misfires. Will fail an MOT emissions test.' },
  P0571: { title: 'Brake light switch', severity: 'caution', what: 'Common EPC cause on VW/Audi. Check your brake lights work.', cost: 'Switch £10-25' },
  P130A: VAG['15074'],
  P2187: { title: 'Lean at idle', severity: 'caution', what: 'Usually a vacuum leak or PCV valve.' },
};

function lookup(id) {
  if (id.number && VAG[id.number]) return VAG[id.number];
  const sae = id.sae && id.sae.split(' ')[0];
  if (sae && SAE[sae]) return SAE[sae];
  return null;
}

const describe = (id) => {
  const k = lookup(id);
  if (!k) return null;
  return k.sae ? `${k.title} (${k.sae})` : k.title;
};

module.exports = { VAG, SAE, lookup, describe };
