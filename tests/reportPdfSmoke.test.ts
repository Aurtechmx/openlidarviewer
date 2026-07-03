/**
 * reportPdfSmoke.test.ts
 *
 * Closes the gap between the engine's pure contract tests (which stop at
 * the section builders) and the actual rendered PDF. This spec drives
 * `renderReportPdf` end-to-end for every shipped template, then re-parses
 * the resulting bytes with pdf-lib so the assertions exercise the real
 * PDF structure rather than the input data.
 *
 * Scope:
 *   - All five templates render without throwing.
 *   - Each result Blob carries non-trivial bytes and a positive page count.
 *   - The reported `pages` field matches the PDF's actual page count.
 *   - The metadata fields the renderer sets — title, author, creator,
 *     producer — survive a round-trip parse.
 *   - The MIME type and template id echo correctly.
 *
 * Visual assets are intentionally omitted from the inputs so the test
 * stays hermetic — Studio PNG capture is a DOM-bound concern, validated
 * separately in the e2e smoke spec. The cover / dataset summary /
 * annotations / measurements / technical notes sections fully exercise
 * the renderer's text-only layout paths.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  REPORT_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  generateReport,
} from '../src/report';
import type { ReportInputs } from '../src/report';

function makeInputs(templateId: ReportInputs['templateId']): ReportInputs {
  return {
    templateId,
    branding: {
      organisation: 'Acme Survey Co.',
      author: 'A. Inspector',
      accentColor: '#00b2ff',
      theme: 'light-technical',
      footerNote: 'Confidential — project 8821',
      projectMetadata: {
        client: 'Riverside Holdings',
        project: 'East Levee Survey',
        phase: 'Phase 2 — As-built',
        reference: 'RH-EL-2026-04',
        date: '2026-05-28',
      },
    },
    cover: {
      title: 'Drone LiDAR — Survey Summary',
      subtitle: 'East Levee, Riverside',
      datasetName: 'east-levee-2026-05.copc.laz',
      exportedAt: '2026-05-28T15:30:00.000Z',
    },
    datasetRows: [
      { label: 'Format', value: 'COPC (LAS 1.4, PDRF 6)' },
      { label: 'Points', value: '12,400,000' },
      { label: 'Extent', value: '450 × 320 × 32 m' },
      { label: 'Density', value: '~85 pts/m²' },
      { label: 'CRS', value: 'EPSG:32612 — WGS 84 / UTM zone 12N' },
    ],
    visuals: [],
    annotations: [
      {
        title: 'Crest waypoint',
        type: 'point',
        note: 'Levee crest reference for the QA baseline.',
        position: { x: 12.5, y: 8.3, z: 4.1 },
        createdAt: Date.UTC(2026, 4, 28, 14, 15),
      },
      {
        title: 'Erosion zone',
        type: 'area',
        note: 'Visible scour on the riverside slope.',
        position: { x: 88.0, y: 22.7, z: 2.6 },
        createdAt: Date.UTC(2026, 4, 28, 14, 22),
      },
    ],
    measurements: [
      { name: 'Crest length', kind: 'distance', value: '125.8 m', pointCount: 2 },
      { name: 'Slope grade',  kind: 'grade',    value: '3.4 %',   pointCount: 2 },
      { name: 'Footprint',    kind: 'area',     value: '1,820 m²', pointCount: 5 },
    ],
    technicalNotes:
      'Capture conditions: clear sky, 5 m/s wind.\n' +
      'Calibration: pre- and post-flight static checks within tolerance.',
  };
}

describe('PDF report smoke render', () => {
  for (const template of REPORT_TEMPLATES) {
    it(`renders the ${template.id} template end-to-end`, async () => {
      const result = await generateReport(makeInputs(template.id));

      // The shape the engine promises.
      expect(result.mimeType).toBe('application/pdf');
      expect(result.templateId).toBe(template.id);
      expect(result.pages).toBeGreaterThan(0);

      // The Blob must hold real bytes — a stub renderer that returned an
      // empty PDF would slip past the contract tests, so the byte gate
      // matters.
      expect(result.blob.size).toBeGreaterThan(1024);

      // Round-trip parse: load the rendered bytes back through pdf-lib
      // and confirm the structure the renderer wrote is what came out
      // the other side.
      const bytes = new Uint8Array(await result.blob.arrayBuffer());
      const parsed = await PDFDocument.load(bytes);

      // Page count agreement between the engine's report and the PDF.
      expect(parsed.getPageCount()).toBe(result.pages);

      // Metadata fields the renderer sets explicitly.
      expect(parsed.getTitle()).toBe('Drone LiDAR — Survey Summary');
      expect(parsed.getAuthor()).toBe('A. Inspector');
      // The Creator string includes the live __APP_VERSION__ stamp.
      const creator = parsed.getCreator() ?? '';
      expect(creator).toContain('OpenLiDARViewer Report Engine v');
      // pdf-lib overwrites the Producer field with its own attribution on
      // save; this is intentional behaviour and not something the engine
      // controls. Assert it contains the pdf-lib identifier rather than
      // pinning the exact string.
      const producer = parsed.getProducer() ?? '';
      expect(producer).toMatch(/pdf-lib/i);
    });
  }

  it('draws a vector profile chart for a profile measurement with samples', async () => {
    const inputs = makeInputs(DEFAULT_TEMPLATE_ID);
    const withProfile: ReportInputs = {
      ...inputs,
      measurements: [
        {
          name: 'Section A–B', kind: 'profile', value: '125.8 m', pointCount: 2,
          profileExtras: {
            summary: 'Horizontal 120 m · 3D 126 m · Δh 12 m · 10.00% grade',
            stations: '0 m · 25 m · 50 m · 75 m · 100 m',
            stationInterval: 'Station interval 25 m (5 stations)',
            slopeSummary: 'Max +12%, Min -1%, Avg +5%',
            chart: Array.from({ length: 20 }, (_, i) => ({
              distance: i * 5,
              height: Math.sin(i / 3) * 4 + 10,
            })),
          },
        },
      ],
    };
    const result = await generateReport(withProfile);
    expect(result.mimeType).toBe('application/pdf');
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
    expect(result.pages).toBeGreaterThan(0);
  });

  it('renders the default template id', async () => {
    const result = await generateReport(makeInputs(DEFAULT_TEMPLATE_ID));
    expect(result.pages).toBeGreaterThan(0);
    expect(result.blob.size).toBeGreaterThan(1024);
  });

  it('throws a clear error for an unknown template id', async () => {
    // Cast through `as` because the union type rightly forbids this at
    // compile time — the runtime guard is what we're exercising.
    const inputs = {
      ...makeInputs('technical-report'),
      templateId: 'not-a-real-template' as unknown as ReportInputs['templateId'],
    };
    await expect(generateReport(inputs)).rejects.toThrow(/Unknown report template/);
  });

  it('survives dark-inspection theme without throwing', async () => {
    const inputs = makeInputs('technical-report');
    const dark: ReportInputs = {
      ...inputs,
      branding: { ...inputs.branding, theme: 'dark-inspection' },
    };
    const result = await generateReport(dark);
    expect(result.pages).toBeGreaterThan(0);
    expect(result.blob.size).toBeGreaterThan(1024);
  });

  it('survives minimal-engineering theme without throwing', async () => {
    const inputs = makeInputs('technical-report');
    const minimal: ReportInputs = {
      ...inputs,
      branding: { ...inputs.branding, theme: 'minimal-engineering' },
    };
    const result = await generateReport(minimal);
    expect(result.pages).toBeGreaterThan(0);
    expect(result.blob.size).toBeGreaterThan(1024);
  });

  it('renders cleanly when every optional field is absent', async () => {
    const minimal: ReportInputs = {
      templateId: 'technical-report',
      branding: {},
      cover: {
        title: 'Bare Cover',
        datasetName: 'plain.las',
        exportedAt: '2026-05-28T00:00:00.000Z',
      },
      datasetRows: [],
      visuals: [],
      annotations: [],
      measurements: [],
    };
    const result = await generateReport(minimal);
    expect(result.pages).toBeGreaterThan(0);
    expect(result.blob.size).toBeGreaterThan(512);
  });

  // ── Hardening: input bounds + timeout + abort ─────────────────────────

  it('rejects an annotation list above the safety ceiling', async () => {
    const huge: ReportInputs = {
      ...makeInputs('technical-report'),
      annotations: Array.from({ length: 3000 }, (_, i) => ({
        title: `A ${i}`,
        type: 'point',
        position: { x: 0, y: 0, z: 0 },
        createdAt: 0,
      })),
    };
    await expect(generateReport(huge)).rejects.toThrow(/annotations.*cap/);
  });

  it('rejects a measurement list above the safety ceiling', async () => {
    const huge: ReportInputs = {
      ...makeInputs('technical-report'),
      measurements: Array.from({ length: 3000 }, (_, i) => ({
        name: `M ${i}`,
        kind: 'distance',
        value: '1 m',
        pointCount: 2,
      })),
    };
    await expect(generateReport(huge)).rejects.toThrow(/measurements.*cap/);
  });

  it('rejects technical-notes content above the size ceiling', async () => {
    const huge: ReportInputs = {
      ...makeInputs('technical-report'),
      technicalNotes: 'x'.repeat(300_000),
    };
    await expect(generateReport(huge)).rejects.toThrow(/Technical notes.*cap/);
  });

  it('rejects a visuals list above the safety ceiling', async () => {
    const huge: ReportInputs = {
      ...makeInputs('technical-report'),
      visuals: Array.from({ length: 64 }, () => ({
        blob: new Blob([new Uint8Array(8)], { type: 'image/png' }),
        caption: 'x',
        width: 100,
        height: 100,
      })),
    };
    await expect(generateReport(huge)).rejects.toThrow(/visuals.*cap/);
  });

  it('honours an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateReport(makeInputs('technical-report'), { signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
  });

  it('isolates a corrupt visual blob without aborting the whole render', async () => {
    // The renderer's per-section try/catch should swallow the visual's
    // embed failure and continue rendering the rest of the template.
    // The result is a thinner-than-expected PDF but a valid one.
    const corrupt: ReportInputs = {
      ...makeInputs('technical-report'),
      visuals: [
        {
          // Not a valid PNG — just random bytes. embedPng throws; the
          // renderer's per-section try/catch should swallow it.
          blob: new Blob([new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05])], {
            type: 'image/png',
          }),
          caption: 'corrupt-fixture',
          width: 100,
          height: 100,
        },
      ],
    };
    const result = await generateReport(corrupt);
    // Cover + dataset summary + annotations + measurements + technical
    // notes still render even though the visuals section skipped.
    expect(result.pages).toBeGreaterThan(0);
    expect(result.blob.size).toBeGreaterThan(1024);
  });

  it('renders cleanly when user-supplied strings contain non-WinAnsi glyphs', async () => {
    // Regression: pdf-lib's StandardFonts.Helvetica is WinAnsi-encoded.
    // The Measurements section in particular emits em-dash (U+2014) for
    // degenerate measurements via ReportMeasurementSection. Before
    // v0.3.6's broad sanitiser pass, em-dashes anywhere in user input
    // caused the host section to silently disappear from the PDF.
    //
    // This test pins the contract: every user-facing string sees the
    // sanitiser, so the rendered PDF still grows by ~all the section
    // bytes even when the inputs are riddled with em-dashes, ellipses,
    // smart quotes, the degree sign, and a stray emoji.
    const inputs: ReportInputs = {
      ...makeInputs('technical-report'),
      cover: {
        ...makeInputs('technical-report').cover,
        title: 'East Levee — Survey — “Q1 inspection”',
        subtitle: 'Crew: A & B · ambient 24 °C · clear sky… 🛰',
      },
      annotations: [
        {
          title: 'Crack — west face',
          type: 'point',
          note: 'Re-inspect in Q2 — surface widening 2 → 4 mm',
          position: { x: 1, y: 2, z: 3 },
          createdAt: Date.UTC(2026, 4, 28),
        },
      ],
      measurements: [
        // The exact em-dash that ReportMeasurementSection emits for a
        // degenerate measurement value.
        { name: 'Spalling — south slope', kind: 'distance', value: '—', pointCount: 1 },
        { name: 'Drift — m³', kind: 'volume', value: '12.4 m³', pointCount: 4 },
      ],
      technicalNotes:
        'Notes: weather window 09:00–11:30, ground temp ≈ 18 °C…\n' +
        'Calibration drift within ±0.5 mm.',
    };
    const result = await generateReport(inputs);
    expect(result.pages).toBeGreaterThan(0);
    expect(result.blob.size).toBeGreaterThan(2048);

    // Round-trip parse so a corrupted PDF would fail loudly.
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPageCount()).toBe(result.pages);
    // The cover title's em-dash was sanitised to '--', smart quotes to
    // straight quotes — pdf-lib stores the actual drawn string in the
    // page content stream, so the title metadata is what we set on the
    // document directly (unsanitised). The test's main contract is that
    // generation completes and bytes are present.
  });

  it('completes within the default render budget for a realistic input', async () => {
    // Sanity: a normal report should land well inside the 30 s budget.
    // Use an explicit small budget to fail fast if a regression makes the
    // engine pathologically slow.
    const result = await generateReport(makeInputs('technical-report'), {
      timeoutMs: 10_000,
    });
    expect(result.pages).toBeGreaterThan(0);
  });
});
