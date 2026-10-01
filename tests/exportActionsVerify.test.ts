/**
 * exportActionsVerify.test.ts
 *
 * "Verify integrity report…" opens a hidden file input and loads the
 * verifier chunk once the user picks a file. A dismissed picker must not leave
 * the input in the document, and a chunk that fails to load must reach the
 * toast with a Try again that verifies the file the user picked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const loadReportVerifier = vi.fn();
vi.mock('../src/lazyChunks', () => ({ loadReportVerifier: () => loadReportVerifier() }));

import { contributeExportActions } from '../src/app/actions/exportActions';

/** The slice of <input type="file"> and <body> the action touches. */
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

function verifyAction() {
  const toasts: Array<{ message: string; action?: { readonly label: string; readonly onClick: () => void } }> = [];
  const actions = contributeExportActions({
    saveSnapshot: vi.fn(),
    copyShareLink: vi.fn(),
    buildCurrentStoryInputs: () => ({}) as never,
    showLassoToast: (message, action) => { toasts.push({ message, action }); },
  });
  const run = (): void => actions.find((a) => a.id === 'report.verify')!.run();
  return { run, toasts };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  loadReportVerifier.mockReset();
});

describe('report.verify', () => {
  it('removes the hidden input when the picker is dismissed', () => {
    const body = stubDocument();
    verifyAction().run();
    expect(body).toHaveLength(1);
    body[0].fire('cancel'); // a dismissed picker fires cancel and no change
    expect(body).toHaveLength(0);
  });

  it('reports a failed verifier load with a Try again that verifies the same file', async () => {
    const verifyAndShow = vi.fn(async () => {});
    loadReportVerifier
      .mockImplementationOnce(() => Promise.reject(new Error('chunk 404')))
      .mockImplementation(async () => ({ verifyAndShow }));
    const body = stubDocument();
    const { run, toasts } = verifyAction();
    run();
    const file = new File(['{}'], 'report.json', { type: 'application/json' });
    body[0].files = [file];
    body[0].fire('change');
    expect(body).toHaveLength(0);
    await settle();
    expect(toasts.map((t) => t.message)).toEqual(['chunk 404']);
    expect(toasts[0].action?.label).toBe('Try again');
    toasts[0].action!.onClick();
    await settle();
    expect(loadReportVerifier).toHaveBeenCalledTimes(2);
    expect(verifyAndShow).toHaveBeenCalledWith(file);
  });
});
