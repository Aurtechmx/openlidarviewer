/**
 * accuracyUnitContract.test.ts — a field whose name ends in M holds metres.
 *
 * `holdoutRmse` computes `residual = (z - predicted) * verticalUnitToMetres`
 * and falls back to an inert 1 when no vertical scale resolved, so on such a
 * frame the residuals are in SOURCE Z units. Those residuals reached
 * `demAccuracyStandards`, which names its outputs `rmseZM`, `nvaM` and `vvaM`.
 *
 * A reader of those names has no way to discover that the value might be feet
 * or arbitrary scanner units, and the analysis carries no other field saying
 * so. All three are `number | null` and every consumer already has a null path,
 * so an unresolved frame withholds the figure rather than mislabelling it.
 *
 * The residual statistics themselves are unaffected: `validation.rmse` is still
 * computed and still reported, in whatever unit the frame provides. What is
 * withheld is the metre-named accuracy standard derived from it.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { analyseContours, type AnalyseContoursParams } from '../src/terrain/contour/analyseContours';
import { blockedRmseHint } from '../src/terrain/contour/contourCopy';

/** A gentle slope dense enough for the hold-out to produce a figure. */
function slope(): Float32Array {
  const pts: number[] = [];
  for (let x = 0; x <= 30; x += 0.5) {
    for (let y = 0; y <= 30; y += 0.5) pts.push(x, y, 10 + x * 0.04 + ((x * 3 + y * 7) % 4) * 0.01);
  }
  return new Float32Array(pts);
}

const BASE: AnalyseContoursParams = { cellSizeM: 1, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703' };

describe('the record says which classification actually ran', () => {
  /** A slope whose points all carry ASPRS class 2, so the trusted path takes over. */
  function classifiedSlope(): { pts: Float32Array; cls: Uint8Array } {
    const pts: number[] = [];
    for (let x = 0; x <= 30; x += 0.5) {
      for (let y = 0; y <= 30; y += 0.5) {
        pts.push(x, y, 10 + x * 0.04 + ((x * 3 + y * 7) % 4) * 0.01);
      }
    }
    return {
      pts: new Float32Array(pts),
      cls: Uint8Array.from({ length: pts.length / 3 }, () => 2),
    };
  }

  it('reports fixed-source-classification when class 2 was trusted, not train-only', () => {
    // The trusted-survey path hands the validator an ALL-GROUND pseudo-mask,
    // because the source's class-2 labels are authoritative and independent of
    // the split. At the hold-out boundary that is indistinguishable from a real
    // train-only re-run, so validation.json claimed a classifier had run on the
    // training points when none had run at all.
    const { pts, cls } = classifiedSlope();
    const r = analyseContours(pts, {
      ...BASE,
      horizontalUnitToMetres: 1,
      verticalUnitToMetres: 1,
      classification: cls,
      trustGroundClassification: true,
    });
    expect(r.validation.sampleSize, 'the fixture must actually validate').toBeGreaterThan(0);
    expect(r.validation.classificationScope).toBe('fixed-source-classification');
    expect(r.validation.warnings.join(' ')).toMatch(/no classifier was re-run/i);
  });

  it('the blocked pass records the classification it actually scored against', () => {
    // SMRF path: blocked scores against the whole-cloud mask while random
    // re-classifies on the training points, so the two DO differ in treatment.
    const { pts } = classifiedSlope();
    const smrf = analyseContours(pts, {
      ...BASE, horizontalUnitToMetres: 1, verticalUnitToMetres: 1,
    });
    expect(smrf.blockedAccuracy, 'the fixture must produce a blocked figure').not.toBeNull();
    expect(smrf.validation.classificationScope).toBe('train-only');
    expect(smrf.blockedAccuracy?.classificationScope).toBe('whole-cloud');

    // Trusted path: blocked scores against the SAME trusted class-2 ground set
    // the random pass uses, so there is no treatment difference at all. The
    // wording asserted one, because it was written for the SMRF case and fixed.
    const { pts: p2, cls } = classifiedSlope();
    const trusted = analyseContours(p2, {
      ...BASE,
      horizontalUnitToMetres: 1,
      verticalUnitToMetres: 1,
      classification: cls,
      trustGroundClassification: true,
    });
    expect(trusted.blockedAccuracy).not.toBeNull();
    expect(trusted.validation.classificationScope).toBe('fixed-source-classification');
    expect(trusted.blockedAccuracy?.classificationScope).toBe('fixed-source-classification');

    // And the copy follows the scopes rather than restating one case.
    const smrfHint = blockedRmseHint(
      smrf.validation.classificationScope,
      smrf.blockedAccuracy!.classificationScope,
    );
    expect(smrfHint).toMatch(/not like-for-like/);
    const trustedHint = blockedRmseHint(
      trusted.validation.classificationScope,
      trusted.blockedAccuracy!.classificationScope,
    );
    expect(trustedHint, 'the trusted path was told it had a treatment difference')
      .not.toMatch(/not like-for-like/);
    expect(trustedHint).toMatch(/holding classification treatment fixed/);
  });

  it('still reports train-only when a classifier really is re-run', () => {
    // Same surface, no trusted classification: the SMRF path supplies a real
    // train-only reclassifier, so the refusal above is not simply blanket.
    const { pts } = classifiedSlope();
    const r = analyseContours(pts, {
      ...BASE, horizontalUnitToMetres: 1, verticalUnitToMetres: 1,
    });
    expect(r.validation.sampleSize).toBeGreaterThan(0);
    expect(r.validation.classificationScope).toBe('train-only');
  });
});

describe('metre-named accuracy fields require a resolved vertical scale', () => {
  it('reports them on a frame that states its vertical unit', () => {
    const r = analyseContours(slope(), {
      ...BASE, horizontalUnitToMetres: 1, verticalUnitToMetres: 1,
    });
    // The fixture must produce a figure, or the withholding test below proves
    // nothing: an absent number would look identical either way.
    expect(r.accuracyStandards.rmseZM, 'the fixture must yield an accuracy figure')
      .not.toBeNull();
    expect(r.accuracyStandards.nvaM).not.toBeNull();
  });

  it('withholds them when no vertical scale resolved', () => {
    const r = analyseContours(slope(), { ...BASE, horizontalUnitToMetres: 1 });
    expect(r.accuracyStandards.rmseZM,
      'rmseZM held a source-unit value on an unresolved frame').toBeNull();
    expect(r.accuracyStandards.nvaM).toBeNull();
    expect(r.accuracyStandards.vvaM).toBeNull();
  });

  it('a foot frame still reports, because feet convert to metres', () => {
    // Withholding is for an UNRESOLVED scale, not a non-metre one: a declared
    // foot vertical is a known scale and converts exactly.
    const r = analyseContours(slope(), {
      ...BASE, horizontalUnitToMetres: 1, verticalUnitToMetres: 0.3048,
    });
    expect(r.accuracyStandards.rmseZM).not.toBeNull();
  });
});

/**
 * The same defect was found five times on five surfaces — the Analyse panel's
 * four rows, the terrain report, the contour review bar, the deliverable PDF and
 * the ASPRS standards themselves. Each was fixed where it was found, which is
 * how it kept reappearing. This sweeps for the sixth.
 *
 * The rule: a hold-out RMSE may only be captioned "m" where the caption is
 * conditional on the resolved vertical scale, or where the value comes from a
 * field the analysis already withholds on an unresolved frame (`rmseZM`,
 * `rmseM` — the `*M` contract).
 */
const SRC = resolve(__dirname, '..', 'src');

function tsFilesUnder(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) tsFilesUnder(full, acc);
    else if (full.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

/** A template hole naming an rmse, followed within a few characters by a bare m. */
const CAPTIONED = /\$\{[^}]*[Rr]mse[^}]*\}[^`$]{0,4}\bm\b/g;

describe('no surface captions a hold-out RMSE as metres unconditionally', () => {
  it('every metre-captioned RMSE is gated on the resolved scale or on a *M field', () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(CAPTIONED)) {
        // Reading a `*M` field is sufficient on its own: those are withheld by
        // `analyseContours` when no vertical scale resolved, so a null-guarded
        // read of one cannot print a source-unit number.
        if (/rmseZM|rmseM\b/.test(m[0])) continue;
        const line = text.slice(0, m.index).split('\n').length;
        // Otherwise the CAPTION ITSELF must be gated: the flag has to appear
        // within a few lines of the metre literal. Exempting the whole file once
        // it mentioned the flag anywhere let a second, ungated caption in the
        // same file pass, which is the sixth surface this sweep exists to find.
        const lines = text.split('\n');
        const window = lines.slice(Math.max(0, line - 6), line + 2).join('\n');
        if (/verticalScaleResolved|zUnit\b|fmtZ\b|zUnitLabel/.test(window)) continue;
        offenders.push(`${relative(SRC, file)}:${line}  ${m[0].trim()}`);
      }
    }
    expect(offenders, `metre caption on a possibly source-unit RMSE:\n${offenders.join('\n')}`)
      .toEqual([]);
  });
});
