/**
 * Evidence-bearing exports must not read live application state after their
 * first await.
 *
 * Each of these loads a lazy chunk partway through. Anything read after that
 * await belongs to whatever scan is active when the chunk resolves, not to the
 * scan the export is about — so a swap during the import produced one file
 * describing two scans. The rule is: snapshot everything, await, serialize only
 * the snapshot; or snapshot the target, await, assert it is unchanged, then
 * mutate. Never a mixture.
 *
 * Source-level, because the defect is the ORDER of reads around an await, which
 * a behavioural test would have to win a race to observe.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const strip = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

const read = (rel: string): string => strip(readFileSync(resolve(__dirname, '..', rel), 'utf8'));
const MEASURE = read('src/app/measurementExportActions.ts');
const KML = read('src/app/kmlActions.ts');
const SESSION = read('src/app/sessionIo.ts');
const VIEWER = read('src/render/Viewer.ts');
const BASEMODE = read('src/export/BaseExportMode.ts');
const MEASUREPANEL = read('src/ui/MeasurePanel.ts');
const ANALYSE = read('src/ui/AnalysePanel.ts');
const MAIN = read('src/main.ts');

/** The body of an exported async function, to its closing brace at col 0. */
function fnBody(src: string, name: string): string {
  const at = src.indexOf(`export async function ${name}`);
  expect(at, `${name} not found`).toBeGreaterThan(-1);
  const rest = src.slice(at);
  const end = rest.indexOf('\n}\n');
  return rest.slice(0, end === -1 ? rest.length : end);
}

/** A class method's body, cut at the next member so a window cannot overrun. */
function memberBody(src: string, signature: string): string {
  const at = src.indexOf(signature);
  expect(at, `${signature} not found`).toBeGreaterThan(-1);
  const rest = src.slice(at + signature.length);
  const next = rest.search(/\n  (private|public|protected|async|[A-Za-z_]+\()/);
  return rest.slice(0, next === -1 ? rest.length : next);
}

/** Everything after the first `await` in a body. */
function afterFirstAwait(body: string): string {
  const at = body.indexOf('await ');
  expect(at, 'no await in body').toBeGreaterThan(-1);
  return body.slice(at);
}

describe('measurement reports sign one scan, not two', () => {
  it('the integrity report reads no live frame state after its import', () => {
    const after = afterFirstAwait(fnBody(MEASURE, 'exportMeasurementIntegrityReport'));
    for (const live of [
      'measure.worldUp',
      'measure.unitToMetres',
      'measure.verticalUnitToMetres',
      'measure.crsKnown',
      'deps.activeClassificationEpoch()',
    ]) {
      expect(after, `${live} read after the await`).not.toContain(live);
    }
  });

  it('the findings conversion captures the frame with the measurements', () => {
    const after = afterFirstAwait(fnBody(MEASURE, 'collectMeasurementFindings'));
    expect(after).not.toContain('measure.worldUp');
    expect(after).not.toContain('measure.unitToMetres');
  });

  it('the findings report captures its epoch and unit-known flag first', () => {
    const after = afterFirstAwait(fnBody(MEASURE, 'exportFindingsReport'));
    expect(after).not.toContain('deps.activeClassificationEpoch()');
    expect(after).not.toContain('deps.measure.crsKnown');
  });
});

describe('scan-area KML draws one scan', () => {
  it('reads the hull with the CRS and extent it belongs to', () => {
    const after = afterFirstAwait(fnBody(KML, 'exportScanFootprintKml'));
    // A hull read after the loader gave B's polygon under A's CRS and extent.
    expect(after).not.toContain('deps.scanHullPositions()');
  });
});

describe('session import never attaches one scan’s work to another', () => {
  it('asserts the target after every await that precedes a mutation', () => {
    const src = SESSION;
    const guardAt = src.indexOf('const targetChanged = ()');
    expect(guardAt, 'shared predicate missing').toBeGreaterThan(-1);
    // Two assertion sites: one before the CRS commit, one after the ownership
    // import — which yields again immediately before the viewer is mutated.
    expect((src.match(/if \(targetChanged\(\)\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    const afterOwnership = src.slice(src.indexOf('await loadSessionOwnership()'));
    const mutateAt = afterOwnership.indexOf('viewer.measure.loadMeasurements(');
    const checkAt = afterOwnership.indexOf('if (targetChanged())');
    expect(checkAt, 'no check after the ownership await').toBeGreaterThan(-1);
    expect(checkAt, 'check must precede the mutation').toBeLessThan(mutateAt);
  });
});

describe('figure and report exports describe the scan they captured', () => {
  it('the export adapter is built before the Studio chunk loads', () => {
    // Built after, it described whatever scan was active when the chunk
    // resolved: the caller's filename came from A, the pixels and report from B.
    const at = VIEWER.indexOf('async exportImage(');
    expect(at).toBeGreaterThan(-1);
    const body = VIEWER.slice(at, at + 700);
    const adapterAt = body.indexOf('_buildExportAdapter()');
    const awaitAt = body.indexOf('await loadExportStudio()');
    expect(adapterAt).toBeGreaterThan(-1);
    expect(awaitAt).toBeGreaterThan(-1);
    expect(adapterAt, 'adapter must be built before the await').toBeLessThan(awaitAt);
  });

  it('figure provenance is sourced when the pixels are taken', () => {
    // Read after the compositing awaits, a view change or scan swap while the
    // report and banner were drawn stamped another view's camera and CRS.
    const captureAt = BASEMODE.indexOf('const blob = capture.blob;');
    const stampAt = BASEMODE.indexOf('stampFigureProvenanceOntoBlob(');
    expect(captureAt).toBeGreaterThan(-1);
    const between = BASEMODE.slice(captureAt, stampAt);
    expect(between).toMatch(/figureViewContext\?\.\(\)/);
    expect(between).toMatch(/adapter\.crsLabel\(\)/);
    // ...and not re-read at stamping time.
    expect(BASEMODE.slice(stampAt)).not.toMatch(/adapter\.crsLabel\(\)/);
  });

  it('the profile sheet captures its CRS and unit system first', () => {
    const body = memberBody(MEASUREPANEL, 'private async _buildProfileSheet(');
    const awaitAt = body.indexOf('await loadProfilePdf()');
    expect(awaitAt).toBeGreaterThan(-1);
    expect(body.slice(awaitAt)).not.toMatch(/getProfileExportContext\(\)/);
    expect(body.slice(awaitAt)).not.toMatch(/getUnitSystem\(\)/);
  });

  it('the terrain report captures the Inspector summary first', () => {
    // Anchored on the DEFINITION and cut at the next member: the first mention
    // is a call site, and a fixed window overran into a sibling method that
    // legitimately reads live state at render time.
    const body = memberBody(ANALYSE, 'private async _exportTerrainReport(');
    const awaitAt = body.indexOf('await loadTerrainReportPdf()');
    expect(awaitAt).toBeGreaterThan(-1);
    expect(body.slice(awaitAt)).not.toMatch(/getDatasetIntelligence\?\.\(\)/);
  });

  it('the plain snapshot captures scope and view with the pixels', () => {
    const at = MAIN.indexOf('composeClassScopeBannerOntoBlob(blob');
    expect(at).toBeGreaterThan(-1);
    const after = MAIN.slice(at);
    const studioAt = after.indexOf('await loadExportStudio()');
    expect(studioAt).toBeGreaterThan(-1);
    expect(after.slice(studioAt)).not.toMatch(/viewer\.figureViewContext\(\)/);
  });
});
