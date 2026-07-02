/**
 * reportPdfLayout.test.ts
 *
 * v0.5.4 layout + glyph regressions for the Engineering Inspection PDF,
 * pinned against the ACTUAL rendered bytes: the content streams are
 * inflated and every text run's (page, x, y, size, text) is extracted, so
 * these assertions exercise the real layout, not the input data.
 *
 * Pinned bugs (all observed on the v0.5.3 Tikal export):
 *  1. Page-1 overlap — a provenance `source:` citation with a non-WinAnsi
 *     glyph ("Ruzgienė") threw mid-section; the per-section catch reverted
 *     the cursor and the Measurements/Annotations headings drew OVER the
 *     Provenance + Signals block. Pinned via a strict per-page no-upward-
 *     jump rule over the draw order (the bug jumped +58 pt).
 *  2. Section-heading underline only spanned the first few characters
 *     (fixed 40 pt) — now spans the measured heading width.
 *  3. ASCII fallbacks ("m^2", "--", "1.96 x") — WinAnsi-native glyphs
 *     (², —, ×) now pass through and land in the content stream.
 *  4. Near-empty trailing page — small placeholder sections now reserve
 *     exactly heading + body (keep-with-next), so a heading is never the
 *     last text on a page.
 */

import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { generateReport, composeReportInputs } from '../src/report';
import type { ReportInputs, ReportProvenanceFingerprint } from '../src/report';
import { sanitiseForPdf } from '../src/report/ReportPdfRenderer';
import { fingerprintFor } from '../src/diagnostics/provenance';

// ─────────────────────────────────────────────────────────────────────────────
// Content-stream extraction
// ─────────────────────────────────────────────────────────────────────────────

interface TextRun {
  page: number;
  x: number;
  y: number;
  size: number;
  /** WinAnsi bytes decoded as latin1 — ASCII text compares directly. */
  text: string;
}

interface RectOp {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

async function renderRuns(
  inputs: ReportInputs,
): Promise<{ pages: number; failed: readonly string[]; runs: TextRun[]; rects: RectOp[] }> {
  const result = await generateReport(inputs);
  const bytes = Buffer.from(await result.blob.arrayBuffer());
  const runs: TextRun[] = [];
  const rects: RectOp[] = [];
  let page = 0;
  for (const seg of bytes.toString('latin1').split(/stream\r?\n/).slice(1)) {
    const raw = seg.split('endstream')[0];
    let content: string;
    try {
      content = inflateSync(Buffer.from(raw, 'latin1')).toString('latin1');
    } catch {
      continue; // not a flate stream (xref etc.)
    }
    if (!content.includes('BT')) continue;
    page++;
    for (const m of content.matchAll(
      /\/\S+ ([\d.]+) Tf\n[\d.]+ TL\n1 0 0 1 ([\d.-]+) ([\d.-]+) Tm\n<([0-9A-Fa-f]*)> Tj/g,
    )) {
      runs.push({
        page,
        size: Number(m[1]),
        x: Number(m[2]),
        y: Number(m[3]),
        text: Buffer.from(m[4], 'hex').toString('latin1'),
      });
    }
    // pdf-lib draws rectangles as a translate (cm) + explicit path:
    //   1 0 0 1 x y cm … 0 0 m / 0 h l / w h l / w 0 l / h f
    for (const m of content.matchAll(
      /1 0 0 1 ([\d.-]+) ([\d.-]+) cm\n1 0 0 1 0 0 cm\n1 0 0 1 0 0 cm\n0 0 m\n0 ([\d.-]+) l\n([\d.-]+) \3 l\n\4 0 l\nh\nf/g,
    )) {
      rects.push({
        page,
        x: Number(m[1]),
        y: Number(m[2]),
        h: Number(m[3]),
        w: Number(m[4]),
      });
    }
  }
  return { pages: result.pages, failed: result.failedSections, runs, rects };
}

/** Footer stamps are drawn in a late pass at y ≤ 22 — not layout-flow text. */
const isFooter = (r: TextRun): boolean => r.y <= 22;

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — the Tikal probe's shape: E57, ~470 K points, 50 × 54 m footprint,
// zero measurements / annotations / visuals.
// ─────────────────────────────────────────────────────────────────────────────

const TIKAL_METADATA = {
  fileName: 'tikal_temple_i_reference_model.e57',
  format: 'E57',
  sourcePointCount: 469_703,
  width: 50,
  depth: 54,
  height: 47.16,
  density: 469_703 / (50 * 54),
  hasRgb: true,
  hasIntensity: true,
  hasClassification: false,
};

/** The drone fingerprint — its bounds cite "Ruzgienė", the overlap trigger. */
function droneProvenance(): ReportProvenanceFingerprint {
  const f = fingerprintFor('drone-lidar');
  return {
    label: f.label,
    confidence: f.confidence,
    signals: f.signals,
    bounds: f.bounds.map((b) => ({ label: b.label, value: b.value, source: b.source })),
    disclaimer: f.disclaimer,
  };
}

function tikalInputs(overrides: Partial<Parameters<typeof composeReportInputs>[0]> = {}): ReportInputs {
  return composeReportInputs({
    templateId: 'engineering-inspection',
    title: 'Engineering Inspection',
    subtitle: TIKAL_METADATA.fileName,
    metadata: TIKAL_METADATA,
    visuals: [],
    annotations: [],
    measurements: [],
    unitSystem: 'metric' as never,
    provenance: droneProvenance(),
    ...overrides,
  });
}

const TIKAL_SOURCE_METADATA = {
  standard: [
    { name: 'sensorModel', value: 'Procedural heritage reference reconstruction' },
    { name: 'coordinateMetadata', value: 'LOCAL_CARTESIAN_METRES; no geodetic CRS' },
  ],
  extensions: [
    {
      name: 'accuracyClass',
      value: 'reference_based_not_survey_grade',
      namespaceUri: 'https://aurtech.mx/openlidarviewer/metadata/1.0',
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. The page-1 overlap pin
// ─────────────────────────────────────────────────────────────────────────────

describe('engineering-inspection layout — overlap regression', () => {
  it('renders every section (the Ruzgienė citation no longer aborts provenance)', async () => {
    const { failed } = await renderRuns(tikalInputs());
    expect(failed).toEqual([]);
  });

  it('never moves the layout cursor back up a page (no two text runs overlap)', async () => {
    const { runs } = await renderRuns(tikalInputs());
    // Walk the draw order per page. Legitimate flow only ever moves DOWN,
    // apart from ≤ 12 pt intra-block adjustments (the density-bar readout,
    // footer note above the footer line). The v0.5.3 bug jumped +58 pt —
    // the Measurements heading drawn back up over the Signals block.
    const byPage = new Map<number, TextRun[]>();
    for (const r of runs) {
      if (isFooter(r)) continue;
      const list = byPage.get(r.page) ?? [];
      list.push(r);
      byPage.set(r.page, list);
    }
    for (const [page, list] of byPage) {
      for (let i = 1; i < list.length; i++) {
        expect(
          list[i].y,
          `page ${page}: run "${list[i].text.slice(0, 40)}" drawn ${(list[i].y - list[i - 1].y).toFixed(0)} pt ABOVE ` +
            `the preceding run "${list[i - 1].text.slice(0, 40)}"`,
        ).toBeLessThanOrEqual(list[i - 1].y + 12);
      }
    }
  });

  it('draws the Measurements heading strictly below the Provenance block', async () => {
    const { runs } = await renderRuns(tikalInputs());
    const provenance = runs.find((r) => r.text === 'Provenance' && r.size === 14);
    const measurements = runs.find((r) => r.text.startsWith('Measurements (') && r.size === 14);
    const signals = runs.filter((r) => r.text.includes('source: Ruzgiene'));
    expect(provenance).toBeDefined();
    expect(measurements).toBeDefined();
    expect(signals.length).toBeGreaterThan(0); // the citation actually rendered
    // Later section ⇒ later page, or lower on the same page.
    const after = (a: TextRun, b: TextRun): boolean =>
      a.page > b.page || (a.page === b.page && a.y < b.y);
    expect(after(measurements!, provenance!)).toBe(true);
    for (const s of signals) expect(after(measurements!, s) || s.page > measurements!.page).toBe(true);
  });

  it('draws each section heading exactly once', async () => {
    const { runs } = await renderRuns(tikalInputs());
    for (const heading of ['Provenance', 'Measurements (0)', 'Annotations (0)', 'Visuals', 'Technical notes']) {
      expect(
        runs.filter((r) => r.text === heading && r.size === 14),
        `heading "${heading}"`,
      ).toHaveLength(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Section-heading underline spans the heading text
// ─────────────────────────────────────────────────────────────────────────────

describe('engineering-inspection layout — heading underline', () => {
  it('spans the measured heading width, not a fixed 40 pt stub', async () => {
    const { runs, rects } = await renderRuns(tikalInputs());
    const HEADINGS = new Set([
      'Inspection summary', 'Dataset summary', 'Provenance',
      'Measurements (0)', 'Annotations (0)', 'Visuals', 'Technical notes',
    ]);
    const headings = runs.filter((r) => r.size === 14 && HEADINGS.has(r.text));
    expect(headings.length).toBe(HEADINGS.size);
    for (const h of headings) {
      // The underline is the 1.5 pt-high rect drawn 4 pt under the heading.
      const underline = rects.find(
        (r) => r.page === h.page && r.h === 1.5 && Math.abs(r.y - (h.y - 4)) < 0.5,
      );
      expect(underline, `underline for "${h.text}"`).toBeDefined();
      // Longer than the old 40 pt stub and proportional to the text
      // ("Inspection summary" at 14 pt bold measures ≈ 120+ pt).
      expect(underline!.w, `underline width for "${h.text}"`).toBeGreaterThan(40);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. WinAnsi glyphs — no ASCII fallbacks in this template
// ─────────────────────────────────────────────────────────────────────────────

describe('sanitiseForPdf — WinAnsi glyph policy', () => {
  it('keeps the WinAnsi-native typographic glyphs verbatim', () => {
    expect(sanitiseForPdf('174 pts/m²')).toBe('174 pts/m²');
    expect(sanitiseForPdf('12.4 m³')).toBe('12.4 m³');
    expect(sanitiseForPdf('NVA = 1.96 × RMSEz')).toBe('NVA = 1.96 × RMSEz');
    expect(sanitiseForPdf('declared — not verified')).toBe('declared — not verified');
    expect(sanitiseForPdf('± 0.5 mm at 20 °C · §4 … “quoted”')).toBe(
      '± 0.5 mm at 20 °C · §4 … “quoted”',
    );
  });

  it('maps only the glyphs WinAnsi genuinely lacks', () => {
    expect(sanitiseForPdf('≥ 2 pts/m²')).toBe('>= 2 pts/m²');
    expect(sanitiseForPdf('≤ 0.7 m')).toBe('<= 0.7 m');
    expect(sanitiseForPdf('σ and Δ and √')).toBe('sigma and d and sqrt');
  });

  it('transliterates Latin-Extended letters in cited author names', () => {
    expect(sanitiseForPdf('Ruzgienė 2025 §4')).toBe('Ruzgiene 2025 §4');
    expect(sanitiseForPdf('Ślęża, Łódź')).toBe('Sleza, Lódz');
    // Latin-1 and CP1252 letters are WinAnsi-native and stay verbatim.
    expect(sanitiseForPdf('Krausková, Šašak, Žížala')).toBe('Krausková, Šašak, Žížala');
  });

  it('degrades everything else to a visible "?"', () => {
    expect(sanitiseForPdf('emoji 🛰 and CJK 点')).toBe('emoji ?? and CJK ?');
  });

  it('lands the real glyph bytes in the rendered content stream', async () => {
    const { runs } = await renderRuns(tikalInputs());
    const all = runs.map((r) => r.text).join('\n');
    expect(all).toContain('pts/m\xB2');            // ² as WinAnsi 0xB2, not "^2"
    expect(all).toContain('1.96 \xD7 RMSEz');      // × as WinAnsi 0xD7, not "x"
    expect(all).toContain('\x97');                 // — as CP1252 0x97, not "--"
    expect(all).not.toContain('m^2');
    expect(all).not.toContain('--');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Declared source metadata section — presence, disclosure, omission
// ─────────────────────────────────────────────────────────────────────────────

describe('engineering-inspection — Declared source metadata section', () => {
  it('renders the declared fields under the not-verified disclosure', async () => {
    const { runs, failed } = await renderRuns(
      tikalInputs({ sourceMetadata: TIKAL_SOURCE_METADATA }),
    );
    expect(failed).toEqual([]);
    const all = runs.map((r) => r.text).join('\n');
    expect(all).toContain('Declared source metadata');
    expect(all).toContain('declared by the file, not verified by');
    expect(all).toContain('sensorModel');
    expect(all).toContain('Procedural heritage reference reconstruction');
    expect(all).toContain('Extension fields (file-declared)');
    expect(all).toContain('accuracyClass');
    expect(all).toContain('reference_based_not_survey_grade');
    expect(all).toContain('https://aurtech.mx/openlidarviewer/metadata/1.0');
  });

  it('omits the section entirely when nothing is declared', async () => {
    const { runs } = await renderRuns(tikalInputs());
    const all = runs.map((r) => r.text).join('\n');
    expect(all).not.toContain('Declared source metadata');
  });

  it('shows the declared source as the Inspection summary headline when demoted', async () => {
    const declared: ReportProvenanceFingerprint = {
      label: 'Declared: Procedural heritage reference reconstruction (from file metadata)',
      confidence: 'high',
      signals: [
        'Declared sensorModel: "Procedural heritage reference reconstruction" — declared by the file, not verified by OpenLiDARViewer',
        'Heuristic guess (secondary, low confidence): Drone-mounted LiDAR (UAV ALS) — demoted because the file\'s declared metadata contradicts it',
      ],
      bounds: [],
      disclaimer: 'Quoted verbatim from the file\'s own metadata — declared by the file, not verified by OpenLiDARViewer.',
    };
    const { runs, failed } = await renderRuns(
      tikalInputs({ provenance: declared, sourceMetadata: TIKAL_SOURCE_METADATA }),
    );
    expect(failed).toEqual([]);
    const all = runs.map((r) => r.text).join('\n');
    // Headline shows the declaration…
    expect(all).toContain('Declared: Procedural heritage reference reconstruction');
    // …with the heuristic demoted to a secondary line, never the headline.
    const headline = runs.find((r) => r.size === 11);
    expect(headline?.text).toContain('Declared:');
    expect(headline?.text).not.toMatch(/UAV|Drone/);
    expect(all).toContain('Heuristic guess (secondary, low confidence)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Keep-with-next pagination
// ─────────────────────────────────────────────────────────────────────────────

describe('engineering-inspection — keep-with-next pagination', () => {
  it('never leaves a section heading orphaned at the bottom of a page', async () => {
    // Sweep the annotation count so section starts land at many different
    // heights, including just above the old flat-60 break threshold.
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
      // Pre-built report rows (bypassing the runtime Annotation shape) so
      // the sweep varies ONLY the vertical space the section consumes.
      const rows = Array.from({ length: n }, (_, i) => ({
        title: `WP ${i + 1}`,
        type: 'point',
        note: 'note',
        position: { x: i, y: i, z: 0 },
        createdAt: Date.UTC(2026, 6, 2),
      }));
      const inputs: ReportInputs = { ...tikalInputs(), annotations: rows };
      const { runs, failed } = await renderRuns(inputs);
      expect(failed).toEqual([]);
      const byPage = new Map<number, TextRun[]>();
      for (const r of runs) {
        if (isFooter(r)) continue;
        (byPage.get(r.page) ?? byPage.set(r.page, []).get(r.page)!).push(r);
      }
      for (const [page, list] of byPage) {
        const last = list[list.length - 1];
        expect(
          last.size,
          `annotations=${n}, page ${page}: "${last.text.slice(0, 40)}" — a 14 pt section ` +
            'heading must never be the last text on a page',
        ).not.toBe(14);
      }
    }
  }, 30_000);
});
