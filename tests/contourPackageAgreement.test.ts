/**
 * contourPackageAgreement.test.ts: the files of one contour package agree with
 * each other. The DXF sits on the same coordinates as the native GeoJSON, the
 * PDF states the shares the README and Support.tif state, and Validation.json
 * does not call the CRS unknown when the package names it.
 */
import { describe, expect, it } from 'vitest';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import { buildContourDeliverableFromResultAsync, type DeliverableBuildOptions } from '../src/terrain/export/contourDeliverableBuild';
import { DTM_CLAIMS, validatedDecision } from './helpers/exportDecisions';
import { extractEntry } from './helpers/zipReader';
import { pdfText } from './e2e/pdfText';

const ORIGIN = { x: 549000, y: 4118000, z: 600 };

/** A hill with a hole in it, so some cells are filled and low in confidence. */
function points(): Float32Array {
  const p: number[] = [];
  for (let i = 0; i < 40; i += 0.5) for (let j = 0; j < 40; j += 0.5) {
    if (Math.hypot(i - 12, j - 12) < 5) continue;
    p.push(i, j, 6 * Math.exp(-((i - 22) ** 2 + (j - 22) ** 2) / 120));
  }
  return new Float32Array(p);
}

async function build(): Promise<{ zip: Uint8Array; text: (name: string) => string }> {
  const result = analyseContours(points(), {
    intervalM: 0.5, cellSizeM: 1, horizontalUnitToMetres: 1, verticalUnitToMetres: 1,
    contourStyle: 'generalized', crs: 'EPSG:6346', horizontalEpsg: 6346,
  } as Parameters<typeof analyseContours>[1]);
  const zip = await buildContourDeliverableFromResultAsync(result, {
    decision: validatedDecision(DTM_CLAIMS), basename: 'site', worldOrigin: ORIGIN, isGeographic: false,
    linearUnit: 'metre', verticalUnitToMetres: 1, softwareVersion: '0.7.2', metricVersion: 'v0.4.4',
    generatedAt: new Date('2026-01-01T00:00:00.000Z'), exportPermit: null,
  } as DeliverableBuildOptions);
  const text = (name: string): string => new TextDecoder().decode(extractEntry(zip, name)!);
  return { zip, text };
}

describe('contour package agreement', () => {
  it('writes the DXF on the same coordinates and heights as the GeoJSON', async () => {
    const { text } = await build();
    const lines = text('site_Contours_Cartographic.dxf').split(/\r?\n/);
    const at = (code: string): number[] => {
      const out: number[] = [];
      let inVertex = false;
      for (let i = 0; i + 1 < lines.length; i += 2) {
        const c = lines[i]!.trim();
        if (c === '0') inVertex = lines[i + 1]!.trim() === 'VERTEX' || lines[i + 1]!.trim() === 'LWPOLYLINE';
        else if (inVertex && c === code) out.push(Number(lines[i + 1]));
      }
      return out;
    };
    const gj = JSON.parse(text('site_Contours_Cartographic.geojson')) as { features: Array<{ properties: { elevation: number }; geometry: { coordinates: number[][] } }> };
    const pts = gj.features.flatMap((f) => f.geometry.coordinates);
    expect(pts.length).toBeGreaterThan(20);
    const xs = at('10'), ys = at('20');
    expect(Math.min(...xs)).toBeCloseTo(Math.min(...pts.map((p) => p[0]!)), 2);
    expect(Math.max(...ys)).toBeCloseTo(Math.max(...pts.map((p) => p[1]!)), 2);
    expect(Math.min(...xs)).toBeGreaterThan(ORIGIN.x - 1);
  });

  it('prints the same support shares in the PDF as in the README', async () => {
    const { zip, text } = await build();
    const pdf = await pdfText(extractEntry(zip, 'site_Contour_Report.pdf')!);
    for (const kind of ['Measured', 'Interpolated', 'Unsupported']) {
      const readme = Number(new RegExp(`${kind}:\\s+([\\d.]+)%`).exec(text('site_README.txt'))![1]);
      const printed = Number(new RegExp(`${kind}: ([\\d.]+)%`).exec(pdf)![1]);
      expect(printed, kind).toBeCloseTo(readme, 1);
    }
    expect(pdf).toContain('Source SHA-256:');
    expect(pdf).not.toContain('Source hash:');
  });

  it('does not call the CRS unknown in Validation.json when the package names it', async () => {
    const { text } = await build();
    expect(text('site_README.txt')).toContain('EPSG:6346');
    expect(text('site_Validation.json')).not.toContain('CRS unknown');
  });
});
