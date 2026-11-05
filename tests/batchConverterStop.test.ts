/**
 * Stopping a batch: Cancel keeps what finished and says what did not; closing
 * the dialog during a run releases the output, as close() states.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeEl as BaseFakeEl } from './helpers/exportPanelPillDomFake';

const rec = vi.hoisted(() => ({ run: null as null | ((signal: AbortSignal) => Promise<unknown[]>) }));

vi.mock('../src/convert/convertRunner', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  runBatch: (_f: unknown, _o: unknown, _d: unknown, _p: unknown, signal: AbortSignal) => rec.run!(signal),
}));

class FakeEl extends BaseFakeEl {
  override addEventListener(): void {}
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
    activeElement: null,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = class {};
  g.HTMLAnchorElement = class {};
});

interface Converter {
  element: FakeEl;
  _files: unknown[];
  _results: FakeEl;
  _produced: unknown[];
  _abort?: AbortController;
  _convert(): Promise<void>;
  open(): void;
  close(): void;
}

const done = {
  source: 'a.las',
  file: { filename: 'a.laz', bytes: new Uint8Array(1) },
  report: { source: 'a.las', ok: true, pointCount: 12, crsNote: '—', log: [] },
};

async function converter(): Promise<Converter> {
  const { BatchConverter } = await import('../src/ui/BatchConverter');
  const bc = new BatchConverter(new FakeEl('div') as unknown as HTMLElement) as unknown as Converter;
  for (const name of ['a.las', 'b.las', 'c.las']) bc._files.push({ name, sizeBytes: 8, bytes: async () => new ArrayBuffer(8) });
  (bc as unknown as { _validate(): { ok: boolean } })._validate = () => ({ ok: true });
  return bc;
}

const text = (e: FakeEl): string => e.findByClass('olv-bc-results-summary').map((s) => s.textContent).join('|') + e.findByClass('olv-bc-stopped').map((s) => s.textContent).join('|');

describe('stopping a batch', () => {
  it('Cancel says how many files were not converted and keeps what finished', async () => {
    const bc = await converter();
    rec.run = async () => { bc._abort!.abort(); return [done]; };
    await bc._convert();
    expect(text(bc._results)).toContain('Stopped: 2 of 3 files not converted');
    expect(text(bc._results)).toContain('1 converted');
    expect(bc._produced).toHaveLength(1);
  });

  it('Cancel on the first file still says so', async () => {
    const bc = await converter();
    rec.run = async () => { bc._abort!.abort(); return []; };
    await bc._convert();
    expect(text(bc._results)).toContain('Stopped: 3 of 3 files not converted');
  });

  it('a complete run says nothing about stopping', async () => {
    const bc = await converter();
    rec.run = async () => [done, done, done];
    await bc._convert();
    expect(text(bc._results)).not.toContain('Stopped');
  });

  it('closing during a run holds no output and shows no results', async () => {
    const bc = await converter();
    bc.open();
    rec.run = async () => { bc.close(); return [done]; };
    await bc._convert();
    expect(bc._produced).toHaveLength(0);
    expect(bc._results.findByClass('olv-bc-results-summary')).toHaveLength(0);
  });
});
