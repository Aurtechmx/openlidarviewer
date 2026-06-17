/**
 * reportEngine.test.ts — v0.3.3 — PDF Report Engine.
 *
 * Tests the PURE parts of the report engine — templates, branding,
 * section builders, asset composer. The pdf-lib renderer itself
 * (`renderReportPdf`) is exercised by the live-build smoke test, not
 * here (pdf-lib invokes its own font + image embedding which is harder
 * to assert on byte-for-byte in Node).
 */

import { describe, it, expect } from 'vitest';
import {
  REPORT_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  getReportTemplate,
  composeReportInputs,
  buildDatasetSummary,
  buildAnnotationRows,
  buildMeasurementRows,
  DEFAULT_ACCENT,
  parseAccentColor,
  effectiveBranding,
} from '../src/report';
import type { Annotation } from '../src/render/annotate/types';
import type { Measurement } from '../src/render/measure/types';

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────

describe('templates', () => {
  it('ships six report templates (v0.3.6 added Scan Acceptance)', () => {
    expect(REPORT_TEMPLATES.length).toBe(6);
    const ids = REPORT_TEMPLATES.map((t) => t.id);
    expect(ids).toContain('engineering-inspection');
    expect(ids).toContain('qa-validation');
    expect(ids).toContain('terrain-review');
    expect(ids).toContain('survey-summary');
    expect(ids).toContain('technical-documentation');
    expect(ids).toContain('scan-acceptance');
  });

  it('default template id resolves to a valid template', () => {
    expect(getReportTemplate(DEFAULT_TEMPLATE_ID)).toBeDefined();
  });

  it('every template starts with a cover and ends with a footer', () => {
    for (const t of REPORT_TEMPLATES) {
      expect(t.sections[0]).toBe('cover');
      expect(t.sections[t.sections.length - 1]).toBe('footer');
    }
  });

  it('every template carries a non-empty label + description', () => {
    for (const t of REPORT_TEMPLATES) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it('engineering-inspection includes measurements + annotations + visuals + technical notes', () => {
    const t = getReportTemplate('engineering-inspection');
    expect(t).toBeDefined();
    if (!t) return;
    expect(t.sections).toContain('measurements');
    expect(t.sections).toContain('annotations');
    expect(t.sections).toContain('visuals');
    expect(t.sections).toContain('technical-notes');
  });

  it('qa-validation skips measurements + technical notes (compact)', () => {
    const t = getReportTemplate('qa-validation');
    expect(t).toBeDefined();
    if (!t) return;
    expect(t.sections).not.toContain('measurements');
    expect(t.sections).not.toContain('technical-notes');
  });

  it('terrain-review omits annotations (no inspection rows)', () => {
    const t = getReportTemplate('terrain-review');
    expect(t).toBeDefined();
    if (!t) return;
    expect(t.sections).not.toContain('annotations');
  });

  it('getReportTemplate returns undefined for an unknown id', () => {
    expect(getReportTemplate('not-a-template' as never)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Branding
// ─────────────────────────────────────────────────────────────────────────────

describe('branding', () => {
  it('DEFAULT_ACCENT is the live-UI accent (#00b2ff)', () => {
    expect(DEFAULT_ACCENT).toBe('#00b2ff');
  });

  it('parseAccentColor returns the default for missing / malformed input', () => {
    const def = parseAccentColor();
    expect(def.r).toBeCloseTo(0x00 / 255, 3);
    expect(def.g).toBeCloseTo(0xb2 / 255, 3);
    expect(def.b).toBeCloseTo(0xff / 255, 3);
    expect(parseAccentColor('not-a-color')).toEqual(def);
    expect(parseAccentColor('')).toEqual(def);
  });

  it('parseAccentColor handles 6-digit hex with and without leading #', () => {
    const a = parseAccentColor('#336699');
    const b = parseAccentColor('336699');
    expect(a).toEqual(b);
    expect(a.r).toBeCloseTo(0x33 / 255, 3);
    expect(a.g).toBeCloseTo(0x66 / 255, 3);
    expect(a.b).toBeCloseTo(0x99 / 255, 3);
  });

  it('parseAccentColor expands 3-digit short form', () => {
    const short = parseAccentColor('#abc');
    const long = parseAccentColor('#aabbcc');
    expect(short).toEqual(long);
  });

  it('effectiveBranding merges overrides over defaults', () => {
    const merged = effectiveBranding({ organisation: 'Acme', accentColor: '#ff0066' });
    expect(merged.organisation).toBe('Acme');
    expect(merged.accentColor).toBe('#ff0066');
  });

  it('effectiveBranding fills accentColor when caller omits it', () => {
    const merged = effectiveBranding({ organisation: 'Acme' });
    expect(merged.accentColor).toBe(DEFAULT_ACCENT);
  });

  it('v0.3.4 — effectiveBranding carries the new white-label fields through', () => {
    const merged = effectiveBranding({
      organisation: 'Acme',
      author: 'J. Smith',
      footerNote: 'Confidential — for internal use only',
      projectMetadata: {
        client: 'Hudson Bridge Authority',
        project: 'Pier-7 Re-inspection',
        phase: 'As-built',
        reference: 'HBA-2026-014',
        date: '2026-05-27',
      },
      theme: 'minimal-engineering',
    });
    expect(merged.organisation).toBe('Acme');
    expect(merged.author).toBe('J. Smith');
    expect(merged.footerNote).toMatch(/Confidential/);
    expect(merged.projectMetadata?.client).toBe('Hudson Bridge Authority');
    expect(merged.projectMetadata?.reference).toBe('HBA-2026-014');
    expect(merged.theme).toBe('minimal-engineering');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Themes (v0.3.4)
// ─────────────────────────────────────────────────────────────────────────────

describe('themes (v0.3.4)', () => {
  it('resolveTheme returns the light-technical palette by default', async () => {
    const { resolveTheme } = await import('../src/report');
    const t = resolveTheme();
    // light-technical: white page, dark body text, accent stripe on.
    expect(t.pageBackground.r).toBeCloseTo(1, 3);
    expect(t.bodyText.r).toBeLessThan(0.2);
    expect(t.drawAccentStripe).toBe(true);
  });

  it('resolveTheme("dark-inspection") returns a dark palette', async () => {
    const { resolveTheme } = await import('../src/report');
    const t = resolveTheme('dark-inspection');
    expect(t.pageBackground.r).toBeLessThan(0.2);
    // body text on dark must be light.
    expect(t.bodyText.r).toBeGreaterThan(0.8);
    expect(t.drawAccentStripe).toBe(true);
  });

  it('resolveTheme("minimal-engineering") strips the accent stripe', async () => {
    const { resolveTheme } = await import('../src/report');
    const t = resolveTheme('minimal-engineering');
    expect(t.drawAccentStripe).toBe(false);
    // page background still white.
    expect(t.pageBackground.r).toBeCloseTo(1, 3);
  });

  it('resolveTheme falls back to light-technical for an unknown theme name', async () => {
    const { resolveTheme } = await import('../src/report');
    // @ts-expect-error — runtime guard against an unknown name
    const t = resolveTheme('not-a-theme');
    const light = resolveTheme('light-technical');
    expect(t).toEqual(light);
  });

  it('every palette has body/muted text contrast against its page background', async () => {
    const { resolveTheme } = await import('../src/report');
    for (const name of ['light-technical', 'dark-inspection', 'minimal-engineering'] as const) {
      const t = resolveTheme(name);
      // Contrast invariant: body text differs from page background by more
      // than 0.3 in each channel (a coarse-but-useful WCAG-adjacent check).
      const delta =
        Math.abs(t.bodyText.r - t.pageBackground.r) +
        Math.abs(t.bodyText.g - t.pageBackground.g) +
        Math.abs(t.bodyText.b - t.pageBackground.b);
      expect(delta, `theme ${name}: body/page delta`).toBeGreaterThan(0.9);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dataset summary
// ─────────────────────────────────────────────────────────────────────────────

describe('buildDatasetSummary', () => {
  it('rows render in the canonical order', () => {
    const rows = buildDatasetSummary({
      fileName: 'scan.copc.laz',
      format: 'COPC',
      sourcePointCount: 1_234_567,
      width: 78.8,
      depth: 124.4,
      height: 18.9,
      density: 379,
      hasRgb: true,
      hasIntensity: true,
      hasClassification: true,
    });
    expect(rows[0].label).toBe('File');
    expect(rows[1].label).toBe('Format');
    expect(rows[2].label).toBe('Points');
    expect(rows[3].label).toBe('Width');
    expect(rows[4].label).toBe('Depth');
    expect(rows[5].label).toBe('Height');
    expect(rows[6].label).toBe('Density');
    expect(rows[7].label).toBe('RGB');
  });

  it('formats point count with locale separators', () => {
    const rows = buildDatasetSummary({
      fileName: 'scan',
      format: 'COPC',
      sourcePointCount: 9_600_000,
      width: 10, depth: 10, height: 5,
      density: NaN,
      hasRgb: false, hasIntensity: true, hasClassification: true,
    });
    const points = rows.find((r) => r.label === 'Points');
    expect(points?.value).toBe('9,600,000');
  });

  it('formats metres by magnitude (km / m / cm)', () => {
    const rows = buildDatasetSummary({
      fileName: 's', format: 'COPC', sourcePointCount: 100,
      width: 2500,    // → 2.50 km
      depth: 78.8,    // → 78.8 m
      height: 0.05,   // → 5.0 cm
      density: NaN,
      hasRgb: false, hasIntensity: false, hasClassification: false,
    });
    expect(rows.find((r) => r.label === 'Width')?.value).toBe('2.50 km');
    expect(rows.find((r) => r.label === 'Depth')?.value).toBe('78.8 m');
    expect(rows.find((r) => r.label === 'Height')?.value).toBe('5.0 cm');
  });

  it('omits CRS rows when not supplied', () => {
    const rows = buildDatasetSummary({
      fileName: 's', format: 'PLY', sourcePointCount: 100,
      width: 10, depth: 10, height: 5,
      density: NaN,
      hasRgb: false, hasIntensity: false, hasClassification: false,
    });
    expect(rows.find((r) => r.label === 'CRS')).toBeUndefined();
    expect(rows.find((r) => r.label === 'Units')).toBeUndefined();
  });

  it('includes CRS + Units rows when supplied', () => {
    const rows = buildDatasetSummary({
      fileName: 's', format: 'COPC', sourcePointCount: 100,
      width: 10, depth: 10, height: 5,
      density: NaN,
      hasRgb: false, hasIntensity: false, hasClassification: true,
      crsName: 'WGS 84 / UTM zone 12N (EPSG:32612)',
      crsUnit: 'metre',
    });
    expect(rows.find((r) => r.label === 'CRS')?.value).toMatch(/UTM zone 12N/);
    expect(rows.find((r) => r.label === 'Units')?.value).toBe('metre');
  });

  it('omits Density row when unknown', () => {
    const rows = buildDatasetSummary({
      fileName: 's', format: 'COPC', sourcePointCount: 100,
      width: 10, depth: 10, height: 5,
      density: NaN,
      hasRgb: false, hasIntensity: false, hasClassification: false,
    });
    expect(rows.find((r) => r.label === 'Density')).toBeUndefined();
  });

  // ── Streaming-preview "Loaded" row (COPC / EPT mid-stream disclosure) ────────
  it('adds a Loaded row directly after Points when streamingResident is present', () => {
    const rows = buildDatasetSummary({
      fileName: '2485_1109.copc.laz', format: 'COPC',
      sourcePointCount: 15_700_000,
      width: 1000, depth: 1000, height: 138,
      density: 16,
      hasRgb: false, hasIntensity: true, hasClassification: false,
      streamingResident: { points: 4_200_000, nodes: 70, totalNodes: 485 },
    });
    const pointsIdx = rows.findIndex((r) => r.label === 'Points');
    const loaded = rows[pointsIdx + 1];
    expect(loaded.label).toBe('Loaded');
    // Compact counts, percentage, node fraction, and the preview caveat.
    expect(loaded.value).toContain('4.2M of 15.7M pts');
    expect(loaded.value).toContain('27%');           // 4.2M / 15.7M ≈ 26.75% → 27%
    expect(loaded.value).toContain('70/485 nodes');
    expect(loaded.value).toContain('streaming preview');
  });

  it('omits the Loaded row for static scans (no streamingResident)', () => {
    const rows = buildDatasetSummary({
      fileName: 's.las', format: 'LAS', sourcePointCount: 1_000_000,
      width: 10, depth: 10, height: 5, density: 100,
      hasRgb: false, hasIntensity: true, hasClassification: true,
    });
    expect(rows.find((r) => r.label === 'Loaded')).toBeUndefined();
    // Canonical order intact: Points → Width.
    const pointsIdx = rows.findIndex((r) => r.label === 'Points');
    expect(rows[pointsIdx + 1].label).toBe('Width');
  });

  it('omits the Loaded row when zero points are resident yet', () => {
    const rows = buildDatasetSummary({
      fileName: 's.copc.laz', format: 'COPC', sourcePointCount: 9_000_000,
      width: 10, depth: 10, height: 5, density: 90,
      hasRgb: false, hasIntensity: true, hasClassification: false,
      streamingResident: { points: 0, nodes: 0, totalNodes: 485 },
    });
    expect(rows.find((r) => r.label === 'Loaded')).toBeUndefined();
  });

  // ── Class-filter honesty row (escape-hatch closure) ────────────────────────
  const baseInputs = {
    fileName: 'scan.copc.laz',
    format: 'COPC' as const,
    sourcePointCount: 1_000,
    width: 10, depth: 10, height: 5,
    density: 10,
    hasRgb: true, hasIntensity: true, hasClassification: true,
  };

  it('no class filter ⇒ rows are byte-identical to the unstamped output', () => {
    const base = buildDatasetSummary(baseInputs);
    // Absent, empty, and whitespace-only notes all mean "no active filter".
    expect(JSON.stringify(buildDatasetSummary({ ...baseInputs, classScopeNote: undefined }))).toBe(
      JSON.stringify(base),
    );
    expect(JSON.stringify(buildDatasetSummary({ ...baseInputs, classScopeNote: '' }))).toBe(
      JSON.stringify(base),
    );
    expect(JSON.stringify(buildDatasetSummary({ ...baseInputs, classScopeNote: '   ' }))).toBe(
      JSON.stringify(base),
    );
    // No honesty row leaked in.
    expect(base.find((r) => r.label === 'Class filter')).toBeUndefined();
  });

  it('active class filter ⇒ prepends a full-cloud disclosure row before the figures', () => {
    const rows = buildDatasetSummary({
      ...baseInputs,
      classScopeNote: 'Ground + Building · 2 of 5 classes',
    });
    // The honesty row is first, qualifying everything below it.
    expect(rows[0].label).toBe('Class filter');
    expect(rows[0].value).toContain('Ground + Building · 2 of 5 classes');
    expect(rows[0].value).toContain('full-cloud');
    // The canonical figure rows still follow in order.
    expect(rows[1].label).toBe('File');
    expect(rows[2].label).toBe('Format');
    expect(rows[3].label).toBe('Points');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Annotation rows
// ─────────────────────────────────────────────────────────────────────────────

describe('buildAnnotationRows', () => {
  const sampleAnnotations: Annotation[] = [
    {
      id: '1', title: 'Crack', type: 'issue', createdAt: 3000, updatedAt: 3000,
      localPosition: { x: 1, y: 2, z: 3 },
    },
    {
      id: '2', title: 'Note about column', type: 'note', createdAt: 1000, updatedAt: 1000,
      localPosition: { x: 10, y: 20, z: 30 },
      worldPosition: { x: 510, y: 520, z: 530 },
    },
    {
      id: '3', title: 'Settling observed', type: 'warning', createdAt: 2000, updatedAt: 2000,
      localPosition: { x: 5, y: 5, z: 5 },
    },
  ];

  it('default sort is chronological (createdAt asc)', () => {
    const rows = buildAnnotationRows(sampleAnnotations);
    expect(rows.map((r) => r.title)).toEqual(['Note about column', 'Settling observed', 'Crack']);
  });

  it('sortBy: type → issue first, then warning, info, note', () => {
    const rows = buildAnnotationRows(sampleAnnotations, { sortBy: 'type' });
    expect(rows.map((r) => r.title)).toEqual(['Crack', 'Settling observed', 'Note about column']);
  });

  it('prefers worldPosition over localPosition when present', () => {
    const rows = buildAnnotationRows(sampleAnnotations);
    const note = rows.find((r) => r.title === 'Note about column');
    expect(note?.position).toEqual({ x: 510, y: 520, z: 530 });
  });

  it('falls back to localPosition when worldPosition is absent', () => {
    const rows = buildAnnotationRows(sampleAnnotations);
    const crack = rows.find((r) => r.title === 'Crack');
    expect(crack?.position).toEqual({ x: 1, y: 2, z: 3 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Measurement rows
// ─────────────────────────────────────────────────────────────────────────────

describe('buildMeasurementRows', () => {
  const measurements: Measurement[] = [
    { id: 'd1', kind: 'distance', name: 'Wall length', points: [[0, 0, 0], [10, 0, 0]] },
    { id: 'a1', kind: 'area', name: 'Roof', points: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]] },
    { id: 'h1', kind: 'height', name: 'Floor to ceiling', points: [[0, 0, 0], [0, 0, 3]] },
  ];

  it('formats metric values correctly', () => {
    const rows = buildMeasurementRows(measurements, 'metric');
    expect(rows[0].value).toBe('10.00 m');
    expect(rows[1].value).toBe('100.00 m²');
    expect(rows[2].value).toBe('3.00 m');
  });

  it('formats imperial values correctly', () => {
    const rows = buildMeasurementRows(measurements, 'imperial');
    expect(rows[0].value).toMatch(/ft$/);
    // Area is single-sourced from the live measurement formatter (ft² / acre),
    // so the report reads the same units the overlay showed.
    expect(rows[1].value).toMatch(/(ft²|acre)$/);
    expect(rows[2].value).toMatch(/ft$/);
  });

  it('reports name + kind + point count per row', () => {
    const rows = buildMeasurementRows(measurements, 'metric');
    expect(rows[0]).toMatchObject({
      name: 'Wall length', kind: 'distance', pointCount: 2,
    });
  });

  it('handles malformed measurements without crashing', () => {
    const broken: Measurement[] = [
      { id: 'x', kind: 'distance', name: 'Empty', points: [] },
    ];
    const rows = buildMeasurementRows(broken, 'metric');
    expect(rows[0].value).toBe('—');
  });

  // ── unitToMetres factor (v0.4.5 measure-unit fix, report boundary) ────────
  // Measurement points are RENDER units; on a foot-based CRS the report must
  // apply the same linearUnitToMetres factor the live readouts use — lengths
  // ×f, areas ×f², volumes ×f³ — exactly once, at the formatting boundary.
  describe('unitToMetres factor', () => {
    const FT = 0.3048; // international foot → metres

    it('scales lengths ×f: a 10 ft span reads 3.05 m, not 10 m', () => {
      const rows = buildMeasurementRows(measurements, 'metric', FT);
      expect(rows[0].value).toBe('3.05 m'); // 10 ft × 0.3048
      expect(rows[2].value).toBe('91.4 cm'); // 3 ft height
    });

    it('scales areas ×f²: a 10×10 ft footprint reads 9.29 m²', () => {
      const rows = buildMeasurementRows(measurements, 'metric', FT);
      expect(rows[1].value).toBe('9.29 m²'); // 100 sq ft × 0.3048²
    });

    it('round-trips imperial: a 10 ft span on a foot CRS reads 10.00 ft', () => {
      const rows = buildMeasurementRows(measurements, 'imperial', FT);
      expect(rows[0].value).toBe('10.00 ft');
    });

    it('scales volumes ×f³ (box and cut/fill)', () => {
      const vols: Measurement[] = [
        { id: 'b1', kind: 'box', name: 'Box', points: [[0, 0, 0], [2, 3, 4]] },
        {
          id: 'v1',
          kind: 'volume',
          name: 'Pad',
          points: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]],
          volume: {
            fill: 24,
            cut: 0,
            net: 24,
            referenceZ: 0,
            footprintArea: 100,
            pointsInPolygon: 400,
            density: 4,
            confidence: 'medium',
          },
        },
      ];
      const rows = buildMeasurementRows(vols, 'metric', FT);
      // 24 cu render-units × 0.3048³ = 0.679604… m³
      expect(rows[0].value).toBe('0.68 m³');
      expect(rows[1].value).toContain('9.29 m²'); // footprint ×f²
      expect(rows[1].value).toContain('+0.68 m³ fill'); // fill ×f³
    });

    it('leaves ratios (slope / angle) unscaled', () => {
      const ratios: Measurement[] = [
        { id: 's1', kind: 'slope', name: 'Ramp', points: [[0, 0, 0], [10, 0, 1]] },
        { id: 'g1', kind: 'angle', name: 'Corner', points: [[1, 0, 0], [0, 0, 0], [0, 1, 0]] },
      ];
      const metric = buildMeasurementRows(ratios, 'metric');
      const scaled = buildMeasurementRows(ratios, 'metric', FT);
      expect(scaled[0].value).toBe(metric[0].value); // 10.00%
      expect(scaled[1].value).toBe(metric[1].value); // 90.0°
    });

    it('defaults to 1 and rejects a degenerate factor (0 / NaN) honestly', () => {
      const plain = buildMeasurementRows(measurements, 'metric');
      expect(buildMeasurementRows(measurements, 'metric', 1)).toEqual(plain);
      expect(buildMeasurementRows(measurements, 'metric', 0)).toEqual(plain);
      expect(buildMeasurementRows(measurements, 'metric', Number.NaN)).toEqual(plain);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Asset composer
// ─────────────────────────────────────────────────────────────────────────────

describe('composeReportInputs', () => {
  it('uses DEFAULT_TEMPLATE_ID when no templateId is supplied', () => {
    const inputs = composeReportInputs({
      title: 'Test',
      metadata: {
        fileName: 'scan.copc.laz', format: 'COPC',
        sourcePointCount: 100, width: 10, depth: 10, height: 5,
        density: NaN, hasRgb: false, hasIntensity: true, hasClassification: true,
      },
      visuals: [],
      annotations: [],
      measurements: [],
      unitSystem: 'metric',
    });
    expect(inputs.templateId).toBe(DEFAULT_TEMPLATE_ID);
  });

  it('qa-validation default sorts annotations by type', () => {
    const annotations: Annotation[] = [
      { id: '1', title: 'A', type: 'note', createdAt: 1, updatedAt: 1, localPosition: { x: 0, y: 0, z: 0 } },
      { id: '2', title: 'B', type: 'issue', createdAt: 2, updatedAt: 2, localPosition: { x: 0, y: 0, z: 0 } },
    ];
    const inputs = composeReportInputs({
      templateId: 'qa-validation',
      title: 'QA',
      metadata: {
        fileName: 'scan', format: 'COPC',
        sourcePointCount: 100, width: 10, depth: 10, height: 5,
        density: NaN, hasRgb: false, hasIntensity: true, hasClassification: true,
      },
      visuals: [],
      annotations,
      measurements: [],
      unitSystem: 'metric',
    });
    expect(inputs.annotations[0].title).toBe('B'); // issue before note
  });

  it('non-qa templates default to chronological annotations', () => {
    const annotations: Annotation[] = [
      { id: '1', title: 'A', type: 'issue', createdAt: 2, updatedAt: 2, localPosition: { x: 0, y: 0, z: 0 } },
      { id: '2', title: 'B', type: 'note', createdAt: 1, updatedAt: 1, localPosition: { x: 0, y: 0, z: 0 } },
    ];
    const inputs = composeReportInputs({
      templateId: 'engineering-inspection',
      title: 'Eng',
      metadata: {
        fileName: 'scan', format: 'COPC',
        sourcePointCount: 100, width: 10, depth: 10, height: 5,
        density: NaN, hasRgb: false, hasIntensity: true, hasClassification: true,
      },
      visuals: [],
      annotations,
      measurements: [],
      unitSystem: 'metric',
    });
    expect(inputs.annotations[0].title).toBe('B'); // older first regardless of type
  });

  it('cover.datasetName comes from the metadata fileName', () => {
    const inputs = composeReportInputs({
      title: 'X',
      metadata: {
        fileName: 'survey-2026.copc.laz', format: 'COPC',
        sourcePointCount: 1, width: 1, depth: 1, height: 1,
        density: NaN, hasRgb: false, hasIntensity: false, hasClassification: false,
      },
      visuals: [],
      annotations: [],
      measurements: [],
      unitSystem: 'metric',
    });
    expect(inputs.cover.datasetName).toBe('survey-2026.copc.laz');
  });

  it('cover.exportedAt is a valid ISO timestamp', () => {
    const inputs = composeReportInputs({
      title: 'X',
      metadata: {
        fileName: 's', format: 'COPC',
        sourcePointCount: 1, width: 1, depth: 1, height: 1,
        density: NaN, hasRgb: false, hasIntensity: false, hasClassification: false,
      },
      visuals: [],
      annotations: [],
      measurements: [],
      unitSystem: 'metric',
    });
    expect(() => new Date(inputs.cover.exportedAt)).not.toThrow();
    expect(new Date(inputs.cover.exportedAt).toString()).not.toBe('Invalid Date');
  });

  it('scan-acceptance template auto-derives metadata-only acceptance rows when none supplied', () => {
    // Regression for v0.3.6.x: before this change, picking the
    // scan-acceptance template from the Inspector dropdown produced a
    // PDF with an empty acceptance-checklist section because the
    // composer never wired any acceptanceChecks. The composer now
    // derives five presence-check rows from the loaded scan's
    // metadata so the template is meaningful straight from the UI.
    const inputs = composeReportInputs({
      templateId: 'scan-acceptance',
      title: 'Acceptance',
      metadata: {
        fileName: 'east-levee.copc.laz',
        format: 'COPC',
        sourcePointCount: 12_400_000,
        width: 100,
        depth: 100,
        height: 12,
        density: 1240,
        hasRgb: true,
        hasIntensity: true,
        hasClassification: false,
        crsName: 'EPSG:32612',
        crsUnit: 'metre',
      },
      visuals: [],
      annotations: [],
      measurements: [],
      unitSystem: 'metric',
    });
    expect(inputs.acceptanceChecks).toBeDefined();
    expect(inputs.acceptanceChecks?.length).toBe(5);
    const labels = inputs.acceptanceChecks?.map((r) => r.label) ?? [];
    expect(labels).toEqual([
      'Point count',
      'CRS declared',
      'RGB channel',
      'Classification channel',
      'Intensity channel',
    ]);
    // Point count row passes when sourcePointCount > 0.
    expect(inputs.acceptanceChecks?.[0]?.pass).toBe(true);
    // CRS row passes when crsName is set.
    expect(inputs.acceptanceChecks?.[1]?.pass).toBe(true);
    expect(inputs.acceptanceChecks?.[1]?.actual).toBe('EPSG:32612');
  });

  it('scan-acceptance template prefers caller-supplied acceptance rows over the defaults', () => {
    const explicit = [
      { label: 'Custom check', threshold: 'required', actual: 'present', pass: true },
    ];
    const inputs = composeReportInputs({
      templateId: 'scan-acceptance',
      title: 'Acceptance',
      metadata: {
        fileName: 's', format: 'COPC',
        sourcePointCount: 1, width: 1, depth: 1, height: 1,
        density: NaN, hasRgb: false, hasIntensity: false, hasClassification: false,
      },
      visuals: [],
      annotations: [],
      measurements: [],
      unitSystem: 'metric',
      acceptanceChecks: explicit,
    });
    expect(inputs.acceptanceChecks?.length).toBe(1);
    expect(inputs.acceptanceChecks?.[0]?.label).toBe('Custom check');
  });

  it('non-acceptance templates do NOT auto-derive acceptance rows', () => {
    const inputs = composeReportInputs({
      templateId: 'engineering-inspection',
      title: 'Eng',
      metadata: {
        fileName: 's', format: 'COPC',
        sourcePointCount: 1, width: 1, depth: 1, height: 1,
        density: NaN, hasRgb: false, hasIntensity: false, hasClassification: false,
      },
      visuals: [],
      annotations: [],
      measurements: [],
      unitSystem: 'metric',
    });
    expect(inputs.acceptanceChecks).toBeUndefined();
  });
});
