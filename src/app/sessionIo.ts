/**
 * sessionIo.ts — the session-restore orchestration lifted out of main.ts.
 *
 * `importSession` reads a saved `.olvsession`, verifies its stored scan
 * fingerprint against the loaded cloud, rebases its geometry into that cloud's
 * frame and applies the restored measurements / annotations / views / CRS /
 * camera. The pure halves it leans on already live in `../io/session`
 * (`parseSession`, `rebaseSessionGeometry`, `matchSessionToScan`) and are unit
 * tested there; the apply step is parameterised through {@link SessionIoDeps}
 * so the whole restore drives from plain fakes. The `ScanFacts` adapter
 * (`scanFactsFromStreaming` / `scanFactsFromStatic`) that used to live here
 * moved to `./sessionScanFacts` — `openScan.ts` calls it synchronously on every scan
 * load, so it stays eager, while this module (session-file import — a
 * deliberate, occasional user action) does not; both names are re-exported
 * here unchanged. `main.ts` calls in through `loadSessionIo()` (v0.7 shell
 * headroom), binding its own running state to the deps only once the module
 * resolves.
 *
 * Part of the v0.6 decomposition (see `docs/architecture/architecture-map.md`).
 */

import { heldCutAxes, sessionUpAxisNote } from './sessionUpAxisNote';
import type { LayerUpFrame } from '../geo/frame/layerUpFrame';
import type { Viewer } from '../render/Viewer';
import type { WorkplaneSettings } from '../model/workplaneSettings';
import type { PointCloud } from '../model/PointCloud';
import type { ViewBookmarksService } from './viewBookmarks';
import type { CrsService } from '../geo/CrsService';
import type { ViewStateBundle } from '../io/viewState';
import { buildViewState } from '../io/viewState';
import { isExportStale, staleExportReason } from '../export/exportStaleness';
import { summarizeMeasurementTrust } from '../render/measure/measurementTrust';
import type {
  DeclaredSpatialFacts,
  InspectionSession,
  RebasedSessionGeometry,
  RebaseTarget,
  ScanFacts,
  ScanMatch,
  SessionLayerGroup,
  SessionScanSummary,
  SessionSpatialClaims,
  SessionSpatialVerdict,
} from '../io/session';
import type { WorkOwnership } from '../model/workOwnership';
import type { LiveLayerEvidence, PersistedLayerMatch, SessionLayerMapping } from '../io/sessionOwnership';
import {
  loadSessionOwnership,
  loadVerifySessionManifest,
} from '../lazyChunks';
import {
  scanFactsFromStreaming,
  scanFactsFromStatic,
  declaredSpatialFromStreaming,
  declaredSpatialFromStatic,
  sessionSpatialClaimsOf,
  type StreamingScanSource,
  type StaticScanCloud,
} from './sessionScanFacts';
import { formatBytesIn } from '../io/formatByteSize';
import { heldSessionWork, holdSessionWork, markPendingSessionRestore } from './pendingSessionRestore';
import type { ReplaceOutcome, ReplaceRequest } from './discardGuard';
import type { StoredView } from './appContext';
import type { Measurement } from '../render/measure/types';
import type { Annotation } from '../render/annotate/types';

// Re-exported so `sessionIo`'s public API is unchanged — `openScan.ts` reads
// `scanFactsFromStatic` off `./sessionScanFacts` directly (the hot scan-open path
// must not pull in the rest of this module), but existing importers of these
// names off `sessionIo` (tests, `layerIdentityService`'s doc comment) keep
// working exactly as before.
export {
  scanFactsFromStreaming,
  scanFactsFromStatic,
  declaredSpatialFromStreaming,
  declaredSpatialFromStatic,
};
export type { StreamingScanSource, StaticScanCloud };

/**
 * Whole-file byte ceiling for a `.olvsession`, checked on the File's size BEFORE
 * it is read. A shared session is untrusted input, and `parseSession` runs
 * `JSON.parse` over the entire text — an unbounded file can exhaust memory
 * before the parser's per-dimension caps ever apply (and before the try/catch
 * can surface it). An inspection session is analysis metadata, not the scan, so
 * even a rich Evidence Capsule is a few MB and a session of 20,000 measurements
 * is about 7 MB; 64 MiB is far above any real session while bounding the
 * parse (`JSON.parse` of a file of near-empty records costs roughly ten times
 * its size in heap). Over-limit is rejected onto the drop zone.
 */
export const MAX_SESSION_BYTES = 64 * 1024 * 1024;

/** The pure session functions `importSession` resolves lazily (from `../io/session`). */
export interface SessionModule {
  parseSession: (text: string) => InspectionSession;
  rebaseSessionGeometry: (
    session: InspectionSession,
    cloudOrigin: readonly [number, number, number],
    target?: RebaseTarget,
  ) => RebasedSessionGeometry;
  matchSessionToScan: (
    summary: SessionScanSummary | undefined,
    loaded: ScanFacts,
    storedOrigin?: readonly [number, number, number] | null,
  ) => ScanMatch;
  /** The origin the session stored for its summary's scan. */
  sessionScanOrigin?: (session: InspectionSession) => readonly [number, number, number] | null;
  detectSessionSpatialConflict: (
    claims: SessionSpatialClaims,
    declared: DeclaredSpatialFacts,
  ) => SessionSpatialVerdict;
}

/**
 * The running-app seam `importSession` writes through. Accessors are functions,
 * not snapshots, so a mid-import scan swap is seen (the restore re-reads the
 * viewer and active scan after every `await`, exactly as the inline version did
 * against the module-level `let`s).
 */
export interface SessionIoDeps {
  /** Resolves once the lazily-loaded Viewer chunk is in place — awaited before any `getViewer()`. */
  readonly viewerReady: Promise<unknown>;
  /** The live Viewer (a late-bound `let` in the shell). */
  getViewer: () => Viewer;
  /** The dynamic import of the pure session functions (`loadSession` in the shell). */
  loadSession: () => Promise<SessionModule>;
  /** The producing build's version string, for the stale-export disclosure (`__APP_VERSION__`). */
  readonly appVersion: string;
  /** The active scan id, or null when none is loaded. */
  getActiveScanId: () => string | null;
  /**
   * The stable LAYER-IDENTITY id of the active scan (resolved from its source
   * facts through the identity registry), or null when it carries no proven
   * identity. This is the owner restored work is attributed to — never the
   * scan/viewer id, which is not stable across a close and reopen.
   */
  getActiveLayerId: () => string | null;
  /** The active static cloud, or null (streaming / no scan). */
  getActiveCloud: () => PointCloud | null;
  /** The source-frame origin the session's geometry is rebased against (`exportGeoContext().origin`). */
  exportOrigin: () => readonly [number, number, number];
  /** The scene origin of the open layer with this stable id, or null when it is not open. */
  layerOrigin?: (layerId: string) => readonly [number, number, number] | null;
  /** The live project origin, or null when no project frame is set. */
  projectOrigin?: () => readonly [number, number, number] | null;
  /** The active scan's resolved up frame (`app/layerUpFrames.ts`), or null when none is open. */
  activeUpFrame?: () => LayerUpFrame | null;
  /**
   * The open static layers with the source evidence their ids are bound on.
   * Present: saved layer ids are mapped onto these before anything is placed.
   */
  liveLayers?: () => readonly LiveLayerEvidence[];
  /** Saved-view store: `restore` replaces the list, `names` feeds the Inspector. */
  bookmarks: Pick<ViewBookmarksService, 'restore' | 'names'>;
  /** Push the restored view names into the Inspector panel. */
  setInspectorViews: (names: string[]) => void;
  /**
   * Restore the Layers panel's group arrangement. The records name their
   * members by stable layer id, so the panel re-attaches each group to the
   * scans that are actually open and drops the rest.
   */
  restoreLayerGroups: (groups: readonly SessionLayerGroup[]) => void;
  /** Re-apply the reference plane a session saved. Optional: an older host has none. */
  restoreReferencePlane?: (settings: WorkplaneSettings) => void;
  /** Re-render the measurements panel from the viewer's store. */
  refreshMeasurePanel: () => void;
  /** Re-render the annotations panel from the viewer's store. */
  refreshAnnotationPanel: () => void;
  /** Apply a global view-state bundle through the shared, camera-last path. */
  applyViewState: (vs: ViewStateBundle) => void;
  /** Restore the author's CRS override (`crsService.setOverride`). */
  setCrsOverride: (args: Parameters<CrsService['setOverride']>[0]) => void;
  /**
   * Ask before the file replaces measurements, annotations or saved views that
   * are already open. Absent: nothing is asked.
   */
  confirmReplace?: (req: ReplaceRequest) => Promise<ReplaceOutcome>;
  /** The saved views now open, for telling whether the file adds anything. */
  currentViews?: () => readonly StoredView[];
  /** Fire a toast, optionally with one action button. */
  showToast: (
    message: string,
    action?: { readonly label: string; readonly onClick: () => void },
  ) => void;
  /** Surface a fatal import error on the drop zone. */
  setDropError: (message: string) => void;
}

/**
 * The FILE's declared spatial frame for whatever scan is active right now —
 * streaming source first, else the active static cloud, else an empty
 * declaration. Mirrors the streaming/static split the scan-identity match uses,
 * so the spatial-conflict guard reads exactly the scan the geometry is being
 * attached to.
 */
function declaredSpatialForActiveScan(viewer: Viewer, deps: SessionIoDeps): DeclaredSpatialFacts {
  const streaming = viewer.streamingCloud;
  if (streaming) return declaredSpatialFromStreaming(streaming);
  const id = deps.getActiveScanId();
  const staticCloud = id ? viewer.getCloud(id) : undefined;
  if (staticCloud) return declaredSpatialFromStatic(staticCloud);
  return {};
}

/**
 * Whether a save of this scene writes a project frame, which is when work on
 * it is `project` work: every open layer has a proven identity, and either two
 * or more are open or the one open layer is still placed off its own origin.
 * A lone layer in its own frame is saved without one, so its work is
 * `source-local`.
 */
function savesProjectFrame(
  openCount: number,
  live: readonly LiveLayerEvidence[],
  layerOrigin: SessionIoDeps['layerOrigin'],
): boolean {
  if (openCount === 0 || live.length !== openCount) return false;
  if (live.length >= 2) return true;
  const so = live[0]!.sourceOrigin;
  const o = layerOrigin?.(live[0]!.layerId) ?? null;
  return !!so && !!o && o.some((c, k) => c !== so[k]);
}

/** Every layer id held work names, as owner or pick layer. */
function heldLayerIds(held: { measurements: readonly Measurement[]; annotations: readonly Annotation[] }): Set<string> {
  const ids = new Set<string>();
  for (const m of held.measurements) for (const id of [m.owner?.layerId, ...(m.pickLayers ?? [])]) if (id) ids.add(id);
  for (const a of held.annotations) if (a.owner?.layerId) ids.add(a.owner.layerId);
  return ids;
}

/** The file names of the scans held work waits for, as the file recorded them. */
function unmatchedNames(
  held: { measurements: readonly Measurement[]; annotations: readonly Annotation[] },
  frame: InspectionSession['projectFrame'],
  mapping: SessionLayerMapping | null,
  kind: PersistedLayerMatch['kind'],
): string[] {
  if (!frame || !mapping) return [];
  const ids = heldLayerIds(held);
  const names = frame.layers
    .filter((l) => l.sourceName !== '' && ids.has(l.layerId) && [...mapping.byId].some(([saved, m]) => m.kind === kind && (saved === l.layerId || `${saved}~unmatched` === l.layerId)))
    .map((l) => `“${l.sourceName}”`);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

const byId = <T extends { id: string }>(items: readonly T[]): T[] => [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/**
 * Whether the file holds exactly the work already open, so importing it
 * discards nothing. Any difference at all counts as different.
 */
export function sameSessionWork(
  open: { measurements: readonly { id: string }[]; annotations: readonly { id: string }[]; views: readonly StoredView[] },
  file: { measurements: readonly { id: string }[]; annotations: readonly { id: string }[]; views: readonly { name: string; camera: unknown }[] },
): boolean {
  if (open.measurements.length !== file.measurements.length || open.annotations.length !== file.annotations.length || open.views.length !== file.views.length) return false;
  if (JSON.stringify(byId(open.measurements)) !== JSON.stringify(byId(file.measurements))) return false;
  if (JSON.stringify(byId(open.annotations)) !== JSON.stringify(byId(file.annotations))) return false;
  return open.views.every((v, i) => !v.state && v.name === file.views[i]!.name && JSON.stringify(v.pose) === JSON.stringify(file.views[i]!.camera));
}

/**
 * Import an inspection session: restore measurements, annotations and views.
 * `skipScanConfirm` is set only by the "Apply anyway" action after a partial
 * scan-identity match, so the same restore re-runs past the confirmation gate.
 * `reapply` is set when a session imported before any scan was open is applied
 * again onto the scan that has just opened: the work in the viewer is that
 * session's own, so nothing is asked.
 */
export async function importSession(
  file: File,
  opts: { skipScanConfirm?: boolean; reapply?: boolean },
  deps: SessionIoDeps,
): Promise<boolean> {
  // Set once the session's work is in the scene, so a later failure still reports it applied.
  let applied = false;
  try {
    // A shared `.olvsession` is untrusted; reject an over-large file up front,
    // before it is read, so `JSON.parse` of the whole text can't exhaust memory.
    // This is the whole-file ceiling; the parser's per-dimension caps (item
    // counts, per-measurement points) bound the rest once the JSON is in hand.
    if (file.size > MAX_SESSION_BYTES) {
      throw new Error(
        `This session file is too large (${formatBytesIn(file.size, 'MiB', 0)}; ` +
          `limit ${formatBytesIn(MAX_SESSION_BYTES, 'MiB', 0)}).`,
      );
    }
    // The session path's imports are light (no three.js), so a session restore
    // can finish before the lazily-imported Viewer chunk resolves — leaving
    // `viewer` as its null sentinel. Await viewerReady so every `viewer.*`
    // access below is safe (measure/annotate are built in the Viewer ctor, so
    // no GPU backend is needed — just a non-null instance).
    await deps.viewerReady;
    const viewer = deps.getViewer();
    const { parseSession, rebaseSessionGeometry, matchSessionToScan, detectSessionSpatialConflict, sessionScanOrigin } =
      await deps.loadSession();
    const session = parseSession(await file.text());
    // Lazy: the ownership resolver lives off the index chunk — session restore is
    // on-demand, so its cost belongs on the restore path, not the initial load.
    const ownershipModule = await loadSessionOwnership();
    // If an older build wrote this session, a newer one may grade or label the
    // scan differently — surface that so the user can re-save. Absent stamp
    // (pre-v6 file) reads as "an earlier version".
    if (isExportStale(session.software, deps.appVersion)) {
      const note = staleExportReason(session.software, deps.appVersion);
      if (note) deps.showToast(note);
    }
    // Session vertices are LOCAL to the origin of the scan they were captured
    // against. Imported onto a DIFFERENT loaded cloud (a different floored
    // origin), they must be rebased into that cloud's frame or they land
    // displaced by the two origins' difference — and a later export would
    // compound the error by adding the new origin. With no cloud loaded there
    // is nothing to rebase against; keep the verbatim geometry (the missing-
    // scan toast below already tells the user to drop the scan).
    const haveCloud = viewer.clouds().length > 0 || viewer.hasStreamingCloud;
    // Capture the scan this import matches against, re-checked before we attach
    // state. A session restore routes ahead of the loading guard, so a scan
    // swapped in mid-import must not inherit another scan's measurements.
    const targetId = deps.getActiveScanId();
    const targetStreamingCloud = viewer.streamingCloud;
    const targetStaticCloud = targetId ? viewer.getCloud(targetId) : undefined;
    // The saved layer ids are this file's page's ids, not this page's. Each
    // layer the file's project frame records is matched to an open layer on its
    // source evidence (fingerprint, file origin, axis, EPSG) before anything is
    // checked or placed. A frame layer that is matched is a verified scan of
    // this session, a stronger check than the one summary scan below.
    const live = haveCloud ? deps.liveLayers?.() ?? null : null;
    const frameMapping: SessionLayerMapping | null = live && session.projectFrame
      ? ownershipModule.mapSessionLayers(session.projectFrame, live)
      : null;
    const frameVerified = !!frameMapping && [...frameMapping.byId.values()].some((m) => m.kind === 'resolved');
    // Guard the rebase: a session's geometry is local to the scan it was
    // captured over, so realigning it onto the loaded cloud is only correct when
    // that IS its scan. Compare the session's stored fingerprint (built the same
    // way exportSession writes it) against the loaded scan. A clear conflict is
    // refused rather than silently realigned onto the wrong scan; a partial
    // match asks the user to confirm before anything is applied.
    let scanMatch: ScanMatch | undefined;
    if (haveCloud) {
      const streamingCloud = viewer.streamingCloud;
      const staticCloud = deps.getActiveCloud() ?? undefined;
      let loadedFacts: ScanFacts | undefined;
      if (streamingCloud) {
        loadedFacts = scanFactsFromStreaming(streamingCloud);
      } else if (staticCloud) {
        loadedFacts = scanFactsFromStatic(staticCloud);
      }
      let match: ScanMatch | undefined;
      if (loadedFacts) {
        match = matchSessionToScan(session.scanSummary, loadedFacts, sessionScanOrigin?.(session));
        scanMatch = match;
        if (match.verdict === 'conflict' && !frameVerified) {
          const why = match.reasons[0] ?? 'its scan fingerprint does not match';
          const want = session.scanSummary?.fileName;
          deps.showToast(
            `This session was captured over a different scan (${why}) — it was not applied. ` +
              (want ? `Load “${want}” to restore it on its own scan.` : 'Load its source scan to restore it.'),
          );
          return false;
        }
        if (match.verdict === 'partial' && !opts.skipScanConfirm && !frameVerified) {
          // Not a clear conflict, but not a confirmed match — don't touch the
          // scene until the user opts in. "Apply anyway" re-imports with the
          // check skipped, so the same restore proceeds on their confirmation.
          const why = match.reasons[0] ?? '';
          const whyDetail = why ? ` (${why})` : '';
          deps.showToast(
            `This session's scan couldn't be fully verified${whyDetail}. ` +
              'Applying it may place its measurements on the wrong scan.',
            { label: 'Apply anyway', onClick: () => void importSession(file, { ...opts, skipScanConfirm: true }, deps) },
          );
          return false;
        }
      }
      // Roadmap P1 #5 — validate the session's spatial FRAME here, in the SAME
      // preflight as the scan-identity match and BEFORE any state is attached. A
      // session whose extents match the scan (so `matchSessionToScan` returned
      // strong/partial, not conflict) can still declare a divergent up-axis, unit
      // or CRS — a Z-up survey re-exported Y-up keeps identical extents. Rebasing
      // geometry is TRANSLATION only, never rotation or rescale, so attaching a
      // session under the wrong frame lands every measurement silently wrong.
      // Detect the conflict against the FILE's own declaration and refuse the
      // whole restore, exactly as the identity `conflict` verdict does above,
      // rather than mutating the scene and disclosing after the fact. (The
      // "Apply anyway" path overrides identity CONFIDENCE only; a spatial-frame
      // conflict is a harder, different failure and is never waved through.)
      const declaredSpatial = declaredSpatialForActiveScan(viewer, deps);
      const spatial = detectSessionSpatialConflict(
        sessionSpatialClaimsOf(session),
        declaredSpatial,
      );
      // A persisted EXPLICIT user CRS override on a STRONGLY matched same scan is
      // the one case where a source-vs-session CRS (and its horizontal unit)
      // difference is EXPECTED, not corruption: the picker exists precisely so a
      // user can correct a file's declared CRS, and exportSession stores that
      // choice to round-trip it without re-prompting. Recognise it narrowly —
      // strong identity, an explicit user-override the user confirmed, and a
      // structurally usable override (local, or projected/geographic with a
      // finite EPSG) — and let a crs/unit conflict through. An UP-AXIS conflict is
      // a different, harder failure (a CRS picker never rotates geometry) and is
      // NEVER waved through; every other case keeps the existing hard refusal.
      const persistedOverride =
        match?.verdict === 'strong' &&
        !!session.crs &&
        session.crs.userConfirmed === true &&
        session.crs.source === 'user-override' &&
        (session.crs.kind === 'local' ||
          ((session.crs.kind === 'projected' || session.crs.kind === 'geographic') &&
            Number.isFinite(session.crs.epsg)));
      if (spatial.hasConflict) {
        const axisConflict = spatial.conflicts.some((c) => c.field === 'axis');
        if (!(persistedOverride && !axisConflict)) {
          const why = spatial.conflicts.map((c) => c.reason).join('; ');
          deps.showToast(
            `This session's spatial metadata conflicts with this scan (${why}) — it was not applied. ` +
              `The scan's own frame is kept; load the session on its own scan to restore it.`,
          );
          return false;
        }
      }
    }
    // A file with no project frame describes one scan, the one the summary
    // check just matched to the active layer; the one id it names is that
    // layer's. Then every saved id is rewritten to the open layer it maps to,
    // and work naming a layer that is not open (or is open more than once) is
    // held back, unplaced, to be written into the next save.
    const scanVerified = scanMatch?.verdict === 'strong' || (scanMatch?.verdict === 'partial' && !!opts.skipScanConfirm);
    const mapping = frameMapping
      ?? (live && !session.projectFrame && scanVerified && deps.getActiveLayerId()
        ? ownershipModule.mapSingleScanSession(session, deps.getActiveLayerId())
        : null);
    let work = session;
    let held: { measurements: Measurement[]; annotations: Annotation[] } = { measurements: [], annotations: [] };
    let waiting = 0;
    let ambiguous = 0;
    if (mapping && live) {
      const liveIds = new Set(live.map((l) => l.layerId));
      work = ownershipModule.remapSessionLayerIds(session, mapping, liveIds);
      const activeId = deps.getActiveLayerId();
      // The single scan's own id anchors its work in the session's one frame.
      if (!session.projectFrame && activeId && [...mapping.byId.values()].some((m) => m.kind === 'resolved')) work = { ...work, layerId: activeId };
      const unresolved = new Map<string, 'missing' | 'ambiguous'>();
      for (const [savedId, m] of mapping.byId) {
        if (m.kind !== 'resolved') unresolved.set(liveIds.has(savedId) ? `${savedId}~unmatched` : savedId, m.kind);
      }
      const part = ownershipModule.partitionHeldWork(work, unresolved);
      work = { ...work, measurements: part.measurements, annotations: part.annotations };
      held = part.held;
      waiting = part.missing;
      ambiguous = part.ambiguous;
    }
    const geo = haveCloud
      ? rebaseSessionGeometry(work, deps.exportOrigin(), { layerOrigin: deps.layerOrigin, projectOrigin: deps.projectOrigin?.() ?? null })
      : {
          measurements: session.measurements,
          annotations: session.annotations,
          views: session.views,
          camera: session.camera,
          clip: session.clip,
          delta: [0, 0, 0] as const,
          unrebased: [] as readonly string[],
          refused: [] as readonly string[],
        };
    const rebased = geo.delta[0] !== 0 || geo.delta[1] !== 0 || geo.delta[2] !== 0;
    // The scan could have been swapped in under us since we matched (this import
    // routes ahead of the loading guard). Refuse to attach the session's state
    // to a scan it was never matched against. (mirrors the 1723/1808 guard.)
    //
    // The ownership migrator is a lazy import that yields, so it is loaded here,
    // before the one check that guards every mutation below. The check also
    // covers a scene that was empty when the import started: a scan opened
    // since then was never matched or rebased against, so the import starts
    // over and matches against it.
    // Lazy: the ownership migrator lives off the index chunk — session restore is
    // on-demand, so its cost belongs on the restore path, not the initial load.
    const { migrateSessionOwnership } = ownershipModule;
    const targetChanged = (): boolean =>
      deps.getActiveScanId() !== targetId ||
      viewer.streamingCloud !== targetStreamingCloud ||
      (targetId ? viewer.getCloud(targetId) : undefined) !== targetStaticCloud;
    if (targetChanged()) {
      if (!haveCloud) return importSession(file, opts, deps);
      deps.showToast('Session not applied — the active scan changed while it was importing.');
      return false;
    }
    // The file is parsed, matched and rebased by here, so a bad file has
    // changed nothing. If it would replace work already open, ask first; the
    // CRS override below is the first change.
    if (deps.confirmReplace && !opts.reapply) {
      const identical = sameSessionWork(
        { measurements: viewer.measure.getMeasurements(), annotations: viewer.annotate.getAnnotations(), views: deps.currentViews?.() ?? [] },
        geo,
      );
      const outcome = await deps.confirmReplace({ kind: 'import', name: file.name, identical });
      if (outcome === 'cancel') {
        deps.showToast('Session not imported. Your current work is unchanged.');
        return false;
      }
      if (outcome === 'replace' && targetChanged()) {
        deps.showToast('Session not applied — the active scan changed while it was importing.');
        return false;
      }
    }
    // Commit the author's CRS override HERE — after every preflight and the
    // active-scan guard, but BEFORE any state that derives physical units is
    // hydrated — so measurements/reporting never render under source CRS A and
    // then flip to B. The frame was already validated (or waved through as an
    // explicit persisted override) in the preflight, so a divergent up-axis has
    // already refused. A projected/geographic override needs its EPSG; a local
    // override is epsg-less by definition (the old `epsg != null` gate dropped a
    // saved "Local coordinates" choice, so it never round-tripped — C4); an
    // unknown CRS still leaves the file's own. The override is restored through
    // CrsService.setOverride() by KIND + EPSG only: the service canonicalises the
    // resolved CRS, so a hand-edited session cannot install arbitrary serialized
    // WKT/unit as trusted state. `detected` is the ACTIVE scan's own declared CRS
    // — the streaming source's `crs()` when streaming, so compound/vertical
    // metadata reconstruction is not lost to `undefined`.
    // A CRS is restored only when the file records it as a choice the user
    // confirmed (`userConfirmed` with source `user-override`): a session is
    // untrusted input, and a CRS it merely names would otherwise rescale every
    // measurement made under it. A catalogue-asserted or file-derived CRS is not
    // the user's choice, so it is never restored as one; the scan's own record
    // resolves it again on open. The restored override applies for this app
    // session only (`persist: false`): it is written to the device's CRS store
    // only when the user keeps it, through the toast action below or the
    // Inspector. When it changes the scan's CRS or unit the user is told.
    const sessionCrs = session.crs;
    if (
      sessionCrs &&
      sessionCrs.userConfirmed === true &&
      sessionCrs.source === 'user-override' &&
      (sessionCrs.kind === 'local' ||
        ((sessionCrs.kind === 'projected' || sessionCrs.kind === 'geographic') &&
          sessionCrs.epsg != null))
    ) {
      const activeStreaming = viewer.streamingCloud;
      const activeStaticId = deps.getActiveScanId();
      const override = {
        override: { epsg: sessionCrs.epsg ?? null, kind: sessionCrs.kind },
        detected: activeStreaming
          ? activeStreaming.crs() ?? undefined
          : activeStaticId
            ? viewer.getCloud(activeStaticId)?.metadata?.crs ?? undefined
            : undefined,
        source: 'user-override' as const,
      };
      const declared = declaredSpatialForActiveScan(viewer, deps);
      deps.setCrsOverride({ ...override, persist: false });
      const sameAsFile =
        sessionCrs.kind === 'local'
          ? declared.epsg === undefined
          : declared.epsg === sessionCrs.epsg &&
            (declared.linearUnitToMetres === undefined || declared.linearUnitToMetres === sessionCrs.linearUnitToMetres);
      if (!sameAsFile) {
        const unit = sessionCrs.kind === 'local' ? 'no linear unit' : sessionCrs.linearUnit;
        deps.showToast(
          `This session set the coordinate system to ${sessionCrs.name} (${unit}). ` +
            'It applies to this scan for now and is not saved on this device.',
          {
            label: 'Keep',
            // Only for the scan it was applied to: the override acts on whichever scan is active.
            onClick: () => {
              if (viewer.streamingCloud === activeStreaming && deps.getActiveScanId() === activeStaticId) {
                deps.setCrsOverride({ ...override, persist: true });
              }
            },
          },
        );
      }
    }

    // Import-side ownership resolution (#22). Work restored from a session must
    // carry the identity of the layer it belongs to among whatever is open now,
    // not the saved file's layer id. `matchSessionToScan` above already refused
    // an import whose scan does not match the loaded one, so the active layer IS
    // the owner of every item the file left unowned; resolve it from source facts
    // (never the scan/viewer id) and stamp it. This only fills ownership the file
    // omitted — declared owners are left exactly as written — and it records
    // metadata about which frame the coordinates are already in, so it moves no
    // geometry. When the active layer carries no proven identity, the work is
    // left unattributed rather than given a guessed owner (fail closed).
    const ownership = migrateSessionOwnership(work, {
      loadedLayerId: deps.getActiveLayerId() ?? undefined,
    });
    const measureOwners = new Map<string, WorkOwnership>();
    for (const m of ownership.measurements) if (m.owner) measureOwners.set(m.id, m.owner);
    const annotationOwners = new Map<string, WorkOwnership>();
    for (const a of ownership.annotations) if (a.owner) annotationOwners.set(a.id, a.owner);
    // Declared owners that name an open layer are restated the way this scene
    // holds work on that layer, so the next save writes a file the next import
    // reads back in the same place. Only after the ids were mapped: an owner
    // that was never matched is left exactly as the file wrote it.
    let restoredMeasurements: Measurement[] = geo.measurements;
    let restoredAnnotations: Annotation[] = geo.annotations;
    if (mapping && live && haveCloud) {
      const unrebased = new Set(geo.unrebased);
      const evidence = new Map(live.map((l) => [l.layerId, l]));
      const exportOrigin = deps.exportOrigin();
      const normalized = ownershipModule.normalizeRestoredOwners(
        geo.measurements,
        geo.annotations,
        (id, owner) => (unrebased.has(id) ? 'source' : owner.frame === 'project' ? 'layer' : 'export'),
        session.upAxis,
        {
          liveIds: new Set(evidence.keys()),
          hasProjectFrame: savesProjectFrame(viewer.clouds().length, live, deps.layerOrigin),
          layerOrigin: (id) => deps.layerOrigin?.(id) ?? null,
          exportOrigin: [exportOrigin[0], exportOrigin[1], exportOrigin[2]],
          sourceOrigin: (id) => evidence.get(id)?.sourceOrigin ?? null,
        },
      );
      restoredMeasurements = normalized.measurements;
      restoredAnnotations = normalized.annotations;
    }
    const ownedMeasurements = restoredMeasurements.map((m) =>
      m.owner || !measureOwners.has(m.id) ? m : { ...m, owner: measureOwners.get(m.id) },
    );
    const ownedAnnotations = restoredAnnotations.map((a) =>
      a.owner || !annotationOwners.has(a.id) ? a : { ...a, owner: annotationOwners.get(a.id) },
    );
    viewer.measure.loadMeasurements(ownedMeasurements);
    // Profiles and volumes cut along an up axis the reopened layer no longer
    // resolves to are re-cut along its frame, or withheld with the reason.
    const recut = viewer.measure.recutDerived?.() ?? { recut: 0, withheld: 0 };
    const axisNote = sessionUpAxisNote({ recorded: session.upFrame, formatAxis: session.upAxis, live: haveCloud ? deps.activeUpFrame?.() ?? null : null, recut });
    viewer.annotate.loadAnnotations(ownedAnnotations);
    applied = true;
    // Work that names a scan not open here is kept, unplaced, with the frame
    // records it is read through, and written back by the next save. A file
    // with no project frame is one frame at its origin, so its held work gets
    // records at that origin. Work it marks as project-frame cannot be placed
    // in any frame (the file does not say where that frame was) and is
    // reported as not restored.
    const heldFrame = work.projectFrame;
    let frameless = 0;
    let framelessHeld = 0;
    if (!heldFrame) {
      const placeable = <T extends { owner?: WorkOwnership }>(x: T): boolean => x.owner?.frame !== 'project';
      const kept = { measurements: held.measurements.filter(placeable), annotations: held.annotations.filter(placeable) };
      framelessHeld = kept.measurements.length + kept.annotations.length;
      frameless = held.measurements.length + held.annotations.length - framelessHeld;
      held = kept;
    }
    if (held.measurements.length + held.annotations.length > 0) {
      const named = heldLayerIds(held);
      holdSessionWork({
        upAxis: session.upAxis,
        projectOrigin: heldFrame ? heldFrame.projectOrigin : [session.origin[0], session.origin[1], session.origin[2]],
        layers: heldFrame ? heldFrame.layers.filter((l) => named.has(l.layerId)) : ownershipModule.framelessHeldRecords(work, named),
        // Held work moves between frame records before it is placed; its
        // stored heights move only along the axis they were cut along.
        measurements: heldCutAxes(held.measurements, session.upFrame, session.layerId ?? null),
        annotations: held.annotations,
      });
    } else {
      holdSessionWork(null);
    }
    // With no scan open the work waits, in the session's own frame, for its
    // scan; the next fresh open applies this file again onto that scan.
    markPendingSessionRestore(haveCloud ? null : file);
    // v7 — a view may carry a display bundle beyond its camera; hydrate it
    // into the in-memory shape so restoring by name reapplies the lot. A
    // v6 file's views have no bundle fields, so `buildViewState` returns
    // undefined and they stay exactly the camera-only bookmarks they were.
    deps.bookmarks.restore(
      geo.views.map((v) => {
        const { name, camera, ...state } = v;
        return { name, pose: camera, state: buildViewState(state) };
      }),
    );
    deps.setInspectorViews(deps.bookmarks.names());
    // Groups are additive within v8: a file written before the field existed
    // carries none, and the panel is left exactly as the user arranged it.
    // Members are read through the id mapping, so they name the open layers.
    if (work.layerGroups) deps.restoreLayerGroups(work.layerGroups);
    // A view setting, additive within v8: absent leaves the plane as it is.
    if (session.referencePlane) deps.restoreReferencePlane?.(session.referencePlane);
    deps.refreshMeasurePanel();
    deps.refreshAnnotationPanel();

    // Apply the optional GLOBAL state when present — through the SAME
    // applyViewState path a named view restore uses (the extraction that
    // replaced the old inline field-by-field block here). Each field is
    // independently guarded so a partial file (e.g. a camera but no render
    // settings) restores what's there without assuming the rest, and the
    // camera is applied LAST so nothing re-frames after it. A v1 / v2 file
    // has none of these — fall through to the existing behaviour.
    deps.applyViewState({
      render: session.render,
      colorMode: session.colorMode,
      classFilter: session.classFilter,
      pointFilters: session.pointFilters,
      clip: geo.clip,
      camera: geo.camera,
    });

    // Honest disclosure: the session carries the saved analysis, not the scan
    // itself (a point cloud can't travel in the file). If its scan isn't
    // loaded, the restored measurements/annotations have nothing to sit on —
    // say so and point the user at the file to drop, rather than restoring onto
    // an empty scene silently.
    const restored =
      geo.measurements.length + geo.annotations.length + geo.views.length;
    const waitingFor = unmatchedNames(held, work.projectFrame, mapping, 'missing');
    const wantFile = session.scanSummary?.fileName;
    // When the user reached here via "Apply anyway", record that the restore
    // proceeded on an unverified scan match rather than a confirmed one.
    const appliedNote = opts.skipScanConfirm ? ' Applied despite an unverified scan match.' : '';
    // Disclosure when the session was captured in a different scan's frame and
    // its geometry was shifted to line up with the loaded cloud — an honest
    // note that a non-obvious transform happened, not a silent relocation.
    const frameNote = rebased
      ? ' Its measurements were realigned to the loaded scan’s origin.'
      : '';
    // Work the file marks as placed in a project frame it does not record is
    // left out, because there is no way to tell where that frame was anchored.
    const refusedCount = geo.refused.length;
    const refusedNote = (refusedCount > 0
      ? ` ${refusedCount} item${refusedCount === 1 ? ' was' : 's were'} not restored: ` + (session.projectFrame
        ? 'the session’s project frame has no record of the scan they were placed on.'
        : 'the session does not record the multi-scan project frame they were placed in.')
      : '')
      + (frameless > 0
        ? ` ${frameless} item${frameless === 1 ? ' was' : 's were'} not restored: the session names several scans `
          + 'but records no project frame to tell them apart.'
        : '')
      + (framelessHeld > 0
        ? ` ${framelessHeld} item${framelessHeld === 1 ? ' names' : 's name'} several scans and the session records no project frame `
          + `to tell them apart, so ${framelessHeld === 1 ? 'it was' : 'they were'} not placed. Saving the session keeps `
          + (framelessHeld === 1 ? 'it.' : 'them.')
        : '')
      + (heldFrame && waiting > 0
        ? ` ${waiting} item${waiting === 1 ? ' is' : 's are'} waiting for ${waiting === 1 ? 'its scan' : 'their scans'}`
          + (waitingFor.length > 0 ? ` (${waitingFor.join(', ')})` : '')
          + ': open it and import the session again. Saving the session keeps '
          + (waiting === 1 ? 'it.' : 'them.')
        : '')
      + (heldFrame && ambiguous > 0
        ? ` ${ambiguous} item${ambiguous === 1 ? ' names a scan' : 's name scans'} that more than one open scan matches, `
          + `so ${ambiguous === 1 ? 'it was' : 'they were'} not placed. Saving the session keeps `
          + (ambiguous === 1 ? 'it.' : 'them.')
        : '');
    // Evidence Capsule: lead with the honesty roll-up when the shared session
    // carries graded measurements — the recipient sees the trust picture, not
    // just a count.
    const evidence = summarizeMeasurementTrust(geo.measurements.map((m) => m.trust));
    const lead = evidence.total > 0 ? `Evidence restored — ${evidence.line}.` : null;
    // Verify the embedded processing manifest and disclose one integrity line.
    // This never rejects the session (an absent, legacy, or tampered manifest
    // still restores every measurement) — it only appends to the disclosure.
    // Lazily loaded so the hash-chain verifier (canonicalize + sha256) stays
    // out of the eager boot shell — session import is already an async action.
    // The restore is already committed above: bookmarks, the view state and the
    // measurements are in place. This await is a lazy chunk import, and a chunk
    // that will not load (offline, evicted, blocked) rejects. Letting it reach
    // the outer catch reported "Could not import the session" over a session
    // that had in fact been restored, which is the one thing the comment above
    // says this step must never do. A disclosure that cannot be computed is
    // left off the line instead.
    let manifestSuffix = '';
    try {
      const { verifySessionManifest, sessionManifestNote } = await loadVerifySessionManifest();
      const manifestNote = sessionManifestNote(verifySessionManifest(session.processingManifest));
      if (manifestNote) manifestSuffix = ` ${manifestNote}`;
    } catch {
      // Nothing to report: the disclosure is an addition to the toast, and the
      // session it would have described is already restored.
    }
    if (wantFile && !haveCloud) {
      deps.showToast((lead ?? `Session restored — drop “${wantFile}” to view its scan.`) + manifestSuffix,
        lead ? { label: 'Need the scan', onClick: () => deps.showToast(`Drop “${wantFile}” to view this evidence on its scan.`) } : undefined);
    } else if (lead) {
      deps.showToast(`${lead}${frameNote}${axisNote}${refusedNote}${appliedNote}${manifestSuffix}`);
    } else {
      deps.showToast(
        `Session restored — ${restored} item${restored === 1 ? '' : 's'} ` +
          `(measurements, annotations, views).${frameNote}${axisNote}${refusedNote}${appliedNote}${manifestSuffix}`,
      );
    }
  } catch (err) {
    deps.setDropError(err instanceof Error ? err.message : 'Could not import the session');
  }
  return applied;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Restore held session work onto a scan opened after the import.
 *
 * `openedLayerId` is the stable id of the layer that has just opened. The held
 * records are mapped onto the open layers under the import's own rule (exact
 * fingerprint, file origin, axis and EPSG), and an item is restored only when
 * every layer it names maps to an open layer and one of them is the opened
 * one. Restored items are rebased and restated exactly as the import places
 * them, and leave the held store; the rest stay held, to be written back by
 * the next save. Returns how many items were restored.
 */
export async function restoreHeldSessionWork(deps: SessionIoDeps, openedLayerId: string | null): Promise<number> {
  const held = heldSessionWork();
  if (!held || !openedLayerId || !deps.liveLayers) return 0;
  const [{ rebaseSessionGeometry }, own] = await Promise.all([deps.loadSession(), loadSessionOwnership(), deps.viewerReady]);
  // Another import or a reset may have replaced the held work meanwhile.
  if (heldSessionWork() !== held) return 0;
  const live = deps.liveLayers();
  if (!live.some((l) => l.layerId === openedLayerId)) return 0;
  const frame = { projectOrigin: held.projectOrigin, layers: held.layers };
  const mapping = own.mapSessionLayers(frame, live);
  const target = held.layers.find((l) => {
    const m = mapping.byId.get(l.layerId);
    return m?.kind === 'resolved' && m.liveId === openedLayerId;
  });
  if (!target) return 0;
  const viewer = deps.getViewer();
  const liveIds = new Set(live.map((l) => l.layerId));
  const session: InspectionSession = {
    app: 'OpenLiDARViewer', kind: 'measurement-session', version: 8, upAxis: held.upAxis,
    origin: [held.projectOrigin[0], held.projectOrigin[1], held.projectOrigin[2]], unitSystem: viewer.measure.unitSystem,
    views: [], measurements: [...held.measurements], annotations: [...held.annotations], projectFrame: frame,
  };
  const work = own.remapSessionLayerIds(session, mapping, liveIds);
  const unresolved = new Map<string, 'missing' | 'ambiguous'>();
  for (const [savedId, m] of mapping.byId) {
    if (m.kind !== 'resolved') unresolved.set(liveIds.has(savedId) ? `${savedId}~unmatched` : savedId, m.kind);
  }
  const part = own.partitionHeldWork(work, unresolved);
  // Only work on the scan that has just opened, and never over an item already in the scene.
  const takenIds = new Set([...viewer.measure.getMeasurements().map((m) => m.id), ...viewer.annotate.getAnnotations().map((a) => a.id)]);
  const onOpened = (x: { id: string; owner?: WorkOwnership; pickLayers?: readonly string[] }): boolean =>
    !takenIds.has(x.id) && (x.owner?.layerId === openedLayerId || (x.pickLayers ?? []).includes(openedLayerId));
  const geo = rebaseSessionGeometry(
    { ...work, measurements: part.measurements.filter(onOpened), annotations: part.annotations.filter(onOpened) },
    deps.exportOrigin(),
    { layerOrigin: deps.layerOrigin, projectOrigin: deps.projectOrigin?.() ?? null },
  );
  const unrebased = new Set(geo.unrebased);
  const evidence = new Map(live.map((l) => [l.layerId, l]));
  const exportOrigin = deps.exportOrigin();
  const placed = own.normalizeRestoredOwners(
    geo.measurements,
    geo.annotations,
    (id, owner) => (unrebased.has(id) ? 'source' : owner.frame === 'project' ? 'layer' : 'export'),
    held.upAxis,
    {
      liveIds,
      hasProjectFrame: savesProjectFrame(viewer.clouds().length, live, deps.layerOrigin),
      layerOrigin: (id) => deps.layerOrigin?.(id) ?? null,
      exportOrigin: [exportOrigin[0], exportOrigin[1], exportOrigin[2]],
      sourceOrigin: (id) => evidence.get(id)?.sourceOrigin ?? null,
    },
  );
  const restored = placed.measurements.length + placed.annotations.length;
  if (restored === 0) return 0;
  let recut = { recut: 0, withheld: 0 };
  if (placed.measurements.length > 0) {
    viewer.measure.loadMeasurements([...viewer.measure.getMeasurements(), ...placed.measurements]);
    recut = viewer.measure.recutDerived?.() ?? recut;
  }
  if (placed.annotations.length > 0) viewer.annotate.loadAnnotations([...viewer.annotate.getAnnotations(), ...placed.annotations]);
  // The rest stay held exactly as they were, with the records they name.
  const done = new Set([...placed.measurements.map((m) => m.id), ...placed.annotations.map((a) => a.id)]);
  const rest = { measurements: held.measurements.filter((m) => !done.has(m.id)), annotations: held.annotations.filter((a) => !done.has(a.id)) };
  const named = heldLayerIds(rest);
  holdSessionWork({ ...held, layers: held.layers.filter((l) => named.has(l.layerId)), ...rest });
  deps.refreshMeasurePanel();
  deps.refreshAnnotationPanel();
  const left = rest.measurements.length + rest.annotations.length;
  deps.showToast(
    `Restored ${plural(placed.measurements.length, 'measurement')} and ${plural(placed.annotations.length, 'annotation')} `
      + `from the session onto “${target.sourceName || 'the opened scan'}”.`
      + (left > 0 ? ` ${plural(left, 'item')} ${left === 1 ? 'is' : 'are'} still waiting for another scan.` : '')
      + sessionUpAxisNote({ recorded: undefined, formatAxis: held.upAxis, live: null, recut }),
  );
  return restored;
}
