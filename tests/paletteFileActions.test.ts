/**
 * paletteFileActions.test.ts
 *
 * The command palette lists opening a scan, opening and saving a session and
 * the PDF report, under the registry names, and each runs the same path its
 * panel control does: the scan picker, the one file router, the session writer
 * and the report run with the default template. A dismissed session picker
 * opens nothing and leaves no input behind.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { FakeEl, installFakeDom } from './support/measurePanelDom';
import { contributeExportActions, type ExportActionDeps } from '../src/app/actions/exportActions';
import { ACTION_TITLES } from '../src/ui/actionDescriptors';

const body = new FakeEl('body');

beforeAll(() => {
  installFakeDom();
  (globalThis as unknown as { document: Record<string, unknown> }).document.body = body;
});

function actions() {
  const deps = {
    saveSnapshot: vi.fn(),
    copyShareLink: vi.fn(),
    exportSession: vi.fn(),
    handleFile: vi.fn(),
    openScan: vi.fn(),
    exportReport: vi.fn(),
    buildCurrentStoryInputs: vi.fn(),
    showLassoToast: vi.fn(),
  };
  const list = contributeExportActions(deps as unknown as ExportActionDeps);
  const find = (id: string) => {
    const a = list.find((x) => x.id === id);
    if (!a) throw new Error(`no action ${id}`);
    return a;
  };
  return { deps, list, find };
}

describe('palette file actions', () => {
  it('lists the four under their registry names', () => {
    const { find } = actions();
    for (const id of ['scan.open', 'session.open', 'session.export', 'report.pdf'] as const) {
      expect(find(id).title).toBe(ACTION_TITLES[id]);
    }
    expect(find('scan.open').section).toBe('Data');
    expect(find('session.open').section).toBe('Data');
    expect(find('session.export').section).toBe('Export');
    expect(find('report.pdf').section).toBe('Export');
  });

  it('Open scan opens the device picker the panels use', () => {
    const { deps, find } = actions();
    find('scan.open').run();
    expect(deps.openScan).toHaveBeenCalledTimes(1);
  });

  it('Save session writes the session file', () => {
    const { deps, find } = actions();
    find('session.export').run();
    expect(deps.exportSession).toHaveBeenCalledTimes(1);
  });

  it('Report PDF runs the report with the default template', () => {
    const { deps, find } = actions();
    find('report.pdf').run();
    expect(deps.exportReport).toHaveBeenCalledTimes(1);
  });

  it('Open session picks an .olvsession and hands it to the file router; a dismissed picker leaves nothing', () => {
    const { deps, find } = actions();
    body.children.length = 0;
    find('session.open').run();
    const input = body.children[0] as FakeEl & { accept: string; files?: File[] };
    expect(input).toBeDefined();
    expect(input.type).toBe('file');
    expect(input.accept).toContain('.olvsession');
    const picked = { name: 'site.olvsession' } as unknown as File;
    input.files = [picked];
    input.dispatchEvent({ type: 'change' });
    expect(deps.handleFile).toHaveBeenCalledWith(picked);
    expect(body.children).toHaveLength(0);

    find('session.open').run();
    const second = body.children[0] as FakeEl;
    second.dispatchEvent({ type: 'cancel' });
    expect(body.children).toHaveLength(0);
    expect(deps.handleFile).toHaveBeenCalledTimes(1);
  });
});
