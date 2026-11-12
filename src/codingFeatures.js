// Codeable features per platform (data only). Schema: docs/coding.md.
// Every entry stays `verified: false` until it has been written and read back on a real car.
// Research, sources and caveats for each entry: docs/coding-research.md.

const FEATURES = [
  // ---- audi-8x (A1/S1 8X, PQ25 modules) ----
  // All entries are in module 09, DID 0x0600 (VAG long coding).
  // Indexing: `byte` is a zero-based offset into the 0600 data, i.e. VCDS "Byte 00" = offset 0
  // (the vcds.fandom wiki copy uses "Byte 0" for the first byte). Bit N in VCDS = mask 1 << N.
  // partNumbers: VCDS reports label file 8X0-907-063.clb for the 8X central electronics; no source
  // maps bits per suffix (A..N), so the match is on the base number only and bits stay unverified.
  {
    id: 'audi-8x.09.cornering-fog',
    platform: 'audi-8x',
    module: '09',
    did: 0x0600,
    byte: 14,
    mask: 0x80,
    options: [
      { label: 'Off', value: 0x00 },
      { label: 'On', value: 0x80 },
    ],
    category: 'Lights',
    name: 'Cornering light via fog lights',
    description: 'The fog light on the inside of a turn lights up when you indicate or steer into a corner at low speed.',
    needs: 'Factory front fog lights',
    partNumbers: '^8X0 ?907 ?063',
    source: 'https://vcds-expert.com/2015/06/07/audi-a1-vcds-coding-list/ (Byte 14, Bit 7, default 0); https://www.scribd.com/document/771142090/Audi-A1-8X-VCDS-Wiki-codierungen (copy of vcds.fandom.com wiki: "Abbiegelicht ueber NSW", Byte 14, Bit 7)',
    verified: false,
  },
  {
    id: 'audi-8x.09.drl-no-dim-on-indicate',
    platform: 'audi-8x',
    module: '09',
    did: 0x0600,
    byte: 15,
    mask: 0x08,
    // Switches show options[0] as off and options[1] as on.
    options: [
      { label: 'Off (stays full brightness)', value: 0x00 },
      { label: 'On (dims)', value: 0x08 },
    ],
    category: 'Lights',
    name: 'Daytime lights dim when indicating',
    description: 'Choose whether the LED daytime running light dims on the side that is indicating. The daytime lights stay on either way.',
    needs: 'LED daytime running lights',
    partNumbers: '^8X0 ?907 ?063',
    source: 'https://vcds-expert.com/2015/06/07/audi-a1-vcds-coding-list/ (Byte 15, Bit 3, 1 = dimming active, default); https://www.scribd.com/document/771142090/Audi-A1-8X-VCDS-Wiki-codierungen (Byte 15, Bit 3)',
    verified: false,
  },
  {
    id: 'audi-8x.09.drl-rear',
    platform: 'audi-8x',
    module: '09',
    did: 0x0600,
    byte: 18,
    mask: 0x01,
    options: [
      { label: 'Off', value: 0x00 },
      { label: 'On', value: 0x01 },
    ],
    category: 'Lights',
    name: 'Tail lights on with daytime running lights',
    description: 'Rear lights come on together with the daytime running lights. Known side effect: the light-switch indicator stays lit and the navigation map stays in night mode.',
    needs: 'Xenon headlights (per source)',
    partNumbers: '^8X0 ?907 ?063',
    source: 'https://vcds-expert.com/2015/06/07/audi-a1-vcds-coding-list/ (Byte 18, code 72 -> 73, bit 0); https://www.scribd.com/document/771142090/Audi-A1-8X-VCDS-Wiki-codierungen (Byte 18 = 73)',
    verified: false,
  },

  // ---- psa-cmp (Opel/Vauxhall Corsa F, Peugeot 208 II) ----
  // Empty on purpose: no public source gives a BSI zone / bit for welcome or follow-me-home
  // lighting on CMP cars (see docs/coding-research.md). The Corsa F has these as personalisation
  // menu settings, so check there first. Do not guess a zone number.
  // Zone 234C (driver welcome, a seat feature) was documented on a 2018 3008 only, not a CMP car.
];

module.exports = { FEATURES };
