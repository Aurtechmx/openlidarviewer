/**
 * qualityPreferenceStore.ts
 *
 * Persistence for the Speed ↔ Quality control: a slider position, whether the
 * position is following the device, and any fields pinned from Advanced.
 *
 * It writes its own `localStorage` key rather than joining `prefs.ts`. The
 * viewer preferences bundle is applied at boot AFTER the quality control has
 * already run, and it owns Eye Dome Lighting and antialiasing itself; folding
 * the slider into it would give two writers one key and make the boot order
 * decide who wins. The two stay separate, and the control's own apply path
 * updates the viewer preferences afterwards so they never disagree.
 *
 * `parseQualityPreference` is pure and total: any malformed, truncated or
 * hand-edited value degrades to automatic rather than throwing inside a
 * constructor.
 */

import { storageGet, storageSet } from './safeStorage';
import {
  clampQualityPosition,
  midQualityPosition,
  type QualityOverrides,
  type QualityPreference,
} from '../render/quality/qualityPolicy';
import { clampPixelRatioCeiling } from '../render/quality/pixelRatioCeiling';
import type { StreamingQuality } from '../render/streaming/streamingBudget';

/** Where the preference lives. */
export const QUALITY_PREFERENCE_KEY = 'olv.quality.preference';

/** Automatic, no pinned fields — what a first-run session gets. */
export const DEFAULT_QUALITY_PREFERENCE: QualityPreference = Object.freeze({
  auto: true,
  position: midQualityPosition(),
  overrides: Object.freeze({}),
});

const STREAMING_QUALITIES: readonly StreamingQuality[] = ['low', 'balanced', 'high'];

/** Narrow an unknown value to a streaming preset, or drop it. */
function readStreamingQuality(value: unknown): StreamingQuality | undefined {
  return typeof value === 'string' && (STREAMING_QUALITIES as readonly string[]).includes(value)
    ? (value as StreamingQuality)
    : undefined;
}

/** Keep only the override fields that survive validation. */
function readOverrides(value: unknown): QualityOverrides {
  if (typeof value !== 'object' || value === null) return {};
  const raw = value as Record<string, unknown>;
  const overrides: {
    streamingQuality?: StreamingQuality;
    maxPixelRatio?: number;
    edlEnabled?: boolean;
    antialiasing?: boolean;
  } = {};
  const streaming = readStreamingQuality(raw.streamingQuality);
  if (streaming) overrides.streamingQuality = streaming;
  if (typeof raw.maxPixelRatio === 'number' && Number.isFinite(raw.maxPixelRatio)) {
    overrides.maxPixelRatio = clampPixelRatioCeiling(raw.maxPixelRatio);
  }
  if (typeof raw.edlEnabled === 'boolean') overrides.edlEnabled = raw.edlEnabled;
  if (typeof raw.antialiasing === 'boolean') overrides.antialiasing = raw.antialiasing;
  return overrides;
}

/**
 * Parse a stored preference. Never throws: a null, malformed or partially
 * valid payload yields the default with whatever fields did validate.
 */
export function parseQualityPreference(raw: string | null): QualityPreference {
  if (!raw) return DEFAULT_QUALITY_PREFERENCE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_QUALITY_PREFERENCE;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_QUALITY_PREFERENCE;
  const record = parsed as Record<string, unknown>;
  return {
    // Anything that is not an explicit `false` leaves the position automatic —
    // the safe direction, since automatic is what the device asked for.
    auto: record.auto !== false,
    position:
      typeof record.position === 'number'
        ? clampQualityPosition(record.position)
        : midQualityPosition(),
    overrides: readOverrides(record.overrides),
  };
}

/** The stored preference for this browser, or the default. */
export function readQualityPreference(): QualityPreference {
  return parseQualityPreference(storageGet(QUALITY_PREFERENCE_KEY));
}

/** Persist a preference. Best-effort — a storage failure is not an error here. */
export function writeQualityPreference(preference: QualityPreference): void {
  storageSet(QUALITY_PREFERENCE_KEY, JSON.stringify(preference));
}
