/**
 * profilePdf.test.ts — the PDF export must actually produce bytes for
 * real profiles, including names with characters outside WinAnsi (the
 * pdf-lib StandardFont encoding) which would otherwise throw.
 */

import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { buildProfilePdf } from '../src/render/measure/profilePdf';
import {
  computeProfileSummary,
  profileSummaryRows,
  scaleProfileSamples,
} from '../src/render/measure/profileSummary';
import type { ProfileChartSample } from '../src/render/measure/types';

function ramp(n: number): ProfileChartSample[] {
  const out: ProfileChartSample[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ distance: i * 2, height: 100 + Math.sin(i / 4) * 3 });
  }
  return out;
}

const PDF_MAGIC = '%PDF-';
// Injected, fixed generation date. `buildProfilePdf` defaults `generatedAt` to
// `new Date()`, which puts a moving timestamp in the page content stream.
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

describe('buildProfilePdf', () => {
  it('produces a non-empty PDF for a normal profile', async () => {
    const bytes = await buildProfilePdf({ name: 'Profile 1', samples: ramp(64) });
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe(PDF_MAGIC);
  });

  it('does not throw on names with non-WinAnsi characters', async () => {
    // Emoji + Greek + CJK in a renamed measurement must not crash the
    // StandardFont encoder.
    const bytes = await buildProfilePdf({ name: 'Survey Δ 测量 🚧 §1', samples: ramp(8) });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe(PDF_MAGIC);
  });

  it('handles a profile with gaps (NaN heights) without throwing', async () => {
    const s = ramp(10);
    s[3] = { distance: 6, height: NaN };
    s[4] = { distance: 8, height: NaN };
    const bytes = await buildProfilePdf({ name: 'Gappy', samples: s, residentOnly: true });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe(PDF_MAGIC);
  });

  it('handles an all-gap profile (nothing to plot)', async () => {
    const bytes = await buildProfilePdf({
      name: 'Empty',
      samples: [
        { distance: 0, height: NaN },
        { distance: 10, height: NaN },
      ],
    });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe(PDF_MAGIC);
  });
});

/**
 * Recover the drawn text from the PDF bytes. pdf-lib Flate-compresses page
 * content streams and encodes every string drawn with a standard font as a
 * hex string (`<48656C6C6F> Tj`), so a plain byte-grep can never see the
 * words — inflate each stream, then hex-decode the string tokens back to
 * WinAnsi/latin1. Good enough to assert "this label made it onto the page";
 * NOT a layout check.
 */
function drawnPdfText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  let idx = 0;
  let streams = '';
  for (;;) {
    const s = buf.indexOf('stream', idx);
    if (s === -1) break;
    let ds = s + 'stream'.length;
    if (buf[ds] === 0x0d) ds++;
    if (buf[ds] === 0x0a) ds++;
    const e = buf.indexOf('endstream', ds);
    if (e === -1) break;
    try {
      streams += inflateSync(buf.subarray(ds, e)).toString('latin1');
    } catch {
      streams += buf.subarray(ds, e).toString('latin1'); // uncompressed stream
    }
    idx = e + 'endstream'.length;
  }
  return streams.replace(/<([0-9A-Fa-f]+)>/g, (_, hex: string) =>
    Buffer.from(hex, 'hex').toString('latin1'),
  );
}

describe('provenance metadata (v0.4.5, B4)', () => {
  it('prints CRS / corridor / percentile when supplied instead of the defaults', async () => {
    const bytes = await buildProfilePdf({
      name: 'Levee section A',
      samples: ramp(16),
      corridorWidthM: 12.5,
      groundPercentile: 25,
      crs: 'EPSG:2225 - NAD83 / California zone 1 (ftUS)',
      verticalDatum: 'NAVD88',
    });
    const text = drawnPdfText(bytes);
    expect(text).toContain('EPSG:2225'); // header line + summary row
    expect(text).toContain('NAVD88');
    expect(text).toContain('12.500 m'); // the real corridor, not "auto" (5 sig figs)
    expect(text).toContain('p25 of corridor'); // header provenance line
    expect(text).not.toContain('auto (5% of length)');
    expect(text).not.toContain('not georeferenced');
  });

  /**
   * The sampler reduces each corridor bin to a percentile of the returns that
   * survived the class gate. That gate drops NON_GROUND_CLASSES
   * ([3, 4, 5, 6, 7, 18]) and only when an index-aligned classification
   * channel exists; classes 0, 1, 2, 9 and the 255 "no class channel"
   * sentinel all reach the percentile. The sheet therefore states the
   * estimator and the class gate, and never calls p25 a bare-earth surface.
   */
  it('states the percentile estimator and the class gate without claiming bare earth', async () => {
    const bytes = await buildProfilePdf({
      name: 'Levee section A',
      samples: ramp(16),
      groundPercentile: 25,
      generatedAt: FIXED_DATE,
    });
    const text = drawnPdfText(bytes);
    expect(text).toContain('p25 of corridor returns');
    expect(text).toContain('Non-ground classes');
    expect(text).toContain('Excluded where a source classifies');
    expect(text).not.toContain('bare-earth');
    expect(text).not.toContain('bare earth');
    expect(text).not.toContain('ground p25');
  });

  it('keeps the honest fallbacks when nothing is known', async () => {
    const bytes = await buildProfilePdf({ name: 'Local scan', samples: ramp(8) });
    const text = drawnPdfText(bytes);
    expect(text).toContain('auto (5% of length)');
    expect(text).toContain('not georeferenced');
  });
});

/**
 * PDF path operators, one per line: `x y m` moveto, `x y l` lineto,
 * `x1 y1 x2 y2 x3 y3 c` curveto. pdf-lib's `drawSvgPath` emits `c` for every
 * cubic segment of an SVG path, so counting them measures the drawn geometry.
 */
const MOVE_OP = /^\s*-?[\d.]+ -?[\d.]+ m\s*$/;
const LINE_OP = /^\s*-?[\d.]+ -?[\d.]+ l\s*$/;
const CURVE_OP = /^\s*-?[\d.]+ -?[\d.]+ -?[\d.]+ -?[\d.]+ -?[\d.]+ -?[\d.]+ c\s*$/;

describe('profile geometry — the sheet draws only what the samples say', () => {
  /**
   * The four-sample plateau. A uniform Catmull-Rom spline through these
   * stations peaks at 1.1275 between the two that both read exactly 1, so the
   * sheet must not contain a cubic segment at all.
   */
  const plateau: ProfileChartSample[] = [0, 1, 1, 0].map((height, i) => ({
    distance: i * 10,
    height,
    count: 8,
  }));

  it('emits no curve operator, and draws the profile as one connected polyline', async () => {
    const bytes = await buildProfilePdf({
      name: 'Plateau',
      samples: plateau,
      generatedAt: FIXED_DATE,
    });
    const lines = drawnPdfText(bytes).split('\n');
    expect(lines.filter((l) => CURVE_OP.test(l))).toHaveLength(0);
    // Longest run of consecutive linetos after a moveto: the grid draws
    // moveto/lineto pairs, the profile draws one moveto and three linetos.
    let longest = 0;
    let run = 0;
    for (const l of lines) {
      if (LINE_OP.test(l)) run++;
      else if (MOVE_OP.test(l)) run = 0;
      if (run > longest) longest = run;
    }
    expect(longest).toBe(plateau.length - 1);
  });

  it('breaks the drawn line at a coverage gap', async () => {
    // Three samples each side of the gap: a spline renderer would emit curve
    // operators here, and a renderer that bridged the gap would emit a single
    // run of four linetos.
    const gapped: ProfileChartSample[] = [
      { distance: 0, height: 1, count: 4 },
      { distance: 10, height: 2, count: 4 },
      { distance: 20, height: 3, count: 4 },
      { distance: 30, height: Number.NaN, count: 0 },
      { distance: 40, height: 3, count: 4 },
      { distance: 50, height: 2, count: 4 },
      { distance: 60, height: 1, count: 4 },
    ];
    const bytes = await buildProfilePdf({
      name: 'Gapped',
      samples: gapped,
      generatedAt: FIXED_DATE,
    });
    const lines = drawnPdfText(bytes).split('\n');
    expect(lines.filter((l) => CURVE_OP.test(l))).toHaveLength(0);
    // Two runs of two linetos each, never a single run that bridges the gap.
    let longest = 0;
    let run = 0;
    for (const l of lines) {
      if (LINE_OP.test(l)) run++;
      else if (MOVE_OP.test(l)) run = 0;
      if (run > longest) longest = run;
    }
    expect(longest).toBe(2);
  });
});

describe('unit system (v0.4.5, B9) — the sheet honours the active toggle end-to-end', () => {
  it('imperial: axes, summary and station table all print feet / 100-ft stations', async () => {
    const bytes = await buildProfilePdf({
      name: 'Imperial section',
      samples: ramp(16),
      corridorWidthM: 12.5,
      unitSystem: 'imperial',
    });
    const text = drawnPdfText(bytes);
    // Chart axes.
    expect(text).toContain('Elevation (ft)');
    expect(text).toContain('Chainage (100 ft stations)');
    // Chainage gridline labels use US 100-ft stationing: the ramp spans
    // 30 m = 98.43 ft → nice interval 10 ft → second gridline at "0+10.00".
    expect(text).toContain('0+10.00');
    // Summary: length 30 m = 98.4252 ft → "98.425 ft" via formatLength (5 sig
    // figs); the corridor 12.5 m = 41.0105 ft → "41.010 ft".
    expect(text).toContain('98.425 ft');
    expect(text).toContain('41.010 ft');
    // Station table: header names the unit; elevations convert per station
    // (station 0 sits at exactly 100 m = 328.0840 ft → "328.08").
    expect(text).toContain('elevation (ft)');
    expect(text).toContain('328.08');
  });

  it('metric stays the default sheet when no unit system is passed', async () => {
    const bytes = await buildProfilePdf({ name: 'Metric section', samples: ramp(16) });
    const text = drawnPdfText(bytes);
    expect(text).toContain('Elevation (m)');
    expect(text).toContain('Chainage (station km+m)');
    expect(text).toContain('elevation (m)');
    expect(text).not.toContain('Elevation (ft)');
  });
});

describe('the sheet prints the same source elevations as the panel', () => {
  it('the extremes row matches profileSummaryRows verbatim', async () => {
    // Regression fixture from a real streaming COPC case: heights stored render-local against an
    // octree-cube origin 830.03 m up the Z axis. Both surfaces are fed from
    // the datum seam, exactly as the controller feeds them, and both are
    // asked for the same row model — so a reviewer checking the sheet against
    // the screen can never find two answers.
    const samples = scaleProfileSamples(
      [
        { distance: 0, height: -481.103, count: 12 },
        { distance: 171.99, height: -449.53, count: 4 },
        { distance: 343.98, height: -411.865, count: 9 },
      ],
      1,
      830.03,
    );
    const text = drawnPdfText(await buildProfilePdf({ name: 'Datum section', samples }));
    const byLabel = new Map(
      profileSummaryRows(computeProfileSummary(samples), 'metric').map((r) => [r.label, r.value]),
    );
    expect(byLabel.get('Highest point')).toBe('418.16 m @ 0+343.98');
    expect(text).toContain(byLabel.get('Highest point'));
    expect(text).toContain(byLabel.get('Lowest point'));
    // The elevations that reach the sheet are the header's, not the render
    // origin's — and never the centimetres a length formatter made of them.
    expect(text).toContain('348.93 m');
    expect(text).not.toContain('41186.5');
  });
});

describe('the sheet refuses a datum it cannot assert', () => {
  it('prints local heights and names the reason in the Vertical datum row', async () => {
    // Local heights from a scene whose clouds hold conflicting origins.
    const samples: ProfileChartSample[] = [
      { distance: 0, height: -481.103, count: 12 },
      { distance: 171.99, height: -449.53, count: 4 },
      { distance: 343.98, height: -411.865, count: 9 },
    ];
    const text = drawnPdfText(
      await buildProfilePdf({ name: 'Unresolved datum', samples, datumKnown: false }),
    );
    // Nothing on the sheet may call these elevations.
    expect(text).toContain('Local height (m)');
    expect(text).toContain('Min / Max local height');
    expect(text).not.toContain('Elevation (m)');
    // The sheet's existing datum row is where a reader looks for exactly this.
    expect(text).toContain('conflicting cloud origins');
    // And it agrees with the panel, refusal or not.
    const byLabel = new Map(
      profileSummaryRows(computeProfileSummary(samples), 'metric', false).map((r) => [
        r.label,
        r.value,
      ]),
    );
    expect(text).toContain(byLabel.get('Highest point (local height)'));
  });

  it('a resolvable datum leaves the sheet exactly as it was', async () => {
    const text = drawnPdfText(await buildProfilePdf({ name: 'Metric section', samples: ramp(16) }));
    expect(text).toContain('Elevation (m)');
    expect(text).not.toContain('Local height (m)');
  });
});
