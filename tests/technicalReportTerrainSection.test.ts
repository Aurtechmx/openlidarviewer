/**
 * technicalReportTerrainSection.test.ts
 *
 * After a terrain analysis the Technical Report said vertical accuracy was
 * "Not evaluated in this report" and carried no terrain figures. It now has a
 * short Terrain analysis section with the figures the app already holds, each
 * named for what it is (an internal hold-out RMSEz, not a checkpoint test),
 * and its Min/Max elevation rows name a display-sample basis.
 */

import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { generateReport, composeReportInputs, getReportTemplate } from '../src/report';
import type { ReportInputs, ReportTemplateId } from '../src/report';
import { buildTerrainSummary, extentRows } from '../src/report/ReportMetadataSection';
import { terrainSummaryFacts } from '../src/app/reportExport';
import { computeTerrainCore, contoursFromCore } from '../src/terrain/contour/analyseContours';
import { defaultContourShapeStyle } from '../src/terrain/contour/contourShapeStyle';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

async function pdfText(inputs: ReportInputs): Promise<{ text: string; failed: readonly string[] }> {
  const result = await generateReport(inputs);
  const bytes = Buffer.from(await result.blob.arrayBuffer());
  const texts: string[] = [];
  for (const seg of bytes.toString('latin1').split(/stream\r?\n/).slice(1)) {
    let content: string;
    try {
      content = inflateSync(Buffer.from(seg.split('endstream')[0], 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    for (const m of content.matchAll(/<([0-9A-Fa-f]*)> Tj/g)) texts.push(Buffer.from(m[1], 'hex').toString('latin1'));
  }
  return { text: texts.join('\n'), failed: result.failedSections };
}

const FACTS = {
  rmseZM: 0.052, reliefM: 18.4, measuredOfCovered: 0.87, analysedPointCount: 300_000,
  loadedPointCount: 2_271_607, declaredPointCount: 210_887_303,
};

function inputs(templateId: ReportTemplateId, withTerrain: boolean): ReportInputs {
  return composeReportInputs({
    templateId, title: 'T',
    metadata: {
      fileName: 'a.laz', format: 'LAZ', sourcePointCount: 1000, width: 10, depth: 10, height: 2, density: 10,
      hasRgb: false, hasIntensity: false, hasClassification: true,
    },
    visuals: [], annotations: [], measurements: [], unitSystem: 'metric',
    ...(withTerrain ? { terrainSummaryFacts: FACTS } : {}),
  });
}

describe('Technical Report terrain section', () => {
  it('is part of the Technical Report template', () => {
    expect(getReportTemplate('technical-report')?.sections).toContain('terrain-summary');
  });

  it('states the hold-out RMSEz, relief, coverage and basis with plain labels', () => {
    const s = buildTerrainSummary(FACTS);
    const v = (label: string): string | undefined => s.rows.find((r) => r.label === label)?.value;
    expect(v('RMSEz (internal hold-out)')).toBe('0.05 m');
    expect(v('Bare-earth relief')).toBe('18.40 m');
    expect(v('Measured ground cells')).toBe('87 % of covered cells');
    expect(v('Basis')).toBe('300,000 points analysed, from the loaded display sample (2,271,607 of 210,887,303 points)');
    expect(s.note).toMatch(/not a check against independent ground control/);
  });

  it('renders in the PDF when an analysis ran, and is absent otherwise', async () => {
    const withIt = await pdfText(inputs('technical-report', true));
    expect(withIt.failed).toEqual([]);
    expect(withIt.text).toContain('Terrain analysis');
    expect(withIt.text).toContain('RMSEz (internal hold-out)');
    const without = await pdfText(inputs('technical-report', false));
    expect(without.failed).toEqual([]);
    expect(without.text).not.toContain('RMSEz (internal hold-out)');
  });

  it('reads its facts off a terrain result', () => {
    const pts: TerrainPoint[] = [];
    for (let j = 0; j < 40; j++) for (let i = 0; i < 40; i++) pts.push({ x: i / 2, y: j / 2, z: (i + j) / 20 });
    const result = contoursFromCore(computeTerrainCore(pts, {
      cellSizeM: 1, crs: 'EPSG:32610', horizontalUnitToMetres: 1, verticalUnitToMetres: 1, horizontalScaleKnown: true, verticalScaleKnown: true,
    }), {
      intervalM: 1, shapeStyle: defaultContourShapeStyle,
    });
    const f = terrainSummaryFacts(result, { pointCount: 1600, declaredPointCount: 1600 });
    expect(f.analysedPointCount).toBe(result.dtm.analyzedPointCount);
    expect(f.measuredOfCovered).toBeGreaterThan(0);
    expect(f.reliefM).toBeGreaterThan(0);
  });
});

describe('elevation rows on a display sample', () => {
  it('name the basis', () => {
    const rows = extentRows({ width: 10, depth: 10, height: 2, unitKnown: true, elevation: { min: 1, max: 3 }, elevationBasis: 'display sample' });
    expect(rows.map((r) => r.label)).toContain('Min elevation (display sample)');
    expect(rows.map((r) => r.label)).toContain('Max elevation (display sample)');
  });
});
