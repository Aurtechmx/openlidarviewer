/**
 * toolActions.ts
 *
 * The tool dock's actions: Measure, Inspect, Annotate, the two derived
 * classification runs, and the lasso volume with its selection basis.
 */
import type { Action } from '../../ui/actionRegistry';
import type { Viewer } from '../../render/Viewer';
import type { WorkflowController } from '../../ui/WorkflowController';
import type { LassoVolumeTool } from '../../ui/LassoVolumeTool';
import { toggleTool } from '../toggleTool';
import { keyDisplayFor } from '../../ui/keyBindings';

export interface ToolActionDeps {
  getViewer: () => Viewer;
  workflowController: WorkflowController;
  lassoVolumeTool: LassoVolumeTool;
  syncLassoButton: () => void;
  runDeriveClassification: () => Promise<void>;
  runFillUnclassified: () => Promise<void>;
  showLassoToast: (message: string) => void;
}

export function contributeToolActions(deps: ToolActionDeps): Action[] {
  const actions: Action[] = [];
  actions.push(
    {
      id: 'tool.measure',
      title: 'Measure',
      section: 'Tools',
      hint: 'Activate the measurement toolbar.',
      keywords: ['distance', 'area', 'volume'],
      run: () => {
        toggleTool(deps.getViewer(), deps.workflowController, 'measure');
      },
    },
    {
      id: 'tool.inspect',
      title: 'Inspect point',
      section: 'Tools',
      hint: 'Read attributes of any point under the cursor.',
      keywords: ['point info', 'attributes'],
      run: () => {
        toggleTool(deps.getViewer(), deps.workflowController, 'inspect');
      },
    },
    {
      id: 'tool.annotate',
      title: 'Annotate',
      section: 'Tools',
      hint: 'Drop notes, info, warnings, or issues on points.',
      keywords: ['note', 'comment', 'mark'],
      run: () => {
        toggleTool(deps.getViewer(), deps.workflowController, 'annotate');
      },
    },
    {
      id: 'tool.classify',
      title: 'Classify (derive)',
      section: 'Tools',
      hint: 'Derive a ground / vegetation / building classification for an unclassified scan (heuristic).',
      keywords: ['classification', 'ground', 'vegetation', 'building', 'segment', 'auto'],
      run: () => {
        void deps.runDeriveClassification();
      },
    },
    {
      id: 'tool.fillUnclassified',
      title: 'Fill unclassified points (derive)',
      section: 'Tools',
      hint: 'Derive only the unclassified points of a partially-classified scan, preserving every producer class (heuristic).',
      keywords: ['classification', 'fill', 'gaps', 'unclassified', 'producer', 'preserve'],
      run: () => {
        void deps.runFillUnclassified();
      },
    },
    {
      id: 'tool.lasso-volume',
      title: 'Lasso volume',
      section: 'Tools',
      keys: keyDisplayFor('lasso-toggle'),
      hint: 'Draw a freeform shape to measure a 3D volume.',
      keywords: ['select', 'shape', 'cut', 'fill'],
      run: () => {
        if (deps.lassoVolumeTool.enabled) {
          deps.lassoVolumeTool.disable();
          deps.getViewer().clearSelectionHighlight();
          deps.showLassoToast('Lasso off — back to navigation.');
        } else {
          deps.lassoVolumeTool.enable();
          deps.showLassoToast('Lasso armed — draw a shape on the canvas.');
        }
        deps.syncLassoButton();
      },
    },
    {
      id: 'tool.lasso-selection-basis',
      title: 'Lasso selection basis',
      section: 'Tools',
      hint: 'Whether a lasso measures every depth along the ray or only the surfaces the camera can see.',
      keywords: ['occlusion', 'hidden', 'behind', 'depth', 'through', 'visible', 'volume'],
      run: () => {
        // Two different measurements of the same drawn shape, so the toast
        // names the one now armed rather than reporting a setting changed.
        const next =
          deps.lassoVolumeTool.selectionBasis === 'occluded-excluded'
            ? 'through-surfaces'
            : 'occluded-excluded';
        deps.lassoVolumeTool.selectionBasis = next;
        deps.showLassoToast(
          next === 'occluded-excluded'
            ? 'Lasso measures visible surfaces only — points hidden behind nearer ones are left out.'
            : 'Lasso measures all depths along the ray — points behind a surface are included.',
        );
      },
    },
  );
  return actions;
}
