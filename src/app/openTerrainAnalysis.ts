/**
 * openTerrainAnalysis.ts — one entry into terrain analysis and its contours.
 *
 * Both live behind the Analyse panel, which opens from the tool dock: to reach
 * contours you had to know that terrain analysis produces them and that its
 * launcher appears inside that panel once a run finishes. This routes either
 * request the same way — show the panel, run when there is no result yet — so
 * the command palette can offer "Run terrain analysis" and "Create contours"
 * as two entries that both land somewhere useful from a cold start.
 */

import type { FlowPulseLabInput } from '../ui/fieldSimulation/flowPulseLab';
import type { TerrainAccessLabInput } from '../ui/fieldSimulation/terrainAccessLab';

export interface TerrainAnalysisEntryDeps {
  /** Switch the workspace to its Analyse mode, when the shell has one. */
  readonly showAnalyseMode: () => void;
  /** Mount (or reuse) the Analyse panel and make it visible. */
  readonly showPanel: () => Promise<{
    hasResult: boolean;
    /** The analysed surface a flow run reads; see `AnalysePanel.flowPulseInput`. */
    flowInput?: FlowPulseLabInput | null;
    /** The analysed surface a Terrain Access run reads; see `AnalysePanel.terrainAccessInput`. */
    terrainAccessInput?: TerrainAccessLabInput | null;
  }>;
  /** Show an Analyse page once the panel is up, when the shell has pages. */
  readonly showPage?: (page: 'terrain' | 'contours') => void;
  /** Run terrain analysis over the active scan. */
  readonly run: () => void;
}

/**
 * Open the Analyse panel on its Terrain page, or on Contours when asking for
 * contours on an analysed scan. `rerun` forces a fresh run; otherwise the run fires
 * only when no result is on the panel, so asking for contours on an analysed
 * scan reveals what is already there instead of recomputing it.
 */
export async function openTerrainAnalysis(
  deps: TerrainAnalysisEntryDeps,
  rerun = false,
): Promise<void> {
  deps.showAnalyseMode();
  const { hasResult } = await deps.showPanel();
  // Contours land on their page only when a result exists; a run shows on Terrain.
  deps.showPage?.(!rerun && hasResult ? 'contours' : 'terrain');
  if (rerun || !hasResult) deps.run();
}
