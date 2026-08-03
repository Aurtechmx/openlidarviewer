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
import type {
  InspectionSession,
  RebasedSessionGeometry,
  ScanFacts,
  ScanMatch,
  SessionScanSummary,
} from '../io/session';

/** The streaming-source slice `scanFactsFromStreaming` reads — a structural subset of {@link StreamingSource}. */
export interface StreamingScanSource {
  readonly name: string;
  readonly sourcePointCount: number;
  dataBounds(): readonly [number, number, number, number, number, number];
  crs(): { readonly name?: string; readonly epsg?: number } | null | undefined;
}

/** The static-cloud slice `scanFactsFromStatic` reads — a structural subset of {@link PointCloud}. */
export interface StaticScanCloud {
  readonly name: string;
  readonly pointCount: number;
  bounds(): {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  readonly metadata?: {
    readonly crs?: { readonly name?: string; readonly epsg?: number } | null;
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
 * {@link scanFactsFromStreaming}: extent spans from `bounds()`, point count and
 * CRS from the cloud's own header metadata.
 */
export function scanFactsFromStatic(cloud: StaticScanCloud): ScanFacts {
  const b = cloud.bounds();
  return {
    fileName: cloud.name,
    sourcePoints: cloud.pointCount,
    width: b.max[0] - b.min[0],
    depth: b.max[1] - b.min[1],
    height: b.max[2] - b.min[2],
    crs: cloud.metadata?.crs?.name,
    epsg: cloud.metadata?.crs?.epsg,
  };
}

/** The three pure session functions `importSession` resolves lazily (from `../io/session`). */
export interface SessionModule {
  parseSession: (text: string) => InspectionSession;
  rebaseSessionGeometry: (
    session: InspectionSession,
    cloudOrigin: readonly [number, number, number],
  ) => RebasedSessionGeometry;
  matchSessionToScan: (summary: SessionScanSummary | undefined, loaded: ScanFacts) => ScanMatch;
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
  /** The active static cloud, or null (streaming / no scan). */
  getActiveCloud: () => PointCloud | null;
  /** The source-frame origin the session's geometry is rebased against (`exportGeoContext().origin`). */
  exportOrigin: () => readonly [number, number, number];
  /** Saved-view store: `restore` replaces the list, `names` feeds the Inspector. */
  bookmarks: Pick<ViewBookmarksService, 'restore' | 'names'>;
  /** Push the restored view names into the Inspector panel. */
  setInspectorViews: (names: string[]) => void;
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
    // The session path's imports are light (no three.js), so a session restore
    // can finish before the lazily-imported Viewer chunk resolves — leaving
    // `viewer` as its null sentinel. Await viewerReady so every `viewer.*`
    // access below is safe (measure/annotate are built in the Viewer ctor, so
    // no GPU backend is needed — just a non-null instance).
    await deps.viewerReady;
    const viewer = deps.getViewer();
    const { parseSession, rebaseSessionGeometry, matchSessionToScan } = await deps.loadSession();
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
      if (loadedFacts) {
        const match = matchSessionToScan(session.scanSummary, loadedFacts);
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
          deps.showToast(
            `This session's scan couldn't be fully verified${why ? ` (${why})` : ''}. ` +
              'Applying it may place its measurements on the wrong scan.',
            { label: 'Apply anyway', onClick: () => void importSession(file, { skipScanConfirm: true }, deps) },
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
    viewer.measure.loadMeasurements(geo.measurements);
    viewer.annotate.loadAnnotations(geo.annotations);
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
    if (
      session.crs &&
      session.crs.epsg != null &&
      (session.crs.kind === 'projected' || session.crs.kind === 'geographic' || session.crs.kind === 'local')
    ) {
      // Restore the author's CRS override so a capsule round-trips without
      // re-prompting — but NEVER over a scan that declares a DIFFERENT code.
      // The scan-identity match already conflicts on differing codes; this
      // guard covers the remaining hole, a scan whose declaration exists but
      // was absent from the session summary. A file that states its own CRS is
      // stronger evidence than a session written who-knows-where, so the
      // declaration wins and the session's choice is dropped with a note.
      const declared =
        viewer.streamingCloud?.crs()?.epsg ??
        (deps.getActiveScanId() ? viewer.getCloud(deps.getActiveScanId()!)?.metadata?.crs?.epsg : undefined);
      if (declared != null && declared !== session.crs.epsg) {
        deps.showToast(
          `The session's CRS (EPSG:${session.crs.epsg}) was not applied — this scan declares EPSG:${declared}, and a file's own declaration wins.`,
        );
      } else {
        deps.setCrsOverride({
          override: { epsg: session.crs.epsg, kind: session.crs.kind },
          detected: deps.getActiveScanId()
            ? viewer.getCloud(deps.getActiveScanId()!)?.metadata?.crs ?? undefined
            : undefined,
          source: 'user-override',
        });
      }
    }

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
    if (wantFile && !haveCloud) {
      deps.showToast(lead ?? `Session restored — drop “${wantFile}” to view its scan.`,
        lead ? { label: 'Need the scan', onClick: () => deps.showToast(`Drop “${wantFile}” to view this evidence on its scan.`) } : undefined);
    } else if (lead) {
      deps.showToast(`${lead}${frameNote}${appliedNote}`);
    } else {
      deps.showToast(
        `Session restored — ${restored} item${restored === 1 ? '' : 's'} ` +
          `(measurements, annotations, views).${frameNote}${appliedNote}`,
      );
    }
  } catch (err) {
    deps.setDropError(err instanceof Error ? err.message : 'Could not import the session');
  }
}
