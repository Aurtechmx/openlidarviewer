/**
 * sessionIo.ts — the session-restore orchestration lifted out of main.ts.
 *
 * `importSession` reads a saved `.olvsession`, verifies its stored scan
 * fingerprint against the loaded cloud, rebases its geometry into that cloud's
 * frame and applies the restored measurements / annotations / views / CRS /
 * camera. The pure halves it leans on already live in `../io/session`
 * (`parseSession`, `rebaseSessionGeometry`, `matchSessionToScan`) and are unit
 * tested there; what remained inline in main.ts was the imperative apply step
 * plus one pure adapter — turning the live loaded cloud into the `ScanFacts`
 * fingerprint the matcher compares against. That adapter is extracted here as
 * `scanFactsFromStreaming` / `scanFactsFromStatic` so it is Node-testable
 * without a Viewer, and the apply step is parameterised through
 * {@link SessionIoDeps} so the whole restore drives from plain fakes.
 *
 * main.ts keeps a thin caller that binds its own running state to the deps.
 * Part of the v0.6 decomposition (see `docs/architecture/architecture-map.md`).
 */

import type { Viewer } from '../render/Viewer';
import type { PointCloud } from '../model/PointCloud';
import type { ViewBookmarksService } from './viewBookmarks';
import type { CrsService } from '../geo/CrsService';
import type { ViewStateBundle } from '../io/viewState';
import { buildViewState } from '../io/viewState';
import { isExportStale, staleExportReason } from '../export/exportStaleness';
import { summarizeMeasurementTrust } from '../render/measure/measurementTrust';
import { isZUpFormat } from '../io/sniffFormat';
import type { SourceFormat } from '../io/sniffFormat';
import type { CrsLinearUnit } from '../io/crs';
import type {
  DeclaredSpatialFacts,
  InspectionSession,
  RebasedSessionGeometry,
  ScanFacts,
  ScanMatch,
  SessionLayerGroup,
  SessionScanSummary,
  SessionSpatialClaims,
  SessionSpatialVerdict,
} from '../io/session';
import type { WorkOwnership } from '../model/workOwnership';
import {
  loadSessionOwnership,
} from '../lazyChunks';

/**
 * Whole-file byte ceiling for a `.olvsession`, checked on the File's size BEFORE
 * it is read. A shared session is untrusted input, and `parseSession` runs
 * `JSON.parse` over the entire text — an unbounded file can exhaust memory
 * before the parser's per-dimension caps ever apply (and before the try/catch
 * can surface it). An inspection session is analysis metadata, not the scan, so
 * even a rich Evidence Capsule is a few MB; 256 MB is far above any real session
 * while bounding the parse. Over-limit is rejected onto the drop zone.
 */
export const MAX_SESSION_BYTES = 256 * 1024 * 1024;

/** The streaming-source slice `scanFactsFromStreaming` reads — a structural subset of {@link StreamingSource}. */
export interface StreamingScanSource {
  readonly name: string;
  readonly sourcePointCount: number;
  dataBounds(): readonly [number, number, number, number, number, number];
  crs():
    | { readonly name?: string; readonly epsg?: number; readonly linearUnit?: CrsLinearUnit }
    | null
    | undefined;
}

/** The static-cloud slice `scanFactsFromStatic` reads — a structural subset of {@link PointCloud}. */
export interface StaticScanCloud {
  readonly name: string;
  readonly pointCount: number;
  /**
   * Source-truth counts, preferred over the display-sampled `pointCount` for
   * identity. `declaredPointCount` is the file header's own total;
   * `decodedPointCount` is what the decoder read before any voxel downsample.
   * Both survive stride / downsample (see PointCloud), so a fingerprint built
   * from them does not shift with a device's point budget.
   */
  readonly declaredPointCount?: number;
  readonly decodedPointCount?: number;
  bounds(): {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  /** Source file format — drives the file's own up-axis (`isZUpFormat`). */
  readonly sourceFormat?: SourceFormat;
  readonly metadata?: {
    readonly crs?:
      | { readonly name?: string; readonly epsg?: number; readonly linearUnit?: CrsLinearUnit }
      | null;
  };
}

/**
 * Build the loaded-scan fingerprint from a streaming source — the input the
 * matcher compares a session's stored summary against. Pure: reads the source's
 * extent spans, point count, name and CRS, no DOM or render state. Extents come
 * from `dataBounds()` (the true data extent, not the footprint span).
 */
export function scanFactsFromStreaming(cloud: StreamingScanSource): ScanFacts {
  const b = cloud.dataBounds();
  const crs = cloud.crs();
  return {
    fileName: cloud.name,
    sourcePoints: cloud.sourcePointCount,
    width: b[3] - b[0],
    depth: b[4] - b[1],
    height: b[5] - b[2],
    crs: crs?.name,
    epsg: crs?.epsg,
  };
}

/**
 * Build the loaded-scan fingerprint from a static cloud. Pure counterpart to
 * {@link scanFactsFromStreaming}: point count from the source header, CRS from
 * the cloud's own header metadata, extent spans from `bounds()`.
 *
 * The point count is SOURCE truth, not the display sample. The held
 * `pointCount` is whatever survived this device's decode stride and voxel
 * downsample, so reading it here made a scan's identity change with the point
 * budget — the same file fingerprinted differently on mobile vs desktop, and a
 * valid session failed to match across devices. The streaming sibling already
 * reads `sourcePointCount` for exactly this reason; the static analog is the
 * header's declared total, falling to the pre-downsample decode count, then the
 * held count (the header count on top of the `decodedPointCount ?? pointCount`
 * ladder the Health Check uses). Both source-truth fields survive stride /
 * downsample (see PointCloud), so the fingerprint no longer moves with the
 * device.
 *
 * Extents (`width`/`depth`/`height`) are the residual: they still come from the
 * DECIMATED `bounds()`. A source/header extent is not reachable here — the
 * LAS/LAZ header min/max are read at load (`lasHeader.ts`) but consumed for the
 * origin and never persisted onto the cloud or its metadata, and threading a
 * header extent through every loader is out of scope for this change. So the
 * spans stay decimation-sensitive (stride / voxel sampling rarely lands on the
 * exact extremes) and an exact-match consumer must compare them with a
 * tolerance, never equality — as {@link matchSessionToScan} already does (its
 * 1 %/5 % extent bands). Only the count above is source-stable.
 */
export function scanFactsFromStatic(cloud: StaticScanCloud): ScanFacts {
  const b = cloud.bounds();
  return {
    fileName: cloud.name,
    sourcePoints: cloud.declaredPointCount ?? cloud.decodedPointCount ?? cloud.pointCount,
    width: b.max[0] - b.min[0],
    depth: b.max[1] - b.min[1],
    height: b.max[2] - b.min[2],
    crs: cloud.metadata?.crs?.name,
    epsg: cloud.metadata?.crs?.epsg,
  };
}

/**
 * The FILE's own spatial declaration from a streaming source — the source of
 * truth a restored session may not silently redefine (roadmap P1 #5). CRS code
 * and linear unit come off the source's `crs()`. Up-axis is intentionally left
 * unknown: COPC/EPT streaming sources don't surface a source format through the
 * `StreamingSource` seam, and they are z-up by construction, so there is nothing
 * to conflict against — the CRS and unit checks still run.
 */
export function declaredSpatialFromStreaming(cloud: StreamingScanSource): DeclaredSpatialFacts {
  const crs = cloud.crs();
  return { epsg: crs?.epsg, linearUnit: crs?.linearUnit };
}

/**
 * The FILE's own spatial declaration from a static cloud. Up-axis comes from the
 * source format the same way the renderer and session exporter derive it
 * (`isZUpFormat`), so the three can never disagree; CRS code and linear unit come
 * off the header metadata.
 */
export function declaredSpatialFromStatic(cloud: StaticScanCloud): DeclaredSpatialFacts {
  const crs = cloud.metadata?.crs;
  let upAxis: 'y' | 'z' | undefined;
  if (cloud.sourceFormat) {
    upAxis = isZUpFormat(cloud.sourceFormat) ? 'z' : 'y';
  } else {
    upAxis = undefined;
  }
  return {
    upAxis,
    epsg: crs?.epsg,
    linearUnit: crs?.linearUnit,
  };
}

/** The pure session functions `importSession` resolves lazily (from `../io/session`). */
export interface SessionModule {
  parseSession: (text: string) => InspectionSession;
  rebaseSessionGeometry: (
    session: InspectionSession,
    cloudOrigin: readonly [number, number, number],
  ) => RebasedSessionGeometry;
  matchSessionToScan: (summary: SessionScanSummary | undefined, loaded: ScanFacts) => ScanMatch;
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
  /** Re-render the measurements panel from the viewer's store. */
  refreshMeasurePanel: () => void;
  /** Re-render the annotations panel from the viewer's store. */
  refreshAnnotationPanel: () => void;
  /** Apply a global view-state bundle through the shared, camera-last path. */
  applyViewState: (vs: ViewStateBundle) => void;
  /** Restore the author's CRS override (`crsService.setOverride`). */
  setCrsOverride: (args: Parameters<CrsService['setOverride']>[0]) => void;
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
 * Import an inspection session: restore measurements, annotations and views.
 * `skipScanConfirm` is set only by the "Apply anyway" action after a partial
 * scan-identity match, so the same restore re-runs past the confirmation gate.
 */
export async function importSession(
  file: File,
  opts: { skipScanConfirm?: boolean },
  deps: SessionIoDeps,
): Promise<void> {
  try {
    // A shared `.olvsession` is untrusted; reject an over-large file up front,
    // before it is read, so `JSON.parse` of the whole text can't exhaust memory.
    // This is the whole-file ceiling; the parser's per-dimension caps (item
    // counts, per-measurement points) bound the rest once the JSON is in hand.
    if (file.size > MAX_SESSION_BYTES) {
      throw new Error(
        `This session file is too large (${Math.round(file.size / (1024 * 1024))} MB; ` +
          `limit ${Math.round(MAX_SESSION_BYTES / (1024 * 1024))} MB).`,
      );
    }
    // The session path's imports are light (no three.js), so a session restore
    // can finish before the lazily-imported Viewer chunk resolves — leaving
    // `viewer` as its null sentinel. Await viewerReady so every `viewer.*`
    // access below is safe (measure/annotate are built in the Viewer ctor, so
    // no GPU backend is needed — just a non-null instance).
    await deps.viewerReady;
    const viewer = deps.getViewer();
    const { parseSession, rebaseSessionGeometry, matchSessionToScan, detectSessionSpatialConflict } =
      await deps.loadSession();
    const session = parseSession(await file.text());
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
    // Guard the rebase: a session's geometry is local to the scan it was
    // captured over, so realigning it onto the loaded cloud is only correct when
    // that IS its scan. Compare the session's stored fingerprint (built the same
    // way exportSession writes it) against the loaded scan. A clear conflict is
    // refused rather than silently realigned onto the wrong scan; a partial
    // match asks the user to confirm before anything is applied.
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
        match = matchSessionToScan(session.scanSummary, loadedFacts);
        if (match.verdict === 'conflict') {
          const why = match.reasons[0] ?? 'its scan fingerprint does not match';
          const want = session.scanSummary?.fileName;
          deps.showToast(
            `This session was captured over a different scan (${why}) — it was not applied. ` +
              (want ? `Load “${want}” to restore it on its own scan.` : 'Load its source scan to restore it.'),
          );
          return;
        }
        if (match.verdict === 'partial' && !opts.skipScanConfirm) {
          // Not a clear conflict, but not a confirmed match — don't touch the
          // scene until the user opts in. "Apply anyway" re-imports with the
          // check skipped, so the same restore proceeds on their confirmation.
          const why = match.reasons[0] ?? '';
          const whyDetail = why ? ` (${why})` : '';
          deps.showToast(
            `This session's scan couldn't be fully verified${whyDetail}. ` +
              'Applying it may place its measurements on the wrong scan.',
            { label: 'Apply anyway', onClick: () => void importSession(file, { skipScanConfirm: true }, deps) },
          );
          return;
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
        { upAxis: session.upAxis, epsg: session.crs?.epsg, linearUnit: session.crs?.linearUnit },
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
          return;
        }
      }
    }
    const geo = haveCloud
      ? rebaseSessionGeometry(session, deps.exportOrigin())
      : {
          measurements: session.measurements,
          annotations: session.annotations,
          views: session.views,
          camera: session.camera,
          clip: session.clip,
          delta: [0, 0, 0] as const,
        };
    const rebased = geo.delta[0] !== 0 || geo.delta[1] !== 0 || geo.delta[2] !== 0;
    // The scan could have been swapped in under us since we matched (this import
    // routes ahead of the loading guard). Refuse to attach the session's state
    // to a scan it was never matched against. (mirrors the 1723/1808 guard.)
    if (
      haveCloud &&
      (deps.getActiveScanId() !== targetId ||
        viewer.streamingCloud !== targetStreamingCloud ||
        (targetId ? viewer.getCloud(targetId) : undefined) !== targetStaticCloud)
    ) {
      deps.showToast('Session not applied — the active scan changed while it was importing.');
      return;
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
    if (
      session.crs &&
      (session.crs.kind === 'local' ||
        ((session.crs.kind === 'projected' || session.crs.kind === 'geographic') &&
          session.crs.epsg != null))
    ) {
      const activeStreaming = viewer.streamingCloud;
      const activeStaticId = deps.getActiveScanId();
      deps.setCrsOverride({
        override: { epsg: session.crs.epsg ?? null, kind: session.crs.kind },
        detected: activeStreaming
          ? activeStreaming.crs() ?? undefined
          : activeStaticId
            ? viewer.getCloud(activeStaticId)?.metadata?.crs ?? undefined
            : undefined,
        source: 'user-override',
      });
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
    // Lazy: the ownership migrator lives off the index chunk — session restore is
    // on-demand, so its cost belongs on the restore path, not the initial load.
    const { migrateSessionOwnership } = await loadSessionOwnership();
    const ownership = migrateSessionOwnership(session, {
      loadedLayerId: deps.getActiveLayerId() ?? undefined,
    });
    const measureOwners = new Map<string, WorkOwnership>();
    for (const m of ownership.measurements) if (m.owner) measureOwners.set(m.id, m.owner);
    const annotationOwners = new Map<string, WorkOwnership>();
    for (const a of ownership.annotations) if (a.owner) annotationOwners.set(a.id, a.owner);
    const ownedMeasurements = geo.measurements.map((m) =>
      m.owner || !measureOwners.has(m.id) ? m : { ...m, owner: measureOwners.get(m.id) },
    );
    const ownedAnnotations = geo.annotations.map((a) =>
      a.owner || !annotationOwners.has(a.id) ? a : { ...a, owner: annotationOwners.get(a.id) },
    );
    viewer.measure.loadMeasurements(ownedMeasurements);
    viewer.annotate.loadAnnotations(ownedAnnotations);
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
    if (session.layerGroups) deps.restoreLayerGroups(session.layerGroups);
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
      session.measurements.length + session.annotations.length + session.views.length;
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
    // Evidence Capsule: lead with the honesty roll-up when the shared session
    // carries graded measurements — the recipient sees the trust picture, not
    // just a count.
    const evidence = summarizeMeasurementTrust(session.measurements.map((m) => m.trust));
    const lead = evidence.total > 0 ? `Evidence restored — ${evidence.line}.` : null;
    // Verify the embedded processing manifest and disclose one integrity line.
    // This never rejects the session (an absent, legacy, or tampered manifest
    // still restores every measurement) — it only appends to the disclosure.
    // Lazily loaded so the hash-chain verifier (canonicalize + sha256) stays
    // out of the eager boot shell — session import is already an async action.
    const { verifySessionManifest, sessionManifestNote } = await import(
      '../science/verifySessionManifest'
    );
    const manifestNote = sessionManifestNote(verifySessionManifest(session.processingManifest));
    const manifestSuffix = manifestNote ? ` ${manifestNote}` : '';
    if (wantFile && !haveCloud) {
      deps.showToast((lead ?? `Session restored — drop “${wantFile}” to view its scan.`) + manifestSuffix,
        lead ? { label: 'Need the scan', onClick: () => deps.showToast(`Drop “${wantFile}” to view this evidence on its scan.`) } : undefined);
    } else if (lead) {
      deps.showToast(`${lead}${frameNote}${appliedNote}${manifestSuffix}`);
    } else {
      deps.showToast(
        `Session restored — ${restored} item${restored === 1 ? '' : 's'} ` +
          `(measurements, annotations, views).${frameNote}${appliedNote}${manifestSuffix}`,
      );
    }
  } catch (err) {
    deps.setDropError(err instanceof Error ? err.message : 'Could not import the session');
  }
}
