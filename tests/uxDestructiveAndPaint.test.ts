/**
 * uxDestructiveAndPaint.test.ts
 *
 * Two friction points that share a shape: the app did something the user could
 * not see coming, and something the user could not see happening.
 *
 * The layer row's `×` promised only "Remove … from the scene". On the last
 * layer it also cleared placed measurements, saved views and annotations, and
 * `MeasureController.clear()` takes no snapshot, so the measurements had no
 * undo. `removalClosesScan` is that rule as a predicate; the source assertion
 * below pins the handler to it, because the predicate on its own would pass
 * even if nothing called it.
 *
 * `openScan` writes "Preparing GPU buffers" and then "Rendering", and clears
 * both, with no await in between: the last await in the function is
 * `await viewer.ready`, well above the first of those writes. One task, so the
 * browser painted neither, and the user watched the previous line freeze
 * through the whole GPU attach. The assertions here read the source, since the
 * shell cannot be imported in Node and the defect is the ABSENCE of a yield
 * rather than a value any fake can observe.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { removalClosesScan } from '../src/ui/Inspector';

const ROOT = join(import.meta.dirname, '..');
const inspectorSrc = readFileSync(join(ROOT, 'src/ui/Inspector.ts'), 'utf8');
const openScanSrc = readFileSync(join(ROOT, 'src/app/openScan.ts'), 'utf8');

describe('removing a layer only warns when it closes the scan', () => {
  it('treats the last layer as a scan close', () => {
    expect(removalClosesScan(1)).toBe(true);
  });

  it('treats a removal that leaves layers behind as a plain removal', () => {
    for (const count of [2, 3, 12]) expect(removalClosesScan(count)).toBe(false);
  });

  it('errs toward warning when the count is somehow zero', () => {
    // A row exists, so the count should never be 0. If it is, the tree is not
    // what this code thinks it is, and a confirm is the safe side to be wrong on.
    expect(removalClosesScan(0)).toBe(true);
  });

  it('routes the row button through the rule and through the styled confirm', () => {
    const handler = inspectorSrc.slice(
      inspectorSrc.indexOf("remove.addEventListener('click'"),
      inspectorSrc.indexOf("const crs = el('span'"),
    );
    expect(handler).not.toBe('');
    expect(handler).toContain('removalClosesScan(this._layerRows.size)');
    expect(handler).toContain('openConfirm(');
    // The confirm has to name what is actually lost. A dialog that says only
    // "are you sure" would pass a shape check and tell the user nothing.
    expect(handler).toMatch(/measurements/i);
    expect(handler).toMatch(/cannot be restored/i);
  });

  it('never calls onRemove straight from the listener without passing the rule', () => {
    // The pre-fix listener was `() => this._cb.onRemove(id)` on one line.
    expect(inspectorSrc).not.toContain("remove.addEventListener('click', () => this._cb.onRemove(id));");
  });
});

describe('the attach phase yields so its status lines can paint', () => {
  /** Line index (0-based) of the single occurrence of `needle`. */
  function lineOf(needle: string): number {
    const lines = openScanSrc.split('\n');
    const at = lines.findIndex((l) => l.includes(needle));
    expect(at, `not found in openScan.ts: ${needle}`).toBeGreaterThan(-1);
    return at;
  }

  const lines = openScanSrc.split('\n');
  const readyAt = lineOf('await viewer.ready;');
  const uploadingAt = lineOf("formatProgress({ stage: 'uploading' })");
  const renderingAt = lineOf("formatProgress({ stage: 'rendering' })");
  const clearAt = lineOf('deps.dropZone.setProgress(null);');

  /** Does a `setTimeout` yield appear within `window` lines after `from`? */
  function yieldsWithin(from: number, window: number): boolean {
    return lines
      .slice(from + 1, from + 1 + window)
      .some((l) => l.includes('setTimeout(resolve'));
  }

  it('still has both attach status lines after the last natural await', () => {
    // If this fails the file was restructured and the guard below is measuring
    // the wrong region, which is worse than no guard.
    expect(uploadingAt).toBeGreaterThan(readyAt);
    expect(renderingAt).toBeGreaterThan(uploadingAt);
    expect(clearAt).toBeGreaterThan(renderingAt);
  });

  it('yields after "Preparing GPU buffers", before the GPU attach', () => {
    expect(yieldsWithin(uploadingAt, 14)).toBe(true);
  });

  it('yields after "Rendering", before framing and the first colour pass', () => {
    expect(yieldsWithin(renderingAt, 8)).toBe(true);
  });

  it('re-checks cancellation across the second gap', () => {
    // The dropzone's cancel handler stays live until the progress teardown, so
    // a user can cancel inside a gap the yield opened.
    const gap = lines.slice(renderingAt, renderingAt + 10).join('\n');
    expect(gap).toContain('controller.signal.aborted');
  });

  it('uses setTimeout rather than requestAnimationFrame for the yield', () => {
    // rAF resumes inside the same frame's rendering steps, so it still lands
    // before paint. The pre-compute yield in terrainAnalysisRunner uses
    // setTimeout for the same reason. Comment lines are stripped: the reason
    // above is written down in the source, and matching prose would make this
    // assert on a comment rather than on what runs.
    const code = lines
      .slice(uploadingAt, clearAt + 1)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).toContain('setTimeout(resolve');
    expect(code).not.toContain('requestAnimationFrame');
  });
});
