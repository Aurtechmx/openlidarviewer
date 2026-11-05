/**
 * workflowActions.ts
 *
 * The workflow recorder: start, stop and save, replay a file, settings.
 * Absent from the registry when the feature flag is off, not merely inert.
 */
import type { Action } from '../../ui/actionRegistry';
import { COUNTDOWN_CANCELLED, WORKFLOW_RECORDER_ENABLED, saveWorkflowWithToast, type WorkflowController } from '../../ui/WorkflowController';
import type { WorkflowConfigPanel } from '../../ui/WorkflowConfigPanel';
import type { WorkflowEvent } from '../../render/workflow/workflowRecorder';
import { keyDisplayFor } from '../../ui/keyBindings';
import { el } from '../../ui/dom';
import { runWithRetry, type LazyLoadToast } from '../lazySurfaceLoad';

export interface WorkflowActionDeps {
  workflowController: WorkflowController;
  startWorkflowRecording: () => void;
  dispatchWorkflowEvent: (event: WorkflowEvent) => void;
  ensureWorkflowConfigPanel: () => Promise<WorkflowConfigPanel>;
  showLassoToast: LazyLoadToast['show'];
  hasScan?: () => boolean;
}

export function contributeWorkflowActions(deps: WorkflowActionDeps): Action[] {
  if (!WORKFLOW_RECORDER_ENABLED) return [];
  const actions: Action[] = [];
  actions.push(
    {
      id: 'workflow.start',
      title: 'Start recording workflow',
      section: 'Workflow',
      keys: keyDisplayFor('workflow-recorder'),
      // v0.3.10, `.olvworkflow` files capture camera
      // moves and tool actions ONLY (no scan data, no measurements). To
      // replay one the recipient needs the same scan file already open
      // locally. Without that disclosure users will share a workflow,
      // the recipient opens it, nothing happens, and trust is lost the
      // way it was with the pre-v0.3.10 "Share" button. The hint below
      // sets that expectation at recording start, the stop-save title
      // makes the file format explicit, and the save toast confirms
      // both what was saved and what the recipient needs to use it.
      hint:
        'Records camera presets, Frame all, tools and themes only — to replay later you ' +
        '(or the recipient) need the same scan open.',
      keywords: ['record', 'macro', 'demo'],
      run: () => deps.startWorkflowRecording(),
    },
    {
      id: 'workflow.stop-save',
      title: 'Stop and save workflow (.olvworkflow)',
      section: 'Workflow',
      hint:
        'Saves a replay of camera presets, Frame all, tools and themes — replay needs ' +
        'the same scan loaded on the other end.',
      keywords: ['export', 'finish', 'save'],
      run: () => {
        if (deps.workflowController.countingDown) {
          deps.workflowController.cancelCountdown();
          deps.showLassoToast(COUNTDOWN_CANCELLED);
          return;
        }
        const workflow = deps.workflowController.stopRecording();
        // The same save the record shortcut uses: it reports saved or
        // cancelled once the picker or download has finished.
        if (workflow) void saveWorkflowWithToast(deps.workflowController, workflow, deps.showLassoToast);
        else deps.showLassoToast('Workflow · nothing recorded yet. Camera presets, Frame all, tools and themes are recorded.');
      },
    },
    {
      id: 'workflow.load-replay',
      title: 'Replay a workflow file…',
      section: 'Workflow',
      hint: 'Pick a .olvworkflow file and play it back.',
      keywords: ['load', 'import', 'open', 'macro'],
      run: () => {
        const input = el('input', { className: 'olv-hidden' });
        input.type = 'file';
        input.accept = '.olvworkflow,application/json';
        // A dismissed picker fires `cancel` and no `change`.
        input.addEventListener('cancel', () => input.remove());
        input.addEventListener('change', () => {
          const file = input.files?.[0];
          input.remove();
          if (!file) return;
          void (async () => {
            try {
              const workflow = await deps.workflowController.loadFromFile(file);
              if (deps.hasScan?.() === false && workflow.events.some((e) => e.type !== 'theme')) {
                deps.showLassoToast('Workflow · open the scan this workflow was recorded on, then replay it. Nothing was played.');
                return;
              }
              const busy = deps.workflowController.state;
              if (!deps.workflowController.replay(workflow, deps.dispatchWorkflowEvent)) {
                deps.showLassoToast(busy === 'playing'
                  ? 'Workflow · another replay is running, so this file did not play. Stop it from the badge, then try again.'
                  : busy === 'recording'
                    ? 'Workflow · still recording, so this file did not play. Stop the recording, then replay it.'
                    : 'Workflow · a recording is about to start, so this file did not play. Press Stop on the badge, then try again.');
                return;
              }
              deps.showLassoToast(
                `Workflow · playing ${workflow.events.length} event${workflow.events.length === 1 ? '' : 's'}.`,
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'unknown error';
              deps.showLassoToast(`Workflow · couldn't load file: ${msg}. Nothing was changed. Choose another workflow file and try again.`);
            }
          })();
        });
        document.body.append(input);
        input.click();
      },
    },
    {
      id: 'workflow.settings',
      title: 'Workflow recorder settings…',
      section: 'Workflow',
      hint: 'Format, save location, shortcut, replay speed, capture scope.',
      keywords: ['config', 'options', 'preferences', 'shortcut', 'speed'],
      run: () => {
        // A failed load reaches the shared lazy-load toast, whose Try again runs the whole open again.
        runWithRetry({ show: deps.showLassoToast }, () => deps.ensureWorkflowConfigPanel().then((p) => p.open()), 'workflow settings');
      },
    },
  );
  return actions;
}
