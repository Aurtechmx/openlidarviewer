/**
 * profileVerticalReference.ts
 *
 * One question, one answer: what surface is a profile's height measured from?
 *
 * The flag the scene carries is `profileDatumKnown`, and it means the loaded
 * clouds agree on a render origin — `MeasureController` derives it from
 * `this._originUp !== null`. Agreeing origins are what makes a stored local
 * height convertible back to the source's own height; they say nothing about
 * whether that source declared a vertical datum. Reading the flag as "we know
 * the datum" is how every display surface came to print "Elevation" over
 * heights whose reference was never declared.
 *
 * This module resolves the honest answer once, so the panel, the station table,
 * the CSV and the sheet cannot each guess differently.
 *
 * Pure: no DOM, no three.js, no CRS resolution — it reads facts the caller
 * already holds and classifies them through `geo/height`.
 */

import { verticalReferenceFromDatum } from '../../geo/height';
import type { VerticalReference } from '../../geo/height';
import type { ProfileProvenance } from './profileProvenance';

/** Everything the app can know about a profile's vertical reference. */
export interface ProfileVerticalReferenceInput {
  /**
   * The scene's `profileDatumKnown`: whether the loaded clouds share a render
   * origin. Only an explicit `false` is a refusal — an absent flag is a
   * summary recorded before the gate existed, not a claim either way.
   */
  readonly datumKnown?: boolean;
  /**
   * The measurement's provenance record, when it has one. Its
   * `units.verticalReference` is the reference resolved at sampling time, from
   * the sources actually read.
   */
  readonly provenance?: ProfileProvenance | null;
  /**
   * The vertical datum the CRS service resolved, as a name ("NAVD88") or code
   * ("EPSG:5703"). Null when the frame declared none.
   */
  readonly verticalDatum?: string | null;
}

/**
 * The reference surface a profile's heights are measured from.
 *
 * Three steps, in this order, each one narrower than the last:
 *
 *   1. Clouds that disagree on a render origin leave the samples in the
 *      scene's own frame, so the answer is `local` whatever anything else
 *      declares — a datum string cannot re-datum a height that was never
 *      brought back to it.
 *   2. Otherwise the provenance record answers, because it was resolved from
 *      the sources the sample actually read. A record that itself says
 *      `unknown` is not an answer and falls through.
 *   3. Otherwise the declared datum is classified by
 *      {@link verticalReferenceFromDatum}, which returns `unknown` for a name
 *      it does not recognise rather than guessing orthometric.
 *
 * Nothing here upgrades an undeclared datum. The default outcome — no
 * refusal, no record, no datum — is `unknown`, and `unknown` never prints as
 * an elevation.
 */
export function resolveProfileVerticalReference(
  input: ProfileVerticalReferenceInput,
): VerticalReference {
  if (input.datumKnown === false) return 'local';
  const fromRecord = input.provenance?.units.verticalReference;
  if (fromRecord != null && fromRecord !== 'unknown') return fromRecord;
  return verticalReferenceFromDatum({ verticalDatum: input.verticalDatum ?? undefined });
}
