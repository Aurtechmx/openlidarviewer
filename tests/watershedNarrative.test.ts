/**
 * watershedNarrative.test.ts: the plain-language summary of a catchment.
 * Sections are built by hand so each sentence can be read off.
 */
import { describe, expect, it } from 'vitest';
import { catchmentNarrative, headline, qualityReasons } from '../src/simulation/flowPulse/watershed/watershedNarrative';
import type { CatchmentSection } from '../src/simulation/flowPulse/watershed/watershedReportModel';

type Mutable = Record<string, unknown>;

function section(over: Mutable = {}): CatchmentSection {
  const base: Mutable = {
    label: 'C1', automatic: false, outlet: 0, mask: new Uint8Array(1),
    divide: { outer: [], holes: [], rawPerimeterM: 1100, perimeterM: 1046, enclosedHoleCells: 0, degenerate: false },
    morph: {
      areaM2: { value: 48_200 }, areaBandM2: 600, perimeterM: { value: 1046 },
      gravelius: { value: 1.2 }, formFactor: { value: 0.4 }, elongation: { value: 0.95 }, circularity: { value: 0.55 },
      basinLengthM: { value: 360 }, reliefM: { value: 18.6 }, meanElevationM: { value: 2056.9 },
      elevationsRelative: false, meanSlopePct: { value: 7.4 }, hypsometry: { withheld: 'not-applicable' },
    },
    channel: {
      cells: new Int32Array(3), lengthM: { value: 412 },
      profile: { distanceM: new Float64Array(0), elevationM: new Float64Array(0), interpolated: new Uint8Array(0) },
      slope1085: { value: 0.031 }, slopeTaylorSchwarz: { value: 0.029 }, reachSlopes: [], d8LengthBiasMax: 0.082,
    },
    network: { lengthM: 780, maxOrder: 3, byOrder: new Map() },
    depressions: [],
    checkOnSite: null,
    quality: {
      measuredShare: 0.95, channelInterpolatedShare: 0, longestFarInterpolatedRun: 0, touchesEnclosedHole: false,
      complete: true, groundPointsPerM2: 12, verdict: 'supported', reasons: [],
    },
    downstreamPathCells: new Int32Array(5),
    geometry: {
      highPoint: { dxM: 200, dyM: 200 },
      channelHead: { dxM: 150, dyM: 0, distFromDivideM: 60 },
      channelDropM: { value: 12.8 },
      downstream: { lengthM: 140, dxM: -50, dyM: -130 },
    },
  };
  return { ...base, ...over } as unknown as CatchmentSection;
}

const pond = (rank: number, areaM2: number, depth: number, onFlowLine: boolean, onMainChannel = false) => ({
  rank, cells: 10, areaM2, maxFillDepth: depth, outletElevation: 0, seedCell: 0, onMainChannel, onFlowLine,
});

function openSection(): CatchmentSection {
  const s = section() as unknown as Mutable;
  const open = { withheld: 'open-catchment' };
  return section({
    morph: { ...(s.morph as Mutable), areaM2: { value: 48_200, bound: 'minimum' }, gravelius: open, reliefM: { value: 18.6, bound: 'minimum' } },
    channel: { ...(s.channel as Mutable), lengthM: { value: 412, bound: 'minimum' }, slope1085: open, slopeTaylorSchwarz: open },
    geometry: { ...(s.geometry as Mutable), channelDropM: { value: 12.8, bound: 'minimum' } },
    quality: { ...(s.quality as Mutable), complete: false, verdict: 'limited', reasons: ['catchment-open'] },
  });
}

describe('catchmentNarrative', () => {
  it('tells the flow in order: starts, gathers, joins, leaves', () => {
    const p = catchmentNarrative(section(), 'en');
    expect(p.map((x) => x.lead)).toEqual(['narrative.lead.starts', 'narrative.lead.gathers', 'narrative.lead.joins', 'narrative.lead.leaves']);
    const text = p.map((x) => x.text).join(' ');
    expect(text).toContain('283\u00a0m north-east of the outlet');
    expect(text).toContain('60\u00a0m below the divide, 150\u00a0m east of the outlet');
    expect(text).toContain('carries the water west to the outlet');
    expect(text).toContain('runs 140\u00a0m south to the edge');
    // The step name is a label; no sentence opens by repeating it.
    for (const x of p) {
      const lead = x.lead.split('.').pop()!;
      expect(x.text.toLowerCase().startsWith(lead.toLowerCase()), x.text).toBe(false);
      expect(x.text.toLowerCase().startsWith(`it ${lead}`), x.text).toBe(false);
    }
  });

  it('does not restate the KPI or table figures', () => {
    const text = catchmentNarrative(section(), 'en').map((x) => x.text).join(' ');
    // relief 18.6 m, channel 412 m, slope 3.1 %, the fall, flow-line length and order
    for (const figure of ['18.6', '412', '3.1', '12.8', 'Strahler', 'minute']) expect(text, figure).not.toContain(figure);
  });

  it('writes the ponds sentence only when the catchment has depressions', () => {
    expect(catchmentNarrative(section(), 'en').some((x) => x.lead === 'narrative.lead.ponds')).toBe(false);
    const wet = catchmentNarrative(section({ depressions: [pond(1, 310, 0.4, true), pond(2, 85, 0.2, false)] }), 'en');
    const ponds = wet.find((x) => x.lead === 'narrative.lead.ponds');
    expect(ponds?.text).toContain('2 hollows');
    expect(ponds?.text).not.toContain('310');
    expect(wet.map((x) => x.lead).indexOf('narrative.lead.ponds')).toBe(3);
  });

  it('says an open divide is shown in part and adds no separate open paragraph', () => {
    const p = catchmentNarrative(openSection(), 'en');
    expect(p.some((x) => x.lead === 'narrative.lead.leaves')).toBe(true);
    expect(p[0].text).toContain('only in part');
    expect(p.map((x) => x.text).join(' ')).not.toMatch(/minute|at least/);
  });

  it('does not say no flow line forms when a flow line cell of zero length lies inside', () => {
    const s = section() as unknown as Mutable;
    const edge = section({ network: { ...(s.network as Mutable), maxOrder: 2, lengthM: 0 }, geometry: { ...(s.geometry as Mutable), channelHead: null } });
    const text = catchmentNarrative(edge, 'en', 2500).map((x) => x.text).join(' ');
    expect(text).not.toMatch(/No flow line forms/);
  });

  it('describes hollows as features of the surface model, not as ponding', () => {
    for (const lang of ['en', 'es'] as const) {
      const one = catchmentNarrative(section({ depressions: [pond(1, 310, 0.4, true, true)] }), lang);
      const many = catchmentNarrative(section({ depressions: [pond(1, 310, 0.4, true), pond(2, 85, 0.2, true), pond(3, 9, 0.1, false)] }), lang);
      const text = [...one, ...many].map((x) => x.text).join(' ');
      expect(text).not.toMatch(/pond|hold water|holds water|water stops|retiene|encharca|se detiene/i);
    }
  });

  it('names the threshold when no flow line forms', () => {
    const s = section() as unknown as Mutable;
    const dry = section({ network: { ...(s.network as Mutable), maxOrder: 0, lengthM: 0 } });
    const p = catchmentNarrative(dry, 'en', 2500);
    expect(p.map((x) => x.lead)).not.toContain('narrative.lead.joins');
    expect(p[1].text).toBe('No flow line forms inside this catchment at the 2,500\u00a0m² threshold.');
    expect(p.map((x) => x.text).join(' ')).not.toMatch(/sheet|lámina/);
  });

  it('uses SCT vocabulary in Spanish', () => {
    const text = catchmentNarrative(section(), 'es').map((x) => x.text).join(' ');
    expect(text).toContain('parteaguas');
    expect(text).toContain('cauce principal');
    expect(text).toContain('al noreste de la salida');
    expect(text).toContain('recorre 140\u00a0m hacia el sur');
  });
});

describe('headline', () => {
  it('names shape, drainage and area', () => {
    expect(headline(section(), 'en')).toBe('A near-circular catchment of 4.82\u00a0ha drained by a branching network of stream order 3');
    expect(headline(section(), 'es')).toBe('Una cuenca casi circular de 4,82\u00a0ha drenada por una red ramificada de orden 3');
  });
  it('takes the shape word from the elongation ratio Re alone', () => {
    const s = section() as unknown as Mutable;
    // Kc says "not compact" but Re 0.99 reads near-circular: Re decides.
    const c = section({ morph: { ...(s.morph as Mutable), gravelius: { value: 1.29 }, elongation: { value: 0.99 } } });
    expect(headline(c, 'en')).toMatch(/^A near-circular/);
    const h = section({ morph: { ...(s.morph as Mutable), gravelius: { value: 1.0 }, elongation: { value: 0.6 } }, network: { lengthM: 1, maxOrder: 2, byOrder: new Map() } });
    expect(headline(h, 'en')).toBe('An elongated catchment of 4.82\u00a0ha drained by one branching channel');
    expect(headline(h, 'es')).toBe('Una cuenca alargada de 4,82\u00a0ha drenada por un cauce ramificado');
    const m = section({ morph: { ...(s.morph as Mutable), elongation: { value: 0.8 } }, network: { lengthM: 1, maxOrder: 1, byOrder: new Map() } });
    expect(headline(m, 'en')).toBe('An oval catchment of 4.82\u00a0ha drained by a single line');
  });
  it('omits a withheld shape word and opens with "at least" for an open catchment', () => {
    const s = section() as unknown as Mutable;
    const w = section({ morph: { ...(s.morph as Mutable), elongation: { withheld: 'too-small' } } });
    expect(headline(w, 'en')).toBe('A catchment of 4.82\u00a0ha drained by a branching network of stream order 3');
    expect(headline(openSection(), 'en')).toBe('An open catchment of at least 4.82\u00a0ha');
    expect(headline(openSection(), 'es')).toBe('Una cuenca abierta de al menos 4,82\u00a0ha');
  });
});

describe('quality and range wording', () => {
  it('words every quality reason the grade can give, with its threshold as a figure', () => {
    const q = section().quality as unknown as Mutable;
    const all = ['measured-share-below-0.90', 'channel-interpolated-over-0.10', 'channel-far-interpolated-run', 'channel-touches-hole', 'catchment-open'];
    const es = qualityReasons({ ...q, reasons: all } as never, 'es');
    expect(es).toHaveLength(5);
    expect(es[0]).toContain('90\u00a0%');
    expect(es[1]).toContain('10\u00a0%');
    expect(es[2]).toContain('5');
    expect(qualityReasons({ ...q, reasons: [] } as never, 'en')).toHaveLength(1);
  });
});

describe('headline without an area', () => {
  it('leaves a withheld area out instead of printing zero', () => {
    const s = section() as unknown as Mutable;
    const m = s.morph as Mutable;
    expect(headline(section({ morph: { ...m, areaM2: { withheld: 'too-small' } } }), 'en')).toBe('A near-circular catchment drained by a branching network of stream order 3');
    const open = section({ morph: { ...m, areaM2: { withheld: 'open-catchment' } }, quality: { ...(s.quality as Mutable), complete: false } });
    expect(headline(open, 'en')).toBe('An open catchment');
    expect(headline(open, 'es')).toBe('Una cuenca abierta');
  });
});
