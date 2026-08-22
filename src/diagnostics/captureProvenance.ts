/**
 * captureProvenance.ts
 *
 * The one capture-type verdict every surface reads.
 *
 * `provenance.classify` was called at three sites with three different argument
 * lists: the Inspector's Provenance card (`app/inspectorCardRefreshers.ts`), the
 * technical-report PDF (`app/reportExport.ts`) and the scan-report card stamped
 * into every exported image (`render/exportAdapter.ts`). Only the report passed
 * `isNonTerrain`, so one scan produced two opposite answers at the same moment:
 * the panel read "Drone-mounted LiDAR (UAV ALS), medium confidence" while the
 * PDF exported from the same session read "Ground-based scan, capture method not
 * determined" with the shape-router signal that ruled airborne out.
 *
 * The shape verdict also lands AFTER the panel refreshes. `openScan.ts` calls
 * `refreshProvenance` (line 338) then `revealAnalysePanel` (line 515);
 * `openStreaming.ts` calls `refreshProvenanceFromStreaming` (line 189) then
 * `revealAnalysePanel` (line 509 for COPC, line 806 for EPT).
 * `revealAnalysePanel` is what runs `applyScanRoute`, which produces the
 * verdict. A surface that classifies once at open time therefore cannot see the
 * verdict at all, and a streaming re-route or a manual "Treat as" pick moves it
 * again later in the session.
 *
 * This store holds the inputs and derives the verdict on read, so the three
 * surfaces state one answer:
 *
 *   - `setScan` records the scan's signals, and drops the previous scan's
 *     verdict and override so neither leaks across a load;
 *   - `setVerdict` records the shape router's decision whenever it changes;
 *   - `setOverride` records the user's capture-type pick, which is part of the
 *     shared verdict and therefore reaches the PDF and the exported images
 *     rather than only the panel;
 *   - `fingerprint` composes all three through `classify`;
 *   - `onChange` pushes each new verdict into the Inspector, so the panel
 *     follows a verdict that lands after it first rendered.
 *
 * One instance per document, exported as {@link captureProvenance}. The three
 * surfaces sit in `src/app`, `src/render` and the `src/main.ts` wiring with no
 * shared construction seam between them, and a per-surface instance is the
 * defect this module closes. `createCaptureProvenance` is exported so tests get
 * an isolated store.
 */

import {
  classify,
  fingerprintFor,
  type CaptureType,
  type ProvenanceFingerprint,
  type ScanSignals,
} from './provenance';
import type { SpaceKind } from '../terrain/scanShape';

/**
 * True for a compact object / interior scan. This is the capture-lens verdict
 * that rules out an aerial density guess in the provenance fingerprint (v0.5.7):
 * a temple is not drone LiDAR just because its density resembles a UAV survey.
 */
export function isNonTerrainVerdict(verdict: SpaceKind | null): boolean {
  return verdict === 'object' || verdict === 'interior';
}

/** The shared capture-type verdict for the active scan. */
export interface CaptureProvenanceStore {
  /**
   * Record the signals for the scan now loaded, or `null` for none. Resets the
   * shape verdict and any user override, which describe the scan being replaced.
   */
  setScan(signals: ScanSignals | null): void;
  /** Record the shape router's latest verdict for the active scan. */
  setVerdict(verdict: SpaceKind | null): void;
  /** The shape router's latest verdict for the active scan. */
  verdict(): SpaceKind | null;
  /** Record the user's capture-type pick, or `null` to return to the classifier. */
  setOverride(type: CaptureType | null): void;
  /** The user's capture-type pick, or `null` when the classifier decides. */
  override(): CaptureType | null;
  /** The verdict every surface states, or `null` when no scan is loaded. */
  fingerprint(): ProvenanceFingerprint | null;
  /**
   * Run `fn` with each new verdict, replacing any previous listener. One slot:
   * the Inspector is the only surface that has to be pushed to, because the
   * report and the image exports read `fingerprint()` when they build.
   */
  onChange(fn: ((f: ProvenanceFingerprint | null) => void) | null): void;
  /** Drop the scan, the verdict and the override. A closed scan states nothing. */
  clear(): void;
}

/** A cheap equality key, so an unchanged verdict does not re-render the panel. */
function key(f: ProvenanceFingerprint | null): string {
  if (!f) return '';
  return `${f.captureType}|${f.confidence}|${f.label}|${f.signals.join(' ')}`;
}

/** An isolated store. The application uses the shared {@link captureProvenance}. */
export function createCaptureProvenance(): CaptureProvenanceStore {
  let signals: ScanSignals | null = null;
  let verdict: SpaceKind | null = null;
  let override: CaptureType | null = null;
  let listener: ((f: ProvenanceFingerprint | null) => void) | null = null;
  let lastKey = '';

  function fingerprint(): ProvenanceFingerprint | null {
    if (override) return fingerprintFor(override);
    if (!signals) return null;
    return classify({ ...signals, isNonTerrain: isNonTerrainVerdict(verdict) });
  }

  function notify(): void {
    const f = fingerprint();
    const k = key(f);
    if (k === lastKey) return;
    lastKey = k;
    listener?.(f);
  }

  return {
    setScan(next) {
      signals = next;
      verdict = null;
      override = null;
      notify();
    },
    setVerdict(next) {
      verdict = next;
      notify();
    },
    verdict: () => verdict,
    setOverride(type) {
      override = type;
      notify();
    },
    override: () => override,
    fingerprint,
    onChange(fn) {
      listener = fn;
    },
    clear() {
      signals = null;
      verdict = null;
      override = null;
      // Unconditional, unlike the mutators: closing a scan restores the panel's
      // placeholder even when the store was already empty, and resetting
      // `lastKey` lets the next scan notify from a clean slate.
      lastKey = '';
      listener?.(null);
    },
  };
}

/**
 * The shared store the Inspector, the report PDF and the image exports all read.
 * Module-scoped so the three of them cannot hold separate copies.
 */
export const captureProvenance: CaptureProvenanceStore = createCaptureProvenance();
