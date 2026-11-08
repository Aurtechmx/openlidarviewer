/**
 * profilePdfPrecision.test.ts
 *
 * The longitudinal profile sheet as a scaled drawing: standard scales that are
 * exactly what is drawn, a height axis that contains every plotted value, a
 * station band on round chainages, and the export carrying the facts the
 * workbench shows (sources read, picked-endpoint rise, resident points).
 */
import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { buildProfilePdf } from '../src/render/measure/profilePdf';
import {
  buildRoundChainageBand,
  chooseProfileScales,
  interpolateStationHeight,
  standardScaleAtLeast,
  steepestGradeOverBase,
  STANDARD_EXAGGERATIONS,
  STANDARD_SCALE_DENOMINATORS,
} from '../src/render/measure/profileSheetLayout';
import { describeSampleNote } from '../src/render/measure/profileProvenance';
import { createProfileSectionSeam, STREAMING_SOURCE_ID } from '../src/render/measure/profileSectionSeam';
import { buildProfileProvenance } from '../src/render/measure/profileProvenance';
import type { ProfileChartSample } from '../src/render/measure/types';

const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');
const PT_PER_M = 72 / 0.0254;

/** 364.51 m, 64 stations, 333.98-338.54 m, minimum at station 11 (0+063.64). */
function realLikeSection(): ProfileChartSample[] {
  const n = 64;
  const len = 364.51;
  const out: ProfileChartSample[] = [];
  for (let i = 0; i < n; i++) {
    const d = (i * len) / (n - 1);
    let h = 334.13 + (i / (n - 1)) * 1.52 + Math.sin(i / 6) * 1.6 + 0.9;
    if (i === 11) h = 333.98;
    if (i === 40) h = 338.54;
    out.push({ distance: d, height: h });
  }
  return out;
}

function streamsOf(bytes: Uint8Array): string[] {
  const buf = Buffer.from(bytes);
  const out: string[] = [];
  let idx = 0;
  for (;;) {
    const s = buf.indexOf('stream', idx);
    if (s === -1) break;
    let ds = s + 'stream'.length;
    if (buf[ds] === 0x0d) ds++;
    if (buf[ds] === 0x0a) ds++;
    const e = buf.indexOf('endstream', ds);
    if (e === -1) break;
    try {
      out.push(inflateSync(buf.subarray(ds, e)).toString('latin1'));
    } catch {
      out.push(buf.subarray(ds, e).toString('latin1'));
    }
    idx = e + 'endstream'.length;
  }
  return out;
}

const DRAW_RE =
  /\/([A-Za-z-]+)-\d+ ([\d.]+) Tf[\s\S]{0,40}?1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\s*<([0-9A-Fa-f]+)> Tj/g;

function drawnOn(bytes: Uint8Array): Array<{ base: string; size: number; x: number; y: number; text: string }> {
  return streamsOf(bytes).flatMap((st) =>
    [...st.matchAll(DRAW_RE)].map((m) => ({
      base: m[1],
      size: Number(m[2]),
      x: Number(m[3]),
      y: Number(m[4]),
      text: Buffer.from(m[5], 'hex').toString('latin1'),
    })),
  );
}

describe('standard scales', () => {
  it('snaps the horizontal scale up to a standard denominator', () => {
    expect(standardScaleAtLeast(1054)).toBe(1250);
    expect(standardScaleAtLeast(2501)).toBe(5000);
    expect(standardScaleAtLeast(5001)).toBe(10000);
    expect(standardScaleAtLeast(40)).toBe(100);
  });

  it('chooses the largest standard exaggeration that fits, never a fitted one', () => {
    const s = chooseProfileScales({ lengthM: 364.51, minM: 333.98, maxM: 338.54, plotWpt: 960, plotHpt: 300, k: 1 });
    expect(STANDARD_SCALE_DENOMINATORS as readonly number[]).toContain(s.horizontal);
    expect(STANDARD_EXAGGERATIONS as readonly number[]).toContain(s.exaggeration);
    expect(s.vertical).toBeCloseTo(s.horizontal / s.exaggeration, 9);
    // The next standard ratio up would not fit the axis range in the plot.
    const i = (STANDARD_EXAGGERATIONS as readonly number[]).indexOf(s.exaggeration);
    if (i > 0) {
      const bigger = STANDARD_EXAGGERATIONS[i - 1];
      const t = s.tickStep;
      const range = Math.ceil((338.54 + t / 4) / t) * t - Math.floor((333.98 - t / 4) / t) * t;
      const neededPt = (range / (s.horizontal / bigger)) * PT_PER_M;
      expect(neededPt).toBeGreaterThan(300);
    }
    expect(s.drawnWpt).toBeLessThanOrEqual(960);
  });

  it('keeps every plotted value inside the height axis, with margin', () => {
    const s = chooseProfileScales({ lengthM: 364.51, minM: 333.98, maxM: 338.54, plotWpt: 960, plotHpt: 300, k: 1 });
    expect(s.axisLoM).toBeLessThan(333.98);
    expect(s.axisHiM).toBeGreaterThan(338.54);
    expect(333.98 - s.axisLoM).toBeGreaterThanOrEqual(s.tickStep / 4 - 1e-9);
    // The axis starts on a round tick.
    expect(Math.abs(s.firstTick / s.tickStep - Math.round(s.firstTick / s.tickStep))).toBeLessThan(1e-9);
    // And spans exactly the plot height at the stated vertical scale.
    expect(((s.axisHiM - s.axisLoM) / s.vertical) * PT_PER_M).toBeCloseTo(300, 6);
  });

  it('uses a requested standard exaggeration when it fits, and ignores a non-standard one', () => {
    const base = { lengthM: 364.51, minM: 333.98, maxM: 338.54, plotWpt: 960, plotHpt: 300, k: 1 };
    expect(chooseProfileScales({ ...base, requestedExaggeration: 1 }).exaggeration).toBe(1);
    expect(chooseProfileScales({ ...base, requestedExaggeration: 5 }).exaggeration).toBe(5);
    const odd = chooseProfileScales({ ...base, requestedExaggeration: 26.3 });
    expect(STANDARD_EXAGGERATIONS as readonly number[]).toContain(odd.exaggeration);
  });

  it('states a compression on standard scales when relief does not fit at 1:1', () => {
    const s = chooseProfileScales({ lengthM: 50, minM: 0, maxM: 400, plotWpt: 960, plotHpt: 300, k: 1 });
    expect(s.exaggeration).toBeLessThan(1);
    expect(s.axisHiM).toBeGreaterThan(400);
    expect(s.axisLoM).toBeLessThan(0);
  });
});

describe('profile sheet: the printed scale is the drawn scale', () => {
  it('prints standard ratios and draws the chainage and heights at them', async () => {
    const samples = realLikeSection();
    const bytes = await buildProfilePdf({ name: 'Scale', samples, generatedAt: FIXED_DATE });
    const drawn = drawnOn(bytes);
    const line = drawn.find((d) => d.text.startsWith('Horizontal 1:'))!;
    const m = /Horizontal 1:([\d.]+).+Vertical 1:([\d.]+).+Vertical exaggeration ([\d.]+):1/.exec(line.text)!;
    expect(m).not.toBeNull();
    const h = Number(m[1]);
    const v = Number(m[2]);
    expect(STANDARD_SCALE_DENOMINATORS as readonly number[]).toContain(h);
    expect(STANDARD_EXAGGERATIONS as readonly number[]).toContain(Number(m[3]));
    expect(line.text).not.toContain('26.3');

    // Horizontal: the band's 0+000 and end columns are len/h of paper apart.
    const mono = drawn.filter((d) => d.base === 'Courier');
    const start = mono.find((d) => d.text === '0+000.00')!;
    const end = mono.find((d) => d.text === '0+364.51')!;
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    // The end figures are set 2 pt inward from the frame edges: the first
    // starts at its edge, the last ends at its edge. Courier is 0.6 em a glyph.
    const endW = end.text.length * 0.6 * end.size;
    expect(end.x + endW + 2 - (start.x - 2)).toBeCloseTo((364.51 / h) * PT_PER_M, 1);

    // Vertical: two adjacent height ticks are one step of ground at 1:v apart.
    const ticks = mono
      .filter((d) => /^\d{3}\.\d$/.test(d.text))
      .map((d) => ({ value: Number(d.text), y: d.y }))
      .sort((a, b) => a.value - b.value);
    expect(ticks.length).toBeGreaterThan(2);
    const step = ticks[1].value - ticks[0].value;
    expect(ticks[1].y - ticks[0].y).toBeCloseTo((step / v) * PT_PER_M, 1);
    // The lowest tick is below the lowest sample, the highest above the highest.
    expect(ticks[0].value).toBeLessThan(333.98);
    expect(ticks[ticks.length - 1].value + step).toBeGreaterThan(338.54);
  });
});

describe('round-chainage station band', () => {
  const stations = [0, 5.79, 11.58, 17.37, 23.16, 28.95].map((c, i) => ({
    chainage: c,
    height: i === 3 ? null : 100 + i,
  }));

  it('interpolates between neighbouring sampled stations', () => {
    expect(interpolateStationHeight(stations, 0)).toBe(100);
    expect(interpolateStationHeight(stations, 5.79)).toBe(101);
    expect(interpolateStationHeight(stations, 10)).toBeCloseTo(101 + (10 - 5.79) / 5.79, 9);
  });

  it('never interpolates across a gap station', () => {
    expect(interpolateStationHeight(stations, 15)).toBeNull();
    expect(interpolateStationHeight(stations, 20)).toBeNull();
    expect(interpolateStationHeight(stations, 17.37)).toBeNull();
    expect(interpolateStationHeight(stations, 40)).toBeNull();
  });

  it('places stations at a round interval, including 0 and the end', () => {
    const band = buildRoundChainageBand({
      stations,
      lengthM: 28.95,
      k: 1,
      mapX: (c) => 100 + c * 20,
      columnWpt: 60,
    });
    expect(band.interval).toBe(5);
    const ch = band.columns.map((c) => c.chainage);
    expect(ch[0]).toBe(0);
    expect(ch[ch.length - 1]).toBe(28.95);
    expect(ch.slice(1, -1).every((c) => Math.abs(c % 5) < 1e-9)).toBe(true);
    // The partial row reads the interval; the last partial is the remainder.
    expect(band.columns[1].partial).toBeCloseTo(5, 9);
    expect(band.columns.find((c) => c.chainage === 20)!.height).toBeNull();
    expect(band.total).toBe(6);
  });

  it('widens the interval until the columns no longer touch', () => {
    const band = buildRoundChainageBand({
      stations,
      lengthM: 28.95,
      k: 1,
      mapX: (c) => 100 + c * 5,
      columnWpt: 60,
    });
    expect(band.interval).toBe(20);
    for (let i = 1; i < band.columns.length; i++) {
      expect(band.columns[i].x - band.columns[i - 1].x).toBeGreaterThanOrEqual(60);
    }
  });

  it('prints the dash at a gap and states the basis on the sheet', async () => {
    const gapped: ProfileChartSample[] = [];
    for (let i = 0; i <= 12; i++) gapped.push({ distance: i * 10, height: i === 4 || i === 5 ? Number.NaN : 100 + i });
    const bytes = await buildProfilePdf({ name: 'Gap', samples: gapped, generatedAt: FIXED_DATE });
    const text = drawnOn(bytes).map((d) => d.text).join(' | ');
    expect(text).toContain('at round chainages interpolated between the 13 sampled stations');
    expect(text).not.toContain('thinned to fit');
  });
});

describe('steepest grade over a minimum base', () => {
  it('measures over the nearest station pair reaching the base, skipping gaps', () => {
    const st = [0, 5, 10, 15, 20, 25].map((c, i) => ({ chainage: c, height: [0, 2, 2.2, null, 0, 0][i] as number | null }));
    const g = steepestGradeOverBase(st, 10)!;
    expect(g.fromChainage).toBe(0);
    expect(g.toChainage).toBe(10);
    expect(g.grade).toBeCloseTo(0.22, 9);
  });

  it('is printed with its base on the technical notes, beside the station-pair figure', async () => {
    const bytes = await buildProfilePdf({ name: 'Base', samples: realLikeSection(), generatedAt: FIXED_DATE });
    const text = drawnOn(bytes).map((d) => d.text).join(' | ');
    expect(text).toContain('Max grade over 10.00 m or more');
    expect(text).toContain('Max grade (ratio, angle)');
  });
});

describe('export carries the workbench facts', () => {
  it('prints the picked-endpoint rise as its own row', async () => {
    const bytes = await buildProfilePdf({ name: 'Rise', samples: realLikeSection(), generatedAt: FIXED_DATE, pickedRiseM: 1.61 });
    const text = drawnOn(bytes).map((d) => d.text).join(' | ');
    expect(text).toContain('Picked endpoints rise');
    expect(text).toContain('+1.61 m');
  });

  it('says a streaming read counts resident points, not the file', () => {
    const note = describeSampleNote({ sourcePoints: 2449985, analysedPoints: 2449985, withheldExcluded: 0 }, undefined, 'm', true);
    expect(note).toContain('2,449,985 of 2,449,985 resident points analysed (streaming source; not the full file)');
    const whole = describeSampleNote({ sourcePoints: 9, analysedPoints: 9, withheldExcluded: 0 }, undefined, 'm', false);
    expect(whole).not.toContain('resident');
  });

  it('the series reports its sources, so a provenance record can be built from it', () => {
    const seam = createProfileSectionSeam({
      layers: () => [
        {
          id: 'cloud-a',
          mesh: { visible: true },
          positions: new Float32Array([2, 0, 5, 4, 0, 6, 50, 50, 0]),
          channels: { classification: new Uint8Array([2, 2, 2]) },
          bounds: null,
          placement: null,
        },
      ],
      residentNodes: () => [{ key: '0-0-0-0', positions: new Float32Array([6, 0, 5]), channels: null }],
      streamingMayCombine: () => true,
      worldUp: () => [0, 0, 1],
      streamingCoverage: () => null,
    });
    const series = seam.sampleSeries([0, 0, 0], [10, 0, 0], { corridorWidth: 1 })!;
    expect(series.provenanceInput).toBeDefined();
    const record = buildProfileProvenance({ ...series.provenanceInput!, capturedAt: '2026-01-01T00:00:00Z' });
    const a = record.sources.find((s) => s.layerId === 'cloud-a')!;
    expect(a.acceptedCount).toBe(2);
    expect(a.classification).toBe('producer');
    const stream = record.sources.find((s) => s.layerId === STREAMING_SOURCE_ID)!;
    expect(stream.streaming).toBe(true);
    expect(stream.acceptedCount).toBe(1);
    expect(stream.classification).toBe('absent');
    expect(record.classPolicy.availableOnEverySource).toBe(false);
  });
});
