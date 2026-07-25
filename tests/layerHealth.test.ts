/**
 * tests/layerHealth.test.ts
 *
 * Pins the Layer Health builder: every fact a layer can state about its
 * spatial standing renders as a row a user can read without the docs, every
 * unknown fails closed as "unknown" / "not established" instead of a guess,
 * and the cross-layer report never claims more than the classification
 * proved. The wording ban is asserted over every string both builders can
 * produce, because a marketing word in a compatibility verdict is a claim
 * the geometry has not earned.
 */

import { describe, it, expect } from 'vitest';
import {
  buildLayerHealth,
  buildCompatibilityReport,
  type LayerHealthInput,
  type LayerHealthRow,
} from '../src/app/layerHealth';

/** A fully-known, verified, mounted layer — overrides carve doubt back in. */
function base(over: Partial<LayerHealthInput> = {}): LayerHealthInput {
  return {
    name: 'north-quarry.laz',
    crsName: 'NAD83 / UTM zone 13N',
    crsSource: 'las-vlr',
    horizontalUnit: 'metre',
    verticalUnit: 'metre',
    verticalDatum: 'NAVD88',
    compatibility: 'verified',
    mounted: true,
    sourceOrigin: [512000, 4310000, 1500],
    frameOffset: [12, -7, 0.5],
    precisionMm: 0.02,
    precisionBasis: 'projected-linear-unit',
    streaming: false,
    soleLayer: false,
    ...over,
  };
}

function row(rows: LayerHealthRow[], label: string): LayerHealthRow {
  const r = rows.find((x) => x.label === label);
  expect(r, `row "${label}" must exist`).toBeDefined();
  return r!;
}

/** Words that assert quality the app has not measured. Never produced. */
const BANNED = /\b(accurate|precise|certified|survey-grade|professional)\b/i;

describe('buildLayerHealth — compatibility explanations', () => {
  it('verified explains that both references are shared', () => {
    const r = row(buildLayerHealth(base()), 'Compatibility');
    expect(r.value).toContain('verified');
    expect(r.value).toMatch(/horizontal and vertical/);
    expect(r.status).toBe('ok');
  });

  it('horizontal-only states the consequence: plan placement, own heights', () => {
    const r = row(buildLayerHealth(base({ compatibility: 'horizontal-only' })), 'Compatibility');
    expect(r.value).toContain('horizontal-only');
    expect(r.value).toContain('placed in plan');
    expect(r.value).toContain('keeps its own heights');
    expect(r.status).toBe('warn');
  });

  it('unknown says a shared frame is not established, not "fine"', () => {
    const r = row(buildLayerHealth(base({ compatibility: 'unknown' })), 'Compatibility');
    expect(r.value).toContain('unknown');
    expect(r.value).toContain('not established');
    expect(r.status).toBe('warn');
  });

  it('incompatible names the different frame and its exclusion', () => {
    const r = row(buildLayerHealth(base({ compatibility: 'incompatible' })), 'Compatibility');
    expect(r.value).toContain('incompatible');
    expect(r.value).toContain('different frame');
    expect(r.status).toBe('warn');
  });

  it('null compatibility fails closed as "not established"', () => {
    const r = row(buildLayerHealth(base({ compatibility: null })), 'Compatibility');
    expect(r.value).toContain('not established');
  });
});

describe('buildLayerHealth — unknown facts fail closed', () => {
  it('a missing CRS name renders "not established" even when a source tag exists', () => {
    const rows = buildLayerHealth(base({ crsName: null, crsSource: 'las-vlr' }));
    const r = row(rows, 'Coordinate system');
    expect(r.value).toBe('not established');
    expect(r.status).toBe('warn');
  });

  it('missing units say "unknown" — the vertical never borrows the horizontal', () => {
    const rows = buildLayerHealth(base({ horizontalUnit: null, verticalUnit: null }));
    expect(row(rows, 'Horizontal unit').value).toBe('unknown');
    expect(row(rows, 'Horizontal unit').status).toBe('warn');
    expect(row(rows, 'Vertical unit').value).toBe('unknown');
    expect(row(rows, 'Vertical unit').status).toBe('warn');
  });

  it('the vertical unit stays its own fact when only the horizontal is known', () => {
    const rows = buildLayerHealth(base({ verticalUnit: null }));
    expect(row(rows, 'Horizontal unit').value).toBe('metre');
    expect(row(rows, 'Vertical unit').value).toBe('unknown');
  });

  it('a missing vertical datum renders "not established"', () => {
    const r = row(buildLayerHealth(base({ verticalDatum: null })), 'Vertical datum');
    expect(r.value).toBe('not established');
    expect(r.status).toBe('warn');
  });

  it('a missing source origin says so instead of inventing zero', () => {
    const r = row(
      buildLayerHealth(base({ sourceOrigin: null, frameOffset: null })),
      'Source origin',
    );
    expect(r.value).toBe('not declared');
    expect(r.mono).not.toBe(true);
  });

  it('no frame offset reads as "not in a shared frame"', () => {
    const r = row(buildLayerHealth(base({ frameOffset: null })), 'Offset to project');
    expect(r.value).toContain('not in a shared frame');
    expect(r.mono).not.toBe(true);
  });
});

describe('buildLayerHealth — precision readout', () => {
  it('sub-millimetre values keep two decimals: 0.02 mm', () => {
    const r = row(buildLayerHealth(base({ precisionMm: 0.02 })), 'Mount precision');
    expect(r.value).toBe('0.02 mm');
    expect(r.status).toBe('ok');
    expect(r.mono).toBe(true);
  });

  it('millimetre-and-up values keep one decimal: 1.0 mm, still inside budget', () => {
    const r = row(buildLayerHealth(base({ precisionMm: 1 })), 'Mount precision');
    expect(r.value).toBe('1.0 mm');
    expect(r.status).toBe('ok');
  });

  it('over the 1 mm budget the figure stays honest and the status turns warn', () => {
    const r = row(buildLayerHealth(base({ precisionMm: 2.5 })), 'Mount precision');
    expect(r.value).toBe('2.5 mm');
    expect(r.status).toBe('warn');
  });

  it('a geographic basis has no linear budget — degrees are not lengths', () => {
    const r = row(
      buildLayerHealth(base({ precisionMm: null, precisionBasis: 'geographic' })),
      'Mount precision',
    );
    expect(r.value).toBe('no linear budget (degrees)');
    expect(r.status).toBe('warn');
    expect(r.mono).not.toBe(true);
  });

  it('an unknown basis says unknown rather than borrowing a number', () => {
    const r = row(
      buildLayerHealth(base({ precisionMm: null, precisionBasis: 'unknown' })),
      'Mount precision',
    );
    expect(r.value).toContain('unknown');
    expect(r.status).toBe('warn');
  });

  it('null precision with no basis is "not applicable", not a guess', () => {
    const r = row(
      buildLayerHealth(base({ precisionMm: null, precisionBasis: null })),
      'Mount precision',
    );
    expect(r.value).toBe('not applicable');
    expect(r.status).toBe('info');
  });
});

describe('buildLayerHealth — frame membership, origin and streaming', () => {
  it('a mounted layer says it participates; an unmounted one names its exclusion', () => {
    const yes = row(buildLayerHealth(base({ mounted: true })), 'Project frame');
    expect(yes.value).toContain('mounted');
    expect(yes.status).toBe('ok');
    const no = row(buildLayerHealth(base({ mounted: false })), 'Project frame');
    expect(no.value).toContain('not mounted');
    expect(no.value).toContain('excluded from combined results');
  });

  it('coordinates and offsets are numeric rows (mono), formatted plainly', () => {
    const rows = buildLayerHealth(base());
    const origin = row(rows, 'Source origin');
    expect(origin.value).toBe('512000, 4310000, 1500');
    expect(origin.mono).toBe(true);
    const offset = row(rows, 'Offset to project');
    expect(offset.value).toBe('+12, -7, +0.5');
    expect(offset.mono).toBe(true);
  });

  it('streaming is disclosed as partial residency, not a fault', () => {
    const on = row(buildLayerHealth(base({ streaming: true })), 'Loading');
    expect(on.value).toContain('streaming');
    expect(on.status).toBe('info');
    const off = row(buildLayerHealth(base({ streaming: false })), 'Loading');
    expect(off.value).toBe('fully loaded');
    expect(off.status).toBe('ok');
  });
});

describe('buildCompatibilityReport', () => {
  const L = (
    name: string,
    compatibility: LayerHealthInput['compatibility'],
    verticalDatumKnown = true,
  ) => ({ name, compatibility, verticalDatumKnown });

  it('an all-verified pair passes both axes and the verdict says both work', () => {
    const rep = buildCompatibilityReport([L('a.laz', 'verified'), L('b.laz', 'verified')]);
    expect(rep.lines.some((l) => l.text.startsWith('✓') && /horizontal/i.test(l.text))).toBe(true);
    expect(rep.lines.some((l) => l.text.startsWith('✓') && /vertical/i.test(l.text))).toBe(true);
    expect(rep.lines.every((l) => l.status === 'ok')).toBe(true);
    expect(rep.verdict).toMatch(/plan and height/);
  });

  it('a mixed set keeps plan and disables the vertical comparison', () => {
    const rep = buildCompatibilityReport([L('a.laz', 'verified'), L('b.laz', 'horizontal-only')]);
    expect(rep.lines.some((l) => l.text.startsWith('✓') && /horizontal/i.test(l.text))).toBe(true);
    const vertical = rep.lines.find((l) => /vertical comparison disabled/.test(l.text));
    expect(vertical?.status).toBe('warn');
    expect(rep.verdict).toContain('plan');
    expect(rep.verdict).not.toMatch(/plan and height/);
  });

  it('an unknown vertical datum is named as the reason vertical is off', () => {
    const rep = buildCompatibilityReport([
      L('a.laz', 'verified'),
      L('b.laz', 'horizontal-only', false),
    ]);
    expect(
      rep.lines.some((l) => l.text === '✗ Vertical datum unknown — vertical comparison disabled'),
    ).toBe(true);
  });

  it('an incompatible or undeclared layer is named in its own failing line', () => {
    const rep = buildCompatibilityReport([
      L('a.laz', 'verified'),
      L('rogue.ply', 'incompatible'),
      L('mystery.xyz', 'unknown'),
    ]);
    expect(rep.lines.some((l) => l.text.includes('rogue.ply') && l.status === 'warn')).toBe(true);
    expect(
      rep.lines.some((l) => l.text.includes('mystery.xyz') && /not established/.test(l.text)),
    ).toBe(true);
    expect(rep.verdict).toContain('exclude');
  });

  it('zero and one layer report that there is nothing to compare', () => {
    expect(buildCompatibilityReport([]).lines).toHaveLength(0);
    const one = buildCompatibilityReport([L('a.laz', 'verified')]);
    expect(one.lines).toHaveLength(0);
    expect(one.verdict).toMatch(/does not apply|No layers/);
  });

  it('verdicts are one sentence with no marketing claims', () => {
    const sets = [
      [L('a', 'verified'), L('b', 'verified')],
      [L('a', 'verified'), L('b', 'horizontal-only')],
      [L('a', 'verified'), L('b', 'unknown', false)],
      [L('a', 'incompatible'), L('b', 'incompatible')],
      [L('a', 'verified')],
      [],
    ];
    for (const set of sets) {
      const { verdict } = buildCompatibilityReport(set);
      // One sentence: a single terminal full stop, no sentence break inside.
      expect(verdict.trim().endsWith('.')).toBe(true);
      expect(verdict.trim().slice(0, -1)).not.toContain('. ');
    }
  });
});

describe('wording ban — no unearned quality claims anywhere', () => {
  it('every string either builder can produce avoids the banned claims', () => {
    const inputs: LayerHealthInput[] = [
      base(),
      base({
        crsName: null,
        crsSource: null,
        horizontalUnit: null,
        verticalUnit: null,
        verticalDatum: null,
        compatibility: null,
        mounted: false,
        sourceOrigin: null,
        frameOffset: null,
        precisionMm: null,
        precisionBasis: null,
        streaming: true,
      }),
      base({ compatibility: 'horizontal-only', precisionMm: 4.2 }),
      base({ compatibility: 'unknown', precisionBasis: 'geographic', precisionMm: null }),
      base({ compatibility: 'incompatible', precisionBasis: 'unknown', precisionMm: null }),
      base({ crsSource: 'user-override', streaming: true, mounted: false }),
    ];
    const strings: string[] = [];
    for (const input of inputs) {
      for (const r of buildLayerHealth(input)) strings.push(r.label, r.value);
    }
    const reports = [
      buildCompatibilityReport([]),
      buildCompatibilityReport([{ name: 'a', compatibility: 'verified', verticalDatumKnown: true }]),
      buildCompatibilityReport([
        { name: 'a', compatibility: 'verified', verticalDatumKnown: true },
        { name: 'b', compatibility: 'verified', verticalDatumKnown: true },
      ]),
      buildCompatibilityReport([
        { name: 'a', compatibility: 'verified', verticalDatumKnown: true },
        { name: 'b', compatibility: 'horizontal-only', verticalDatumKnown: false },
        { name: 'c', compatibility: 'incompatible', verticalDatumKnown: true },
        { name: 'd', compatibility: 'unknown', verticalDatumKnown: false },
      ]),
    ];
    for (const rep of reports) {
      strings.push(rep.verdict);
      for (const line of rep.lines) strings.push(line.text);
    }
    for (const s of strings) expect(s, `banned claim in: "${s}"`).not.toMatch(BANNED);
  });
});

describe('buildLayerHealth — the self-anchored single layer', () => {
  it('an identity placement (zero offset) spends no mount precision', () => {
    // The screenshot case: one layer anchors its own frame, offset +0,+0,+0.
    // "unknown — units not declared" is misleading — there is no mount to cost.
    const r = row(
      buildLayerHealth(base({ frameOffset: [0, 0, 0], precisionBasis: 'unknown', precisionMm: null })),
      'Mount precision',
    );
    expect(r.value).toMatch(/not applicable|no offset/i);
    expect(r.value).not.toMatch(/unknown/i);
  });

  it('a null placement (never in a shared frame) also spends nothing', () => {
    const r = row(
      buildLayerHealth(base({ frameOffset: null, precisionBasis: 'unknown', precisionMm: null })),
      'Mount precision',
    );
    expect(r.value).toMatch(/not applicable|no offset/i);
  });

  it('a REAL offset still reports its precision, unknown units and all', () => {
    const r = row(
      buildLayerHealth(base({ frameOffset: [100, 0, 0], precisionBasis: 'unknown', precisionMm: null })),
      'Mount precision',
    );
    expect(r.value).toMatch(/unknown — units not declared/i);
  });

  it('a sole verified layer is self-consistent by definition, not sharing a project frame', () => {
    const r = row(buildLayerHealth(base({ soleLayer: true })), 'Compatibility');
    expect(r.value).toMatch(/single layer|self-consistent|on its own/i);
    expect(r.value).not.toMatch(/shares the project/i);
  });

  it('a verified layer among others still states the shared reference', () => {
    const r = row(buildLayerHealth(base({ soleLayer: false })), 'Compatibility');
    expect(r.value).toMatch(/shares the project/i);
  });

  it('a sole layer is not described as eligible to combine with nothing', () => {
    const r = row(buildLayerHealth(base({ soleLayer: true })), 'Project frame');
    expect(r.value).not.toMatch(/eligible for combined/i);
    expect(r.value).toMatch(/single layer|only layer|nothing to combine|its own frame/i);
  });

  it('a mounted layer among others IS eligible for combined results', () => {
    const r = row(buildLayerHealth(base({ soleLayer: false, mounted: true })), 'Project frame');
    expect(r.value).toMatch(/eligible for combined/i);
  });

  it('every producible string still avoids quality claims', () => {
    for (const sole of [true, false]) {
      for (const off of [[0,0,0], null, [50,0,0]] as const) {
        const rows = buildLayerHealth(base({ soleLayer: sole, frameOffset: off }));
        for (const r of rows) expect(r.value).not.toMatch(BANNED);
      }
    }
  });
});
