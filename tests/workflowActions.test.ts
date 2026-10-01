/**
 * workflowActions.test.ts
 *
 * The workflow recorder's palette actions, past the happy path that
 * actionContributors.test.ts covers: "Stop and save" reports what the save
 * did once it has done it, a failed settings load reaches the toast with a
 * retry, and the hidden replay input leaves the document whether the picker
 * returns a file or is dismissed.
 */
import { describe, it, expect, expectTypeOf, vi, afterEach } from 'vitest';
import { contributeWorkflowActions, type WorkflowActionDeps } from '../src/app/actions/workflowActions';
import type { Workflow } from '../src/render/workflow/workflowRecorder';
import type { LazyLoadToast } from '../src/app/lazySurfaceLoad';

const SAVED = 'Workflow saved. Replay needs the same scan open on the other end.';
const CANCELLED = 'Workflow · save cancelled.';

function actionsWith(overrides: Partial<WorkflowActionDeps>) {
  const toasts: Array<{ message: string; action?: { label: string; onClick: () => void } }> = [];
  const deps: WorkflowActionDeps = {
    workflowController: {} as never,
    startWorkflowRecording: vi.fn(),
    dispatchWorkflowEvent: vi.fn(),
    ensureWorkflowConfigPanel: vi.fn(),
    showLassoToast: (message, action) => { toasts.push({ message, action }); },
    ...overrides,
  };
  const actions = contributeWorkflowActions(deps);
  const run = (id: string): void => actions.find((a) => a.id === id)!.run();
  return { run, toasts, messages: () => toasts.map((t) => t.message) };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('workflow.stop-save', () => {
  function recorderSaving(result: Promise<string | null>) {
    const workflow = { events: [] } as unknown as Workflow;
    const save = vi.fn(() => result);
    return { controller: { stopRecording: () => workflow, save } as never, save, workflow };
  }

  it('says nothing until the save settles, then confirms it', async () => {
    let finish: (name: string | null) => void = () => {};
    const { controller, save, workflow } = recorderSaving(new Promise((resolve) => { finish = resolve; }));
    const { run, messages } = actionsWith({ workflowController: controller });
    run('workflow.stop-save');
    expect(save).toHaveBeenCalledWith(workflow);
    expect(messages()).toEqual([]);
    finish('session.olvworkflow');
    await settle();
    expect(messages()).toEqual([SAVED]);
  });

  it('reports a dismissed save picker as cancelled, not saved', async () => {
    const { controller } = recorderSaving(Promise.resolve(null));
    const { run, messages } = actionsWith({ workflowController: controller });
    run('workflow.stop-save');
    await settle();
    expect(messages()).toEqual([CANCELLED]);
  });

  it('reports a save that throws, with the reason and a Try again that saves the same recording', async () => {
    const workflow = { events: [] } as unknown as Workflow;
    const save = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error('download blocked')))
      .mockImplementation(() => Promise.resolve('session.olvworkflow'));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { run, toasts, messages } = actionsWith({ workflowController: { stopRecording: () => workflow, save } as never });
      run('workflow.stop-save');
      await settle();
      expect(messages()).toEqual(["Workflow · couldn't save: download blocked"]);
      expect(toasts[0].action?.label).toBe('Try again');
      toasts[0].action!.onClick();
      await settle();
      expect(save).toHaveBeenCalledTimes(2);
      expect(save).toHaveBeenLastCalledWith(workflow);
      expect(messages().at(-1)).toBe(SAVED);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('still says nothing was recorded when the recorder was idle', () => {
    const { run, messages } = actionsWith({ workflowController: { stopRecording: () => null } as never });
    run('workflow.stop-save');
    expect(messages()).toEqual(['Workflow · nothing recorded yet.']);
  });
});

describe('the toast dependency', () => {
  it('takes the action argument the lazy-load toast passes, so Try again reaches the user', () => {
    expectTypeOf<WorkflowActionDeps['showLassoToast']>().toEqualTypeOf<LazyLoadToast['show']>();
  });
});

describe('workflow.settings', () => {
  it('reports a failed settings load through the toast with a Try again that loads again', async () => {
    const open = vi.fn();
    const ensureWorkflowConfigPanel = vi.fn()
      .mockReturnValueOnce(Promise.reject(new Error('chunk 404')))
      .mockReturnValueOnce(Promise.resolve({ open }));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { run, toasts } = actionsWith({ ensureWorkflowConfigPanel });
      run('workflow.settings');
      await settle();
      expect(toasts.map((t) => t.message)).toEqual(['chunk 404']);
      expect(toasts[0].action?.label).toBe('Try again');
      toasts[0].action!.onClick();
      await settle();
      expect(ensureWorkflowConfigPanel).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

describe('workflow.load-replay', () => {
  /** The slice of an <input type="file"> and <body> the replay action touches. */
  function stubDocument() {
    const body: FakeInput[] = [];
    class FakeInput {
      className = '';
      type = '';
      accept = '';
      files: File[] | null = null;
      private readonly handlers = new Map<string, Array<() => void>>();
      addEventListener(type: string, fn: () => void): void {
        this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
      }
      fire(type: string): void { for (const fn of this.handlers.get(type) ?? []) fn(); }
      remove(): void {
        const i = body.indexOf(this);
        if (i >= 0) body.splice(i, 1);
      }
      click(): void {}
    }
    vi.stubGlobal('document', {
      createElement: () => new FakeInput(),
      body: { append: (node: FakeInput) => { body.push(node); } },
    });
    return body;
  }

  afterEach(() => { vi.unstubAllGlobals(); });

  it('removes the hidden input when the picker is dismissed', () => {
    const body = stubDocument();
    const { run } = actionsWith({});
    run('workflow.load-replay');
    expect(body).toHaveLength(1);
    body[0].fire('cancel'); // a dismissed picker fires cancel and no change
    expect(body).toHaveLength(0);
  });

  it('removes the hidden input when the picker returns with no file', () => {
    const body = stubDocument();
    const { run } = actionsWith({});
    run('workflow.load-replay');
    body[0].fire('change');
    expect(body).toHaveLength(0);
  });
});
