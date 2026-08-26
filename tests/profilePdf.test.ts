/**
 * profilePdf.test.ts — the PDF export must actually produce bytes for
 * real profiles, including names with characters outside WinAnsi (the
 * pdf-lib StandardFont encoding) which would otherwise throw.
 *
 * It must also print the SAME words the app prints on screen: the derived
 * series as `profileDerivedLegend` names it, the sources / class policy /
 * read scope from the `ProfileProvenance` record, and every height heading
 * from `heightLabel`.
 */

import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { buildProfilePdf } from '../src/render/measure/profilePdf';
import {
  computeProfileSummary,
  profileSummaryRows,
  scaleProfileSamples,
} from '../src/render/measure/profileSummary';
import {
  buildDerivedSurfaceLegend,
  type DerivedSurfaceSource,
} from '../src/render/measure/profileDerivedLegend';
import {
  buildProfileProvenance,
  describeProfileProvenance,
  type ProfileClassificationKind,
  type ProfileProvenance,
} from '../src/render/measure/profileProvenance';
import { NON_GROUND_CLASSES } from '../src/terrain/ground/classificationFilter';
import { heightLabel } from '../src/geo/height';
import type { VerticalReference } from '../src/geo/height';
import type { ProfileChartSample } from '../src/render/measure/types';

function ramp(n: number): ProfileChartSample[] {
  const out: ProfileChartSample[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ distance: i * 2, height: 100 + Math.sin(i / 4) * 3 });
  }
  return out;
}

const PDF_MAGIC = '%PDF-';
// Injected, fixed generation date. `buildProfilePdf` REQUIRES `generatedAt`
// and never reads the clock, so the same input is always the same bytes.
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

/** A provenance record, built through the real builder so it cannot drift. */
function provenanceOf(
  sources: ReadonlyArray<{
    layerId: string;
    displayName: string;
    classification: ProfileClassificationKind;
    streaming?: boolean;
  }>,
  acceptedSlots: readonly number[],
  verticalReference: VerticalReference = 'orthometric',
): ProfileProvenance {
  return buildProfileProvenance({
    capturedAt: '2026-01-01T00:00:00.000Z',
    up: [0, 0, 1],
    sources: sources.map((s, i) => ({
      slot: i,
      layerId: s.layerId,
      displayName: s.displayName,
      classification: s.classification,
      streaming: s.streaming === true,
    })),
    accepted: { count: acceptedSlots.length, sourceSlot: acceptedSlots },
    excludedClasses: NON_GROUND_CLASSES,
    units: { linearUnit: 'metre', verticalReference, verticalMetresPerUnit: 1 },
  });
}

describe('buildProfilePdf', () => {
  it('produces a non-empty PDF for a normal profile', async () => {
    const bytes = await buildProfilePdf({
      name: 'Profile 1',
      samples: ramp(64),
      generatedAt: FIXED_DATE,
    });
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe(PDF_MAGIC);
  });

  it('does not throw on names with non-WinAnsi characters', async () => {
    // Emoji + Greek + CJK in a renamed measurement must not crash the
    // StandardFont encoder.
    const bytes = await buildProfilePdf({
      name: 'Survey Δ 测量 🚧 §1',
      samples: ramp(8),
      generatedAt: FIXED_DATE,
    });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe(PDF_MAGIC);
  });

  it('handles a profile with gaps (NaN heights) without throwing', async () => {
    const s = ramp(10);
    s[3] = { distance: 6, height: NaN };
    s[4] = { distance: 8, height: NaN };
    const bytes = await buildProfilePdf({
      name: 'Gappy',
      samples: s,
      residentOnly: true,
      generatedAt: FIXED_DATE,
    });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe(PDF_MAGIC);
  });

  it('handles an all-gap profile (nothing to plot)', async () => {
    const bytes = await buildProfilePdf({
      name: 'Empty',
      samples: [
        { distance: 0, height: NaN },
        { distance: 10, height: NaN },
      ],
      generatedAt: FIXED_DATE,
    });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe(PDF_MAGIC);
  });

  /**
   * No clock inside the builder. Two runs over the same input, minutes or
   * machines apart, must be the same bytes, or two parties cannot compare a
   * sheet against the one they were sent.
   */
  it('is byte-identical for the same input', async () => {
    const input = {
      name: 'Deterministic',
      samples: ramp(24),
      corridorWidthM: 4,
      groundPercentile: 25,
      crs: 'EPSG:32611',
      verticalDatum: 'NAVD88',
      generatedAt: FIXED_DATE,
      provenance: provenanceOf(
        [
          { layerId: 'layer-b', displayName: 'Flight B', classification: 'producer' },
          { layerId: 'layer-a', displayName: 'Flight A', classification: 'derived' },
        ],
        [0, 0, 1],
      ),
    } as const;
    const a = await buildProfilePdf(input);
    const b = await buildProfilePdf(input);
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
  });
});

/**
 * Inflate every page content stream. pdf-lib Flate-compresses them, so a
 * plain byte-grep over the file can never see the drawn words.
 */
function inflatedStreams(bytes: Uint8Array): string {
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
  return streams;
}

/**
 * The stream text with every drawn string decoded in place, so the PDF path
 * operators stay on their own lines. Used for the geometry assertions.
 */
function drawnPdfText(bytes: Uint8Array): string {
  return inflatedStreams(bytes).replace(/<([0-9A-Fa-f]+)>/g, (_, hex: string) =>
    Buffer.from(hex, 'hex').toString('latin1'),
  );
}

/**
 * Only the drawn strings, in draw order, joined by a single space.
 *
 * The provenance page wraps its paragraphs at the font's real metrics, so one
 * sentence arrives as several `drawText` calls broken at spaces. Rejoining
 * them lets a test assert the sentence the reader sees rather than whatever
 * the line breaks happened to be. Good enough to assert "this wording made it
 * onto the page"; NOT a layout check.
 */
function drawnPdfProse(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (const m of inflatedStreams(bytes).matchAll(/<([0-9A-Fa-f]+)>/g)) {
    parts.push(Buffer.from(m[1], 'hex').toString('latin1'));
  }
  return parts.join(' ');
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
      generatedAt: FIXED_DATE,
    });
    const text = drawnPdfProse(bytes);
    expect(text).toContain('EPSG:2225'); // header line + summary row
    expect(text).toContain('NAVD88');
    expect(text).toContain('12.500 m'); // the real corridor, not "auto" (5 sig figs)
    expect(text).toContain('p25 of corridor'); // header provenance line
    expect(text).not.toContain('auto (5% of length)');
    expect(text).not.toContain('not georeferenced');
  });

  it('keeps the honest fallbacks when nothing is known', async () => {
    const bytes = await buildProfilePdf({
      name: 'Local scan',
      samples: ramp(8),
      generatedAt: FIXED_DATE,
    });
    const text = drawnPdfProse(bytes);
    expect(text).toContain('auto (5% of length)');
    expect(text).toContain('not georeferenced');
  });
});

/**
 * Every occurrence of "ground" on the sheet, except the one inside the
 * standing suitability note ("validated against ground-truth control"),
 * which is a caveat about validation and not a name for the drawn series.
 */
function groundClaims(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/ground/gi)) {
    const at = m.index ?? 0;
    if (/^ground-truth/i.test(text.slice(at, at + 12))) continue;
    out.push(text.slice(Math.max(0, at - 24), at + 24));
  }
  return out;
}

describe('the derived series is named as the legend names it', () => {
  const SOURCES: DerivedSurfaceSource[] = [
    { label: 'Flight A', classification: 'producer', read: 'static' },
  ];

  it('prints the legend series label and caption verbatim', async () => {
    const samples = ramp(16);
    const legend = buildDerivedSurfaceLegend({
      samples,
      percentile: 25,
      corridorHalfWidthM: 12.5,
      sources: SOURCES,
      excludedClasses: NON_GROUND_CLASSES,
    });
    const text = drawnPdfProse(
      await buildProfilePdf({
        name: 'Levee section A',
        samples,
        corridorWidthM: 12.5,
        groundPercentile: 25,
        generatedAt: FIXED_DATE,
        provenance: provenanceOf(
          [{ layerId: 'layer-a', displayName: 'Flight A', classification: 'producer' }],
          [0, 0, 0],
        ),
      }),
    );
    expect(text).toContain(legend.seriesLabel);
    expect(text).toContain(legend.caption);
    // And every sentence the legend states about it.
    for (const line of legend.lines) expect(text).toContain(line);
  });

  it('never names the series after a terrain class', async () => {
    const text = drawnPdfProse(
      await buildProfilePdf({
        name: 'Levee section A',
        samples: ramp(16),
        groundPercentile: 25,
        generatedAt: FIXED_DATE,
        provenance: provenanceOf(
          [{ layerId: 'layer-a', displayName: 'Flight A', classification: 'producer' }],
          [0, 0],
        ),
      }),
    );
    expect(groundClaims(text)).toEqual([]);
    expect(text.toLowerCase()).not.toContain('bare earth');
    expect(text.toLowerCase()).not.toContain('bare-earth');
  });

  it('prints the percentile that actually ran, not the sampler default', async () => {
    const samples = ramp(16);
    const legend = buildDerivedSurfaceLegend({
      samples,
      percentile: 10,
      sources: SOURCES,
      excludedClasses: NON_GROUND_CLASSES,
    });
    const text = drawnPdfProse(
      await buildProfilePdf({
        name: 'p10 section',
        samples,
        groundPercentile: 10,
        generatedAt: FIXED_DATE,
      }),
    );
    expect(legend.seriesLabel).toContain('10th percentile');
    expect(text).toContain(legend.seriesLabel);
    expect(text).not.toContain('25th percentile');
  });
});

describe('the sheet carries the provenance a reader of the file cannot see', () => {
  it('lists every source read, by stable layer id and display name', async () => {
    const record = provenanceOf(
      [
        { layerId: 'urn:layer:alpha', displayName: 'Alpha flight', classification: 'producer' },
        {
          layerId: 'urn:layer:beta',
          displayName: 'Beta stream',
          classification: 'derived',
          streaming: true,
        },
      ],
      [0, 0, 1],
    );
    const text = drawnPdfProse(
      await buildProfilePdf({
        name: 'Two sources',
        samples: ramp(16),
        generatedAt: FIXED_DATE,
        provenance: record,
      }),
    );
    expect(text).toContain('urn:layer:alpha');
    expect(text).toContain('urn:layer:beta');
    expect(text).toContain('Alpha flight');
    expect(text).toContain('Beta stream');
    // The classification kind per source, not one source's answer for both.
    expect(text).toContain('producer');
    expect(text).toContain('derived');
    // The read kind per source.
    expect(text).toContain('streaming');
    expect(text).toContain('static');
    // The counts the record keeps.
    expect(text).toContain('Total accepted returns: 3.');
    expect(text).toContain('Sources read');
    expect(text).toContain('2 (2 contributing)');
  });

  it('states the read scope from the record, not a default', async () => {
    const record = provenanceOf(
      [
        {
          layerId: 'urn:layer:stream',
          displayName: 'Resident only',
          classification: 'producer',
          streaming: true,
        },
      ],
      [0, 0],
    );
    expect(record.scope).toBe('resident-snapshot');
    const text = drawnPdfProse(
      await buildProfilePdf({
        name: 'Resident section',
        samples: ramp(16),
        generatedAt: FIXED_DATE,
        provenance: record,
      }),
    );
    expect(text).toContain(describeProfileProvenance(record));
    expect(text).toContain('a resident streaming snapshot, not the full sources');
    expect(text).toContain('coverage unknown');
  });

  it('says so, rather than implying a read, when no record was attached', async () => {
    const text = drawnPdfProse(
      await buildProfilePdf({
        name: 'No record',
        samples: ramp(16),
        generatedAt: FIXED_DATE,
      }),
    );
    expect(text).toContain('No provenance record was attached to this export');
    expect(text).toContain('Not recorded');
    expect(text).not.toContain('Full static source');
  });

  it('refuses to claim full class exclusion when a source carries no classification', async () => {
    const record = provenanceOf(
      [
        { layerId: 'urn:layer:classified', displayName: 'Classified', classification: 'producer' },
        { layerId: 'urn:layer:raw', displayName: 'Unclassified', classification: 'absent' },
      ],
      [0, 1],
    );
    expect(record.classPolicy.availableOnEverySource).toBe(false);
    const text = drawnPdfProse(
      await buildProfilePdf({
        name: 'Partial classification',
        samples: ramp(16),
        generatedAt: FIXED_DATE,
        provenance: record,
      }),
    );
    expect(text).toContain('excluded on only 1 of 2 sources: partial');
    expect(text).toContain('the exclusion did not apply to the whole section');
    expect(text).toContain('on only 1 of 2 sources: partial'); // the summary line
    expect(text).not.toContain('excluded on every contributing source');
    expect(text).not.toContain('on every source');
  });

  it('claims full class exclusion only when every contributing source carries it', async () => {
    const record = provenanceOf(
      [
        { layerId: 'urn:layer:a', displayName: 'A', classification: 'producer' },
        { layerId: 'urn:layer:b', displayName: 'B', classification: 'derived' },
      ],
      [0, 1],
    );
    expect(record.classPolicy.availableOnEverySource).toBe(true);
    const text = drawnPdfProse(
      await buildProfilePdf({
        name: 'Full classification',
        samples: ramp(16),
        generatedAt: FIXED_DATE,
        provenance: record,
      }),
    );
    expect(text).toContain('excluded on every contributing source (2 of 2)');
    expect(text).not.toContain(': partial');
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

/** Longest run of consecutive linetos after a moveto. */
function longestRun(lines: readonly string[]): number {
  let longest = 0;
  let run = 0;
  for (const l of lines) {
    if (LINE_OP.test(l)) run++;
    else if (MOVE_OP.test(l)) run = 0;
    if (run > longest) longest = run;
  }
  return longest;
}

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
    // The grid draws moveto/lineto pairs, the profile draws one moveto and
    // three linetos.
    expect(longestRun(lines)).toBe(plateau.length - 1);
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
    const text = drawnPdfProse(bytes);
    expect(lines.filter((l) => CURVE_OP.test(l))).toHaveLength(0);
    // Two runs of two linetos each, never a single run that bridges the gap.
    expect(longestRun(lines)).toBe(2);
    // And the sheet SAYS the line breaks, with the gap count the legend counted.
    expect(text).toContain('1 of 7 stations had no returns in the corridor');
    expect(text).toContain('never interpolated across them');
    // The station table prints the gap as a gap, not as an interpolated height.
    expect(text).toContain('gap');
  });
});

describe('unit system (v0.4.5, B9) — the sheet honours the active toggle end-to-end', () => {
  it('imperial: axes, summary and station table all print feet / 100-ft stations', async () => {
    const bytes = await buildProfilePdf({
      name: 'Imperial section',
      samples: ramp(16),
      corridorWidthM: 12.5,
      unitSystem: 'imperial',
      verticalDatum: 'NAVD88',
      generatedAt: FIXED_DATE,
    });
    const text = drawnPdfProse(bytes);
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
    // Station table: header names the unit; heights convert per station
    // (station 0 sits at exactly 100 m = 328.0840 ft → "328.08").
    expect(text).toContain('Elevation (ft), grade to next');
    expect(text).toContain('328.08');
  });

  it('metric stays the default sheet when no unit system is passed', async () => {
    const bytes = await buildProfilePdf({
      name: 'Metric section',
      samples: ramp(16),
      verticalDatum: 'NAVD88',
      generatedAt: FIXED_DATE,
    });
    const text = drawnPdfProse(bytes);
    expect(text).toContain('Elevation (m)');
    expect(text).toContain('Chainage (station km+m)');
    expect(text).toContain('Elevation (m), grade to next');
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
    const text = drawnPdfProse(
      await buildProfilePdf({ name: 'Datum section', samples, generatedAt: FIXED_DATE }),
    );
    const byLabel = new Map(
      profileSummaryRows(computeProfileSummary(samples), 'metric', 'orthometric').map((r) => [
        r.label,
        r.value,
      ]),
    );
    expect(byLabel.get('Highest elevation')).toBe('418.16 m @ 0+343.98');
    expect(text).toContain(byLabel.get('Highest elevation'));
    expect(text).toContain(byLabel.get('Lowest elevation'));
    // The heights that reach the sheet are the header's, not the render
    // origin's — and never the centimetres a length formatter made of them.
    expect(text).toContain('348.93 m');
    expect(text).not.toContain('41186.5');
  });
});

describe('height wording follows heightLabel, never the sheet author', () => {
  it('an undeclared datum is a height, not an elevation', async () => {
    const text = drawnPdfProse(
      await buildProfilePdf({ name: 'No datum', samples: ramp(16), generatedAt: FIXED_DATE }),
    );
    expect(heightLabel('unknown')).toBe('Height (datum unknown)');
    expect(text).toContain('Height (datum unknown) (m)');
    expect(text).toContain('Height (datum unknown) min / max');
    expect(text).toContain('Highest / Lowest height (datum unknown)');
    expect(text).toContain('No vertical datum is declared');
    // Nothing on the sheet may call these elevations.
    expect(text).not.toContain('Elevation (m)');
    expect(text).not.toContain('Elevation min / max');
  });

  it('a datum the tables do not recognise is not upgraded to an elevation', async () => {
    const text = drawnPdfProse(
      await buildProfilePdf({
        name: 'Unrecognised datum',
        samples: ramp(16),
        verticalDatum: 'Site benchmark 1972',
        generatedAt: FIXED_DATE,
      }),
    );
    expect(text).toContain('Height (datum unknown) (m)');
    expect(text).toContain('Site benchmark 1972'); // still printed, still named
    expect(text).not.toContain('Elevation (m)');
  });

  it('an orthometric datum earns Elevation', async () => {
    const text = drawnPdfProse(
      await buildProfilePdf({
        name: 'NAVD88 section',
        samples: ramp(16),
        verticalDatum: 'NAVD88',
        generatedAt: FIXED_DATE,
      }),
    );
    expect(heightLabel('orthometric')).toBe('Elevation');
    expect(text).toContain('Elevation (m)');
    expect(text).toContain('Elevation min / max');
    expect(text).toContain('Highest / Lowest elevation');
    expect(text).toContain('approximately mean sea level');
  });

  it('an ellipsoidal reference in the record is not printed as an elevation', async () => {
    const text = drawnPdfProse(
      await buildProfilePdf({
        name: 'GNSS section',
        samples: ramp(16),
        generatedAt: FIXED_DATE,
        provenance: provenanceOf(
          [{ layerId: 'urn:layer:a', displayName: 'A', classification: 'producer' }],
          [0, 0],
          'ellipsoidal',
        ),
      }),
    );
    expect(text).toContain('Ellipsoidal height (m)');
    expect(text).toContain('Not a sea-level elevation.');
    expect(text).not.toContain('Elevation (m)');
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
    const text = drawnPdfProse(
      await buildProfilePdf({
        name: 'Unresolved datum',
        samples,
        datumKnown: false,
        generatedAt: FIXED_DATE,
      }),
    );
    // Nothing on the sheet may call these elevations.
    expect(text).toContain('Height (local frame) (m)');
    expect(text).toContain('Height (local frame) min / max');
    expect(text).not.toContain('Elevation (m)');
    // The sheet's existing datum row is where a reader looks for exactly this.
    expect(text).toContain('conflicting cloud origins');
    // And it agrees with the panel, refusal or not.
    const byLabel = new Map(
      profileSummaryRows(computeProfileSummary(samples), 'metric', 'local').map((r) => [
        r.label,
        r.value,
      ]),
    );
    expect(text).toContain(byLabel.get('Highest height (local frame)'));
  });

  it('a conflicting origin outranks an orthometric record', async () => {
    const text = drawnPdfProse(
      await buildProfilePdf({
        name: 'Conflicting origins',
        samples: ramp(16),
        datumKnown: false,
        verticalDatum: 'NAVD88',
        generatedAt: FIXED_DATE,
        provenance: provenanceOf(
          [{ layerId: 'urn:layer:a', displayName: 'A', classification: 'producer' }],
          [0, 0],
          'orthometric',
        ),
      }),
    );
    expect(text).toContain('Height (local frame) (m)');
    expect(text).not.toContain('Elevation (m)');
  });

  it('a resolvable datum leaves the sheet exactly as it was', async () => {
    const text = drawnPdfProse(
      await buildProfilePdf({
        name: 'Metric section',
        samples: ramp(16),
        verticalDatum: 'NAVD88',
        generatedAt: FIXED_DATE,
      }),
    );
    expect(text).toContain('Elevation (m)');
    expect(text).not.toContain('Height (local frame) (m)');
  });
});

/**
 * The ground fill: the area under the section, filled to the plot floor so
 * the drawing reads as terrain rather than as a line on a chart.
 *
 * It is drawn as abutting vertical strokes in the ground tint, one `m … l S`
 * each, because a filled polygon emits a lineto per vertex and would be
 * indistinguishable in the content stream from a drawn profile. Both halves
 * are asserted here: that the fill is actually on the page, and that adding
 * it left the document's longest lineto run alone.
 */
const GROUND_STROKE = '0.78 0.85 0.91 RG';

describe('profile sheet: the ground under the section', () => {
  it('fills to the plot floor without lengthening any lineto run', async () => {
    const bytes = await buildProfilePdf({
      name: 'Ground',
      samples: ramp(24),
      generatedAt: FIXED_DATE,
    });
    const raw = drawnPdfText(bytes);
    const lines = raw.split('\n');

    // The file still says what it said before: the longest run of consecutive
    // linetos anywhere in it is the profile's own longest unbroken run, 23
    // segments across 24 stations with no gaps. A polygon fill would make
    // this the vertex count of the fill instead.
    expect(longestRun(lines)).toBe(23);

    // And the fill is there, as many strokes rather than as one shape.
    const bars = raw.split(GROUND_STROKE).length - 1;
    expect(bars).toBeGreaterThan(100);
  });

  it('leaves a coverage gap unfilled', async () => {
    const gapped: ProfileChartSample[] = [
      { distance: 0, height: 1, count: 4 },
      { distance: 10, height: 2, count: 4 },
      { distance: 20, height: Number.NaN, count: 0 },
      { distance: 30, height: 2, count: 4 },
      { distance: 40, height: 1, count: 4 },
    ];
    const bytes = await buildProfilePdf({
      name: 'Gap ground',
      samples: gapped,
      generatedAt: FIXED_DATE,
    });
    const raw = drawnPdfText(bytes);
    // Absent ground is absent, not flat: the fill breaks where the line
    // breaks, so the two runs stay two runs.
    expect(longestRun(raw.split('\n'))).toBe(1);

    // Every ground stroke's x, in draw order. A bar is one `m … l` pair at a
    // single x, so the moveto carries the column the bar stands in.
    const xs = [
      ...raw.matchAll(
        new RegExp(`${GROUND_STROKE}[^]*?(-?[\\d.]+) -?[\\d.]+ m`, 'g'),
      ),
    ]
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    expect(xs.length).toBeGreaterThan(10);

    // The section is 40 m long with its middle station empty, so the middle
    // half of the drawing carries no ground at all. The widest hole between
    // adjacent bars is that gap; a fill that bridged it would leave nothing
    // wider than the pitch the bars are placed at.
    let widest = 0;
    for (let i = 1; i < xs.length; i++) widest = Math.max(widest, xs[i] - xs[i - 1]);
    const span = xs[xs.length - 1] - xs[0];
    expect(widest / span).toBeGreaterThan(0.4);
  });
});
