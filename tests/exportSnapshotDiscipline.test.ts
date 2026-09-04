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

/** The body of an exported async function, to its closing brace at col 0. */
function fnBody(src: string, name: string): string {
  const at = src.indexOf(`export async function ${name}`);
  expect(at, `${name} not found`).toBeGreaterThan(-1);
  const rest = src.slice(at);
  const end = rest.indexOf('\n}\n');
  return rest.slice(0, end === -1 ? rest.length : end);
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
