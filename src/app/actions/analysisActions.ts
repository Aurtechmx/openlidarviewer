/**
 * analysisActions.ts
 *
 * Terrain analysis, Contour Studio and the Dataset Story. The analysis
 * entry and the story inputs are the whole surface.
 */
import type { Action } from '../../ui/actionRegistry';
import { openTerrainAnalysis, type TerrainAnalysisEntryDeps } from '../openTerrainAnalysis';
import { buildScanStory, type ScanStoryInputs } from '../../intelligence/scanStory';
import { renderDatasetStoryCard } from '../../ui/scanStoryViews';
import { openModal } from '../../ui/Modal';

export interface AnalysisActionDeps {
  /** How to reach the Analyse panel and its run; see {@link openTerrainAnalysis}. */
  terrainAnalysisEntry: TerrainAnalysisEntryDeps;
  buildCurrentStoryInputs: () => ScanStoryInputs;
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
