/**
 * measureResultModel.ts: what the compact result card says about the latest
 * completed measurement.
 *
 * Nothing is calculated here. The headline is the controller's own formatted
 * `value` (the string the Measurements list shows), the caveats are the trust
 * caption and the unit-unverified notice the list and its tooltips already use,
 * and a missing value stays missing: it is never turned into a zero. The card
 * and the Copy action read the same model, so what is copied is what is shown.
 *
 * Pure: no DOM.
 */

import type { MeasurementSummary } from '../render/measure/MeasureController';
import { UNIT_UNVERIFIED_MEASURE_NOTICE, VOLUME_ESTIMATE_NOTICE } from '../render/measure/format';
import { sceneCaveatLines, type MeasureSceneContext } from '../render/measure/measureConfidence';

/** How much the headline can be trusted, in the order a reader must see it. */
export type ResultStatus = 'ok' | 'unit-unverified' | 'not-presentable' | 'no-value';

export interface ResultModel {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  /** The formatted headline, or the plain statement that there is none. */
  readonly value: string;
  readonly status: ResultStatus;
  /** One line saying why the value needs care, or null when it does not. */
  readonly caveat: string | null;
  /** The exact text Copy writes, or null when there is nothing to copy. */
  readonly copyText: string | null;
  /** Whether the "Use as clipping region" action applies to this kind. */
  readonly canClip: boolean;
}

/** The controller prints this for a measurement that has no figure yet. */
const NO_VALUE = '—';
export const NO_VALUE_TEXT = 'No value to report';

/**
 * `scene` is the same set of facts the Measurements panel grades the row
 * against, so a figure the panel calls approximate is never a bare number on
 * the card or in the copied text.
 */
export function buildResultModel(s: MeasurementSummary, scene: MeasureSceneContext): ResultModel {
  const raw = (s.value ?? '').trim();
  const hasValue = raw !== '' && raw !== NO_VALUE;
  const trust = s.trust;

  let status: ResultStatus = 'ok';
  let caveat: string | null = null;
  if (!hasValue) {
    status = 'no-value';
    caveat = trust && !trust.presentable ? trust.caption : null;
  } else if (trust && !trust.presentable) {
    status = 'not-presentable';
    caveat = trust.caption;
  } else if (s.unitUnverified === true) {
    status = 'unit-unverified';
    caveat = UNIT_UNVERIFIED_MEASURE_NOTICE;
  } else if (trust && trust.grade !== 'green') {
    caveat = trust.caption;
  }

  if (hasValue) {
    // The unit notice above is already the headline; do not state it twice.
    const facts = status === 'unit-unverified' ? { ...scene, unitVerified: true } : scene;
    const more = sceneCaveatLines(s, facts);
    if (s.kind === 'volume') more.push(VOLUME_ESTIMATE_NOTICE);
    if (more.length > 0) caveat = [caveat, ...more].filter((x): x is string => !!x).join('; ');
  }

  const value = hasValue ? raw : NO_VALUE_TEXT;
  const copyText = hasValue ? `${s.name}: ${measurementRowText({ value: raw, volumeBaseLevel: s.volumeBaseLevel })}${caveat ? ` (${caveat})` : ''}` : null;
  return { id: s.id, kind: s.kind, name: s.name, value, status, caveat, copyText, canClip: s.kind === 'box' };
}

/**
 * The row as the Measurements panel prints it: the headline and, for a polygon
 * volume, the base-level clause under it. The copied text and the PDF report's
 * measurement rows take this, so all three say the same thing.
 */
export function measurementRowText(s: Pick<MeasurementSummary, 'value' | 'volumeBaseLevel'>): string {
  return s.volumeBaseLevel ? `${s.value} · ${s.volumeBaseLevel}` : s.value;
}
