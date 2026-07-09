/**
 * exportEvidenceNote.test.ts — the shared evidence note routed through exporters.
 *
 * The note must be DERIVED from the one gate (not asserted): a below-threshold
 * product reads exploratory, a met-threshold product reads validated, and an
 * unregistered id is treated as exploratory (never silently validated).
 */
import { describe, it, expect } from 'vitest';
import { evidenceNote, isExploratoryExport } from '../src/validation/exportEvidenceNote';

describe('evidenceNote', () => {
  it('marks a below-required product exploratory', () => {
    // Every registered product is below E4 today, so all gate to exploratory.
    expect(evidenceNote('MEAS-DISTANCE')).toMatch(/exploratory/i);
    expect(evidenceNote('DTM')).toMatch(/exploratory/i);
    expect(isExploratoryExport('MEAS-AREA')).toBe(true);
  });

  it('marks a product that meets its required level validated', () => {
    // REPORT-DIGEST is E1 required E1 — it meets its bar.
    expect(evidenceNote('REPORT-DIGEST')).toMatch(/validated export/i);
    expect(isExploratoryExport('REPORT-DIGEST')).toBe(false);
  });

  it('treats an unregistered claim as exploratory, never silently validated', () => {
    expect(evidenceNote('NOPE-NOT-A-CLAIM')).toMatch(/exploratory/i);
    expect(isExploratoryExport('NOPE-NOT-A-CLAIM')).toBe(true);
  });
});
