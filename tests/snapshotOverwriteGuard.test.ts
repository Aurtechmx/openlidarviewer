/**
 * snapshotOverwriteGuard.test.ts — the validation-snapshot builder must not wipe
 * the frozen baseline by default.
 *
 * The committed validation/snapshot/ is a frozen baseline. A plain
 * `npm run validation:snapshot` used to rmSync it and rebuild from the current
 * tree, destroying the baseline. refuseInPlaceOverwrite guards that: it refuses
 * only the accidental case — no explicit --out, the baseline already exists, and
 * no --force — while an explicit --out or --force proceeds.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs build script, no types
import { refuseInPlaceOverwrite } from '../scripts/build-validation-snapshot.mjs';

describe('refuseInPlaceOverwrite', () => {
  it('refuses the accidental in-place rebuild (no --out, baseline exists, no --force)', () => {
    expect(refuseInPlaceOverwrite({ outPassed: false, exists: true, force: false })).toBe(true);
  });

  it('proceeds when the baseline does not exist yet', () => {
    expect(refuseInPlaceOverwrite({ outPassed: false, exists: false, force: false })).toBe(false);
  });

  it('proceeds with an explicit --out even when a baseline exists', () => {
    expect(refuseInPlaceOverwrite({ outPassed: true, exists: true, force: false })).toBe(false);
  });

  it('proceeds with --force (an intentional in-place rebuild)', () => {
    expect(refuseInPlaceOverwrite({ outPassed: false, exists: true, force: true })).toBe(false);
  });
});
