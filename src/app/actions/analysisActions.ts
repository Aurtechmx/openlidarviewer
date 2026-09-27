/**
 * analysisActions.ts
 *
 * Terrain analysis, Contour Studio, the Flow Pulse lab and the Dataset
 * Story. The analysis entry and the story inputs are the whole surface.
 */
import type { Action } from '../../ui/actionRegistry';
import { openTerrainAnalysis, type TerrainAnalysisEntryDeps } from '../openTerrainAnalysis';
import { buildScanStory, type ScanStoryInputs } from '../../intelligence/scanStory';
import { renderDatasetStoryCard } from '../../ui/scanStoryViews';
import { openModal } from '../../ui/Modal';
import { loadFlowPulseLab, loadObservatoryRun, loadTerrainAccessLab } from '../../lazyChunks';
import { createLazySurfaceLoader, type LazyLoadToast } from '../lazySurfaceLoad';
import type { ObservatoryEntryDeps } from '../openObservatoryRun';

export interface AnalysisActionDeps {
  /** How to reach the Analyse panel and its run; see {@link openTerrainAnalysis}. */
  terrainAnalysisEntry: TerrainAnalysisEntryDeps;
  /** How to reach the Observatory panel and its run; see {@link openObservatoryRun}. */
  observatoryEntry: ObservatoryEntryDeps;
  buildCurrentStoryInputs: () => ScanStoryInputs;
  /**
   * Where a Flow Pulse Lab chunk-load failure is reported, with a "Try
   * again" action (F7). Optional only because the current caller
   * (`src/app/actionDefinitions.ts`) does not thread `showLassoToast`
   * through to this contributor yet — until it does, a failure falls back
   * to `console.warn`, exactly as before.
   */
  showLassoToast?: LazyLoadToast;
}

export function contributeAnalysisActions(deps: AnalysisActionDeps): Action[] {
  const actions: Action[] = [];
  actions.push(
    {
      id: 'analyse.run',
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
        // The lab opens as a modal over the surface, so the rail keeps its mode;
        // a scan with no analysis gets the runner's own refusal, not a silent run.
        const load = () => Promise.all([deps.terrainAnalysisEntry.showPanel(), loadFlowPulseLab()])
          .then(([panel, lab]) => lab.openFlowPulseLab(panel.flowInput ?? null));
        const toast = deps.showLassoToast;
        if (toast) {
          // Named so a successful "Try again" re-runs the WHOLE attempt
          // (panel + chunk), not just the raw loader — otherwise a retry
          // that succeeds would refetch bytes nothing then opens the lab with.
          const attempt = (): void => { void createLazySurfaceLoader(toast)(load, 'Flow Pulse Lab', { retry: attempt }); };
          attempt();
        } else {
          void load().catch((err) => console.warn('[flow-pulse] lab chunk failed to load', err));
        }
      },
    },
    {
      id: 'analyse.terrainAccess',
      title: 'Terrain Access (Field Simulation Lab)',
      section: 'Analyse',
      hint: 'Screen a route over the analysed DTM against a declared mobility profile. Never a safety or passability guarantee.',
      keywords: ['terrain', 'access', 'route', 'mobility', 'traversability', 'astar', 'a*', 'simulation', 'lab'],
      run: () => {
        // The lab opens as a modal over the surface, so the rail keeps its mode;
        // a scan with no analysis gets the runner's own refusal, not a silent run.
        void Promise.all([deps.terrainAnalysisEntry.showPanel(), loadTerrainAccessLab()])
          .then(([panel, lab]) => lab.openTerrainAccessLab(panel.terrainAccessInput ?? null))
          .catch((err) => console.warn('[terrain-access] lab chunk failed to load', err));
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
        void loadObservatoryRun().then((mod) => mod.openObservatoryRun(deps.observatoryEntry, true));
      },
    },
    {
      id: 'story.dataset',
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
