/**
 * analysisActions.ts
 *
 * Terrain analysis, Contour Studio, the Flow Pulse lab and the Dataset
 * Story. The analysis entry and the story inputs are the whole surface.
 */
import { scanRequired, type Action } from '../../ui/actionRegistry';
import { openTerrainAnalysis, type TerrainAnalysisEntryDeps } from '../openTerrainAnalysis';
import { buildScanStory, type ScanStoryInputs } from '../../intelligence/scanStory';
import { renderDatasetStoryCard } from '../../ui/scanStoryViews';
import { openModal } from '../../ui/Modal';
import { loadFlowPulseLab, loadObservatoryRun, loadTerrainAccessLab } from '../../lazyChunks';
import { runWithRetry, type LazyLoadToast } from '../lazySurfaceLoad';
import type { ObservatoryEntryDeps } from '../openObservatoryRun';

export interface AnalysisActionDeps {
  /** How to reach the Analyse panel and its run; see {@link openTerrainAnalysis}. */
  terrainAnalysisEntry: TerrainAnalysisEntryDeps;
  /** How to reach the Observatory panel and its run; see {@link openObservatoryRun}. */
  observatoryEntry: ObservatoryEntryDeps;
  buildCurrentStoryInputs: () => ScanStoryInputs;
  /** Where a lab's chunk-load failure is reported, with a Try again that re-runs the whole attempt. */
  showLassoToast: LazyLoadToast;
  hasScan?: () => boolean;
}

type LabPanel = Awaited<ReturnType<TerrainAnalysisEntryDeps['showPanel']>>;

export function contributeAnalysisActions(deps: AnalysisActionDeps): Action[] {
  const actions: Action[] = [];
  const entry = deps.terrainAnalysisEntry;
  /**
   * One click to a lab result. With no terrain result yet (or when asked to
   * run it again) the lab's page shows progress while terrain runs, then the
   * lab opens on the new ground surface. A run that produces none leaves the
   * lab's own notice, which says so. A progress page closed while terrain ran
   * (the scan was closed) opens nothing: there is no scan to open the lab on.
   */
  const withGround = async (
    panel: LabPanel,
    force: boolean,
    preparing: (onClose: () => void) => { close(): void },
    open: (p: LabPanel) => void,
  ): Promise<void> => {
    if (panel.hasResult && !force) { open(panel); return; }
    let closed = false;
    const wait = preparing(() => { closed = true; });
    try {
      await entry.run();
      if (closed) return;
      open(await entry.showPanel());
    } finally {
      wait.close();
    }
  };
  actions.push(
    {
      id: 'analyse.run',
      get unavailable() { return scanRequired(deps.hasScan); },
      title: 'Run terrain analysis',
      section: 'Analyse',
      hint: 'Classify ground, build the DTM, validate it, and check contour readiness.',
      keywords: ['terrain', 'analysis', 'run', 'dtm', 'ground', 'surface', 'analyse'],
      run: () => {
        void openTerrainAnalysis(deps.terrainAnalysisEntry, true);
      },
    },
    {
      id: 'analyse.contours',
      get unavailable() { return scanRequired(deps.hasScan); },
      title: 'Create contours',
      section: 'Analyse',
      hint: 'Open Contour Studio. Terrain analysis runs first when the scan has not been analysed yet.',
      keywords: ['contour', 'contours', 'isoline', 'create', 'deliverable', 'lines', 'terrain'],
      run: () => {
        void openTerrainAnalysis(deps.terrainAnalysisEntry, false);
      },
    },
    {
      id: 'analyse.flowPulse',
      title: 'Flow Pulse (Field Simulation Lab)',
      section: 'Analyse',
      hint: 'Route flow over the analysed DTM with D8 and list what the run cannot claim.',
      keywords: ['flow', 'drainage', 'd8', 'routing', 'accumulation', 'simulation', 'lab', 'pulse'],
      run: () => {
        // The lab opens as its Analyse page beside the scene, running
        // terrain first when the scan has no analysis yet.
        const go = (force: boolean): void => {
          const load = () => Promise.all([entry.showPanel(), loadFlowPulseLab()])
            .then(([panel, lab]) => withGround(panel, force, (onClose) => lab.openFlowPulsePreparing(onClose), (p) => {
              lab.openFlowPulseLab(p.flowInput ?? null, { onRunTerrain: () => go(true) });
            }));
          runWithRetry(deps.showLassoToast, load, 'Flow Pulse Lab');
        };
        go(false);
      },
    },
    {
      id: 'analyse.terrainAccess',
      title: 'Terrain Access (Field Simulation Lab)',
      section: 'Analyse',
      hint: 'Screen a route over the analysed DTM against a declared mobility profile. Never a safety or passability guarantee.',
      keywords: ['terrain', 'access', 'route', 'mobility', 'traversability', 'astar', 'a*', 'simulation', 'lab'],
      run: () => {
        // The lab opens as its Analyse page beside the scene, running
        // terrain first when the scan has no analysis yet.
        const go = (force: boolean): void => {
          runWithRetry(deps.showLassoToast, () => Promise.all([entry.showPanel(), loadTerrainAccessLab()])
            .then(([panel, lab]) => withGround(panel, force, (onClose) => lab.openTerrainAccessPreparing(onClose), (p) => {
              lab.openTerrainAccessLab(p.terrainAccessInput ?? null, { onRunTerrain: () => go(true) });
            })), 'Terrain Access Lab');
        };
        go(false);
      },
    },
    {
      id: 'analyse.observatory',
      title: 'Observatory (observation evidence)',
      section: 'Analyse',
      hint: 'What this scan has actually observed, what is shadowed, and what remains unaddressed.',
      keywords: ['observatory', 'observation', 'evidence', 'shadow', 'coverage', 'stations', 'occlusion'],
      run: () => {
        // Dynamically imported, like Flow Pulse above: the coordinator pulls
        // in the whole O1-O8 kernel (rays, ledger, states, shadow-frontier,
        // run record), which must stay out of the action-registry chunk.
        runWithRetry(deps.showLassoToast, () => loadObservatoryRun().then((mod) => mod.openObservatoryRun(deps.observatoryEntry, true)), 'Observatory');
      },
    },
    {
      id: 'story.dataset',
      get unavailable() { return scanRequired(deps.hasScan); },
      title: 'Dataset Story',
      section: 'Analyse',
      hint: 'What this scan is, how good it is, what it is best for, and the next step.',
      keywords: ['story', 'fitness', 'summary', 'overview', 'what is this', 'good for'],
      run: () => {
        openModal({ title: 'Dataset Story', body: renderDatasetStoryCard(buildScanStory(deps.buildCurrentStoryInputs())) });
      },
    },
  );
  return actions;
}
