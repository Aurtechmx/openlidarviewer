/**
 * workflowPress.test.ts
 *
 * Every way to stop or start the recorder says what happened: the badge saves
 * as the palette does, a countdown can be cancelled, a busy recorder refuses out
 * loud, and the settings refuse a key that could never fire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowController, createWorkflowRecording } from '../src/ui/WorkflowController';
import { contributeWorkflowActions, type WorkflowActionDeps } from '../src/app/actions/workflowActions';
import { workflowChordConflict } from '../src/ui/keyBindings';
import { DEFAULT_WORKFLOW_CONFIG, type WorkflowRecorderConfig } from '../src/render/workflow/workflowConfig';
import type { Workflow } from '../src/render/workflow/workflowRecorder';

interface Node { listeners: Record<string, () => void>; [k: string]: unknown }
const nodes: Node[] = [];
function fakeElement(): unknown {
  const node: Node = {
    className: '', textContent: '', title: '', tagName: 'DIV', listeners: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    setAttribute: () => {}, append: () => {}, blur: () => {}, remove: () => {},
    addEventListener(t: string, f: () => void) { node.listeners[t] = f; },
  };
  nodes.push(node);
  return node;
}
const WITH_COUNTDOWN: WorkflowRecorderConfig = { ...DEFAULT_WORKFLOW_CONFIG, countdownSeconds: 3 };
const NO_COUNTDOWN: WorkflowRecorderConfig = { ...DEFAULT_WORKFLOW_CONFIG, countdownSeconds: 0 };
const stopButton = (): Node => nodes.find((n) => n.className === 'olv-workflow-badge-stop')!;

beforeEach(() => {
  nodes.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal('document', { createElement: fakeElement, body: { append: () => {} } });
  vi.stubGlobal('window', globalThis);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('badge Stop', () => {
  it('during a recording runs the host press, not a silent stop', () => {
    const onStop = vi.fn();
    const c = new WorkflowController(undefined, onStop);
    c.setConfig(NO_COUNTDOWN);
    c.startRecording();
    stopButton().listeners.click();
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(c.state).toBe('recording');
  });
  it('through the host saves what was recorded, the way the palette does', async () => {
    const toast = vi.fn();
    let rec: ReturnType<typeof createWorkflowRecording> | null = null;
    const c = new WorkflowController(undefined, () => rec?.toggle());
    const save = vi.spyOn(c, 'save').mockResolvedValue('x.olvworkflow');
    c.setConfig(NO_COUNTDOWN);
    rec = createWorkflowRecording(c, toast);
    c.startRecording();
    c.capture({ type: 'frame-all' });
    stopButton().listeners.click();
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(toast.mock.calls.map((x) => x[0]).join()).toContain('Workflow saved');
  });
  it('with nothing recorded says so', () => {
    const toast = vi.fn();
    let rec: ReturnType<typeof createWorkflowRecording> | null = null;
    const c = new WorkflowController(undefined, () => rec?.toggle());
    c.setConfig(NO_COUNTDOWN);
    rec = createWorkflowRecording(c, toast);
    c.startRecording();
    stopButton().listeners.click();
    expect(toast).toHaveBeenCalledWith('Workflow · nothing recorded yet.');
  });
});

describe('countdown', () => {
  it('the shortcut cancels it and recording never starts', () => {
    const toast = vi.fn();
    const c = new WorkflowController();
    c.setConfig(WITH_COUNTDOWN);
    const rec = createWorkflowRecording(c, toast);
    rec.toggle();
    expect(c.countingDown).toBe(true);
    rec.toggle();
    expect(toast).toHaveBeenLastCalledWith('Workflow · recording cancelled before it started.');
    vi.advanceTimersByTime(4000);
    expect(c.state).toBe('idle');
  });
  it('Stop and save cancels it and recording never starts', () => {
    const toast = vi.fn();
    const c = new WorkflowController();
    c.setConfig(WITH_COUNTDOWN);
    const actions = contributeWorkflowActions({ workflowController: c, startWorkflowRecording: vi.fn(), dispatchWorkflowEvent: vi.fn(), ensureWorkflowConfigPanel: vi.fn(), showLassoToast: toast, hasScan: () => true } as WorkflowActionDeps);
    c.requestStartRecording();
    actions.find((a) => a.id === 'workflow.stop-save')!.run();
    expect(toast).toHaveBeenCalledWith('Workflow · recording cancelled before it started.');
    vi.advanceTimersByTime(4000);
    expect(c.state).toBe('idle');
  });
});

describe('Start recording while busy', () => {
  it('already recording: says how to stop, never a false countdown', () => {
    const toast = vi.fn();
    const c = new WorkflowController();
    c.setConfig(WITH_COUNTDOWN);
    c.startRecording();
    createWorkflowRecording(c, toast).start();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toBe('Workflow · already recording. Press Stop on the badge to save it.');
  });
  it('a countdown is running', () => {
    const toast = vi.fn();
    const c = new WorkflowController();
    c.setConfig(WITH_COUNTDOWN);
    c.requestStartRecording();
    createWorkflowRecording(c, toast).start();
    expect(toast).toHaveBeenCalledWith('Workflow · countdown already running. Press Stop on the badge to cancel it.');
  });
  it('a replay is running', () => {
    const toast = vi.fn();
    const c = new WorkflowController();
    c.replay({ events: [{ t: 0, type: 'frame-all' }] } as unknown as Workflow, vi.fn());
    createWorkflowRecording(c, toast).start();
    expect(toast).toHaveBeenCalledWith('Workflow · a replay is running. Press Stop on the badge, then start recording.');
  });
});

describe('replay', () => {
  const file = { events: [{ t: 0, type: 'camera-preset', name: 'top' }] } as unknown as Workflow;
  it('reports whether it started', () => {
    const c = new WorkflowController();
    c.startRecording();
    expect(c.replay(file, vi.fn())).toBe(false);
    c.stopRecording();
    expect(c.replay(file, vi.fn())).toBe(true);
  });

  async function pick(deps: Partial<WorkflowActionDeps>) {
    let change: () => void = () => {};
    const input = { className: '', type: '', accept: '', files: [{}], remove: () => {}, click: () => change(), addEventListener: (t: string, f: () => void) => { if (t === 'change') change = f; }, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, append() {} };
    vi.stubGlobal('document', { createElement: (tag: string) => (tag === 'input' ? input : fakeElement()), body: { append: () => {} } });
    const toast = vi.fn();
    const actions = contributeWorkflowActions({ startWorkflowRecording: vi.fn(), dispatchWorkflowEvent: vi.fn(), ensureWorkflowConfigPanel: vi.fn(), showLassoToast: toast, hasScan: () => true, ...deps } as WorkflowActionDeps);
    actions.find((a) => a.id === 'workflow.load-replay')!.run();
    await vi.advanceTimersByTimeAsync(0);
    return toast;
  }
  const controller = (state: string, started: boolean, wf = file) => ({ state, countingDown: false, loadFromFile: vi.fn(async () => wf), replay: vi.fn(() => started) }) as never as WorkflowController;

  it('while recording refuses and never says playing', async () => {
    const toast = await pick({ workflowController: controller('recording', false) });
    expect(toast).toHaveBeenCalledWith('Workflow · still recording, so this file did not play. Stop the recording, then replay it.');
    expect(toast.mock.calls.join()).not.toContain('playing 1');
  });
  it('while playing refuses with its own reason', async () => {
    const toast = await pick({ workflowController: controller('playing', false) });
    expect(toast).toHaveBeenCalledWith('Workflow · another replay is running, so this file did not play. Stop it from the badge, then try again.');
  });
  it('with no scan refuses a file that needs one', async () => {
    const c = controller('idle', true);
    const toast = await pick({ workflowController: c, hasScan: () => false });
    expect(c.replay).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('Workflow · open the scan this workflow was recorded on, then replay it. Nothing was played.');
  });
  it('with no scan still plays a theme-only file', async () => {
    const c = controller('idle', true, { events: [{ t: 0, type: 'theme', name: 'dark' }] } as unknown as Workflow);
    const toast = await pick({ workflowController: c, hasScan: () => false });
    expect(c.replay).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('Workflow · playing 1 event.');
  });
});

describe('shortcut conflicts', () => {
  const ev = (key: string, m: { shift?: boolean; alt?: boolean } = {}) => ({ key, code: `Key${key.toUpperCase()}`, ctrlKey: true, metaKey: false, shiftKey: !!m.shift, altKey: !!m.alt });
  it.each([[ev('k')], [ev('K', { shift: true })], [ev('k', { alt: true })], [ev('z')], [ev('y')]])('refuses a key another command owns', (e) => {
    expect(workflowChordConflict(e)).not.toBeNull();
  });
  it('names the palette for Ctrl+K', () => {
    expect(workflowChordConflict(ev('k'))).toContain('command palette');
  });
  it.each([[ev('J', { shift: true })], [ev('U', { shift: true })]])('accepts a free key and the default', (e) => {
    expect(workflowChordConflict(e)).toBeNull();
  });
});
