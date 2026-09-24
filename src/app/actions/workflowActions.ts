/**
 * workflowActions.ts
 *
 * The workflow recorder: start, stop and save, replay a file, settings.
 * Absent from the registry when the feature flag is off, not merely inert.
 */
import type { Action } from '../../ui/actionRegistry';
import { WORKFLOW_RECORDER_ENABLED, type WorkflowController } from '../../ui/WorkflowController';
import type { WorkflowConfigPanel } from '../../ui/WorkflowConfigPanel';
import type { WorkflowEvent } from '../../render/workflow/workflowRecorder';
import { keyDisplayFor } from '../../ui/keyBindings';
import { el } from '../../ui/dom';

export interface WorkflowActionDeps {
  workflowController: WorkflowController;
  startWorkflowRecording: () => void;
  dispatchWorkflowEvent: (event: WorkflowEvent) => void;
  ensureWorkflowConfigPanel: () => Promise<WorkflowConfigPanel>;
  showLassoToast: (message: string) => void;
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
        'Records camera moves and tool actions only — to replay later you ' +
        '(or the recipient) need the same scan open.',
      keywords: ['record', 'macro', 'demo'],
      run: () => deps.startWorkflowRecording(),
    },
    {
      id: 'workflow.stop-save',
      title: 'Stop and save workflow (.olvworkflow)',
      section: 'Workflow',
      hint:
        'Saves a replay of camera moves and tool actions — replay needs ' +
        'the same scan loaded on the other end.',
      keywords: ['export', 'finish', 'save'],
      run: () => {
        const workflow = deps.workflowController.stopRecording();
        if (workflow) {
          void deps.workflowController.save(workflow);
          deps.showLassoToast(
            'Workflow saved. Replay needs the same scan open on the other end.',
          );
        } else {
          deps.showLassoToast('Workflow · nothing recorded yet.');
        }
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
        input.addEventListener('change', () => {
          const file = input.files?.[0];
          input.remove();
          if (!file) return;
          void (async () => {
            try {
              const workflow = await deps.workflowController.loadFromFile(file);
              deps.workflowController.replay(workflow, deps.dispatchWorkflowEvent);
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
      run: () => void deps.ensureWorkflowConfigPanel().then((p) => p.open()),
    },
  );
  return actions;
}
