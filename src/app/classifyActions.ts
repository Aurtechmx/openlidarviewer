/**
 * classifyActions.ts
 *
 * The whole-scan classification actions behind the Classes panel: Classify
 * (derive), Fill unclassified, Clear classifications and Restore original
 * classes. Lazy-loaded on first use, so the classifier client and its option
 * builders never enter the startup shell. The host hands in a small deps
 * object; nothing here reaches into module state of the composition root.
 *
 * Every action that replaces the codes goes through the Viewer's recorded edit
 * (`editClassification` / `applyDerivedClassification`), so one Undo brings
 * back exactly the codes held before it.
 */

import { deriveClassificationAsync } from '../render/class/deriveClassificationAsync';
import { classifierOptions } from '../render/class/classifierCues';
import { classificationCoverage } from '../render/class/classificationCoverage';
import type { DeriveClassificationOptions } from '../render/class/deriveClassification';
import { countClasses } from '../render/class/classHistogram';
import { classificationLabel } from '../render/pointInfo';
import { reportClassifyFailure, type ClassifyNoticeSurface } from './classLegendRefresh';
import { noteEdit } from '../ui/undoRouter';
import type { Viewer } from '../render/Viewer';
import type { CrsService } from '../geo/CrsService';
import { AUTO_CLASSIFY_LIMITS, NEEDS_LOADED_SCAN } from '../render/class/classLayer';

type ViewerCloud = NonNullable<ReturnType<Viewer['getCloud']>>;

export interface ClassifyActionsDeps {
  readonly viewer: Pick<Viewer, 'getCloud' | 'applyDerivedClassification'>;
  activeId(): string | null;
  readonly crsService: Pick<CrsService, 'crsRevision' | 'context'>;
  toast(message: string): void;
  readonly legend: ClassifyNoticeSurface & {
    setClasses(counts: Map<number, number>, sample?: { loaded: number; declared?: number }, pointFormat?: number): void;
    setDerivedProvenance(on: boolean, info?: { confidencePct?: number | null; warnings?: readonly string[] }): void;
  };
  /** Record the latest derive's 0..1 confidence for the Dataset Story. */
  setDerivedConfidence(c: number | null): void;
  /** Re-evaluate what is producible and show the class-edit panel. */
  afterDerive(): void;
}

let classifyRunning = false;

/**
 * Shared inner loop for {@link runDeriveClassification} and
 * {@link runFillUnclassified}: run the (possibly off-thread) derive, bail if
 * the active scan/frame changed underneath it, then apply the result and
 * refresh the classes legend. Callers stay responsible for their own
 * before/after toast copy and post-apply refreshes, since those differ.
 */
async function performClassificationDerive(
  d: ClassifyActionsDeps,
  cloud: ViewerCloud,
  activeId: string,
  deriveOptions: DeriveClassificationOptions,
  label: string,
): Promise<{ result: Awaited<ReturnType<typeof deriveClassificationAsync>>; confPct: number | null } | null> {
  const deriveCrsRevision = d.crsService.crsRevision();
  const result = await deriveClassificationAsync(
    cloud.positions,
    cloud.pointCount,
    deriveOptions,
    undefined,
    undefined,
    // Live phase in the toast so a multi-second derive reads as progress,
    // not a hang. (Off-thread, so the UI repaints between phases.)
    (phase) => d.toast(`${label} · ${phase}…`),
  );
  if (activeId !== d.activeId() || d.viewer.getCloud(activeId) !== cloud || d.crsService.crsRevision() !== deriveCrsRevision) return null;
  // The registry id@version travels with the codes into every export.
  d.viewer.applyDerivedClassification(activeId, result.codes, result.classifier.method);
  noteEdit('classification');
  d.setDerivedConfidence(Number.isFinite(result.confidence) ? result.confidence : null);
  d.legend.setClasses(countClasses(result.codes), { loaded: cloud.pointCount, declared: cloud.declaredPointCount }, cloud.metadata?.pointFormat);
  // Surface the run's honest confidence + caveats in the legend caption, not
  // just a flat "derived" tag — so the user sees WHEN to trust it.
  const confPct = Number.isFinite(result.confidence) ? Math.round(result.confidence * 100) : null;
  d.legend.setDerivedProvenance(true, { confidencePct: confPct, warnings: result.warnings });
  d.legend.show();
  return { result, confPct };
}

/** The active, fully loaded cloud, or null after telling the user why not. */
function activeLoadedCloud(d: ClassifyActionsDeps, label: string): { id: string; cloud: ViewerCloud } | null {
  const id = d.activeId();
  if (!id) {
    d.toast(`${label} · open a scan first.`);
    return null;
  }
  const cloud = d.viewer.getCloud(id);
  if (!cloud) {
    d.toast(`${label} ${NEEDS_LOADED_SCAN}`);
    return null;
  }
  return { id, cloud };
}

/**
 * Derive a heuristic classification for the active cloud when it has no
 * producer classes live. Runs the unsupervised classifier OFF the main thread
 * (with a safe fallback), applies the codes, colours the cloud by class,
 * rebuilds the legend, and reports the result with the honest "derived, not
 * survey-grade" caveat.
 */
export async function runDeriveClassification(d: ClassifyActionsDeps): Promise<void> {
  if (classifyRunning) return;
  const target = activeLoadedCloud(d, 'Classify');
  if (!target) return;
  const { cloud } = target;
  // Only derive when there is no producer classification to disturb. A scan that
  // is entirely Created(0)/Unclassified(1) — or carries no classification at all
  // — is fully derivable (this is the v0.4.8 unblock: an all-class-0 file, like a
  // raw photogrammetry export, is functionally unclassified and should classify).
  // A previous DERIVE is re-derivable (its heuristic codes aren't producer
  // truth), and so is a scan whose producer classes the user CLEARED: the
  // originals are kept aside and Undo / Restore bring them back. A live
  // producer classification (any ASPRS code ≥ 2) is otherwise left intact.
  const prov = cloud.classificationProvenance;
  const producerLive = prov === 'cleared' || prov === 'derived'
    ? 0
    : classificationCoverage(cloud.classification, cloud.pointCount).producer;
  if (producerLive > 0) {
    d.toast('Classify · this scan carries producer classes, so they stay as they are. Press Clear classes first to replace them.');
    return;
  }
  // RGB (when present) sharpens vegetation on photogrammetry, where geometry
  // alone is noisy — a green, locally-smooth canopy isn't mistaken for a roof.
  const deriveOptions = classifierOptions(cloud, d.crsService.context());

  classifyRunning = true;
  d.toast('Classify · deriving ground / vegetation / building…');
  try {
    const outcome = await performClassificationDerive(d, cloud, target.id, deriveOptions, 'Classify');
    if (!outcome) return;
    const { result, confPct } = outcome;
    d.afterDerive();
    // Honest one-line breakdown of the top classes derived.
    const total = cloud.pointCount || 1;
    const top = Object.entries(result.counts)
      .map(([code, n]) => ({ code: Number(code), n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 3)
      .map((e) => `${classificationLabel(e.code)} ${Math.round((e.n / total) * 100)}%`)
      .join(' · ');
    const confText = confPct !== null ? ` Support ${(confPct / 100).toFixed(2)}.` : '';
    const warnText = result.warnings.length > 0 ? ` ⚠ ${result.warnings[0]}` : '';
    d.toast(`Classify · derived (heuristic, not survey-grade): ${top}.${confText} ${AUTO_CLASSIFY_LIMITS}${warnText}`);
  } catch (err) {
    // A refusal also lands on the Classes caption, which outlives the toast.
    reportClassifyFailure(err, d.toast, d.legend);
  } finally { classifyRunning = false; }
}

/**
 * Fill ONLY the unclassified points of a partially-classified cloud, preserving
 * every producer class. Where {@link runDeriveClassification} declines a scan
 * that already carries producer classes (≥ 2), this is the deliberate surface
 * for them: it passes the existing classification to the deriver, which derives
 * the class-0/1 gaps and leaves the surveyor's classes untouched. The result is
 * tagged derived (heuristic) overall, because the filled points are guesses.
 */
export async function runFillUnclassified(d: ClassifyActionsDeps): Promise<void> {
  if (classifyRunning) return;
  const target = activeLoadedCloud(d, 'Fill unclassified');
  if (!target) return;
  const { cloud } = target;
  if (cloud.classificationProvenance !== 'source' || !cloud.classification) {
    d.toast('Fill unclassified · no producer classification to preserve — use Classify (derive).');
    return;
  }
  const cov = classificationCoverage(cloud.classification, cloud.pointCount);
  if (cov.producer === 0) {
    d.toast('Fill unclassified · no producer classes here — use Classify (derive) for the whole scan.');
    return;
  }
  if (cov.unclassified === 0) {
    d.toast('Fill unclassified · every point already carries a class — nothing to fill.');
    return;
  }
  // Preserve the producer classes; RGB (when present) sharpens the filled gaps.
  const deriveOptions: DeriveClassificationOptions = {
    existingClassification: cloud.classification,
    ...classifierOptions(cloud, d.crsService.context()),
  };
  classifyRunning = true;
  d.toast(`Fill unclassified · deriving ${cov.unclassified.toLocaleString()} points (producer classes kept)…`);
  try {
    const outcome = await performClassificationDerive(d, cloud, target.id, deriveOptions, 'Fill unclassified');
    if (!outcome) return;
    const { confPct } = outcome;
    d.afterDerive();
    const confText = confPct !== null ? ` Support ${(confPct / 100).toFixed(2)}.` : '';
    d.toast(`Fill unclassified · filled ${cov.unclassified.toLocaleString()} points (heuristic); producer classes kept.${confText}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/abort/i.test(msg)) d.toast(`Fill unclassified · failed: ${msg}`);
  } finally {
    classifyRunning = false;
  }
}
