/**
 * exportPanelLegacyClassWrap.test.ts
 *
 * The Export panel's LAS 1.2 path when the cloud carries classes above 31.
 * The write gate in `convertCloud` refuses such a file unless the request opts
 * in, because each wrapped class lands on another valid class and the file
 * reads back without an error. These tests drive the panel with the REAL
 * converter and pin what the user sees: a blocked export with the reason, the
 * two ways forward it names (LAS 1.4, or the opt-in checkbox), the same
 * sentence in the live preview before the click, and a written file once the
 * opt-in is ticked. Node environment via a recording DOM stub.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { LEGACY_CLASS_WRAP_OPT_IN } from '../src/convert/types';
import { legacyClassWrapRefusal, legacyClassWrapWarning } from '../src/convert/legacyClassGuard';
import {
  installFakeDom,
  classifiedCloud as cloud,
  pickFormat,
  checkRow,
  setCheckbox,
  panelFor,
  exportStatus as status,
  exportNote as note,
  settleTicks,
  type FakeEl,
} from './helpers/exportPanelHarness';

const hoisted = vi.hoisted(() => ({
  /** Filenames and bytes that reached the browser download helper. */
  downloads: [] as { name: string; bytes: Uint8Array }[],
}));

vi.mock('../src/io/download', () => ({
  downloadBytes: (name: string, bytes: Uint8Array) => { hoisted.downloads.push({ name, bytes }); },
  triggerDownload: () => { /* unused here */ },
}));

beforeAll(() => {
  installFakeDom();
});

beforeEach(() => {
  hoisted.downloads.length = 0;
});

/**
 * Let the preview's lazily loaded guard arrive and the panel render again. The
 * module is imported here first so the panel's own import resolves from cache.
 */
const settle = async (): Promise<void> => {
  await import('../src/convert/legacyClassGuard');
  await settleTicks();
};

/** Press Export and wait until the run has set its outcome in the status line. */
async function pressExport(root: FakeEl): Promise<void> {
  const before = status(root).textContent;
  root.findByClass('olv-export-btn')[0].fire('click');
  // The first run imports the real converter, which takes longer than a tick.
  await vi.waitFor(() => {
    expect(status(root).textContent).not.toBe(before);
    expect(root.findByClass('olv-export-btn')[0].textContent).toBe('Export');
  }, { timeout: 5000 });
}

describe('ExportPanel — LAS 1.2 with classes above 31', () => {
  it('blocks the export and gives the reason, naming LAS 1.4 and the opt-in', async () => {
    const root = await panelFor(cloud([2, 64, 64, 33]));
    pickFormat(root, 'LAS 1.2');
    await pressExport(root);

    expect(hoisted.downloads, 'a wrapped file was written').toEqual([]);
    const refusal = legacyClassWrapRefusal({ points: 3, codes: [33, 64] });
    expect(status(root).textContent).toBe(refusal);
    expect(status(root).className).toContain('is-error');
    expect(refusal).toContain('LAS 1.4');
    expect(refusal).toContain(LEGACY_CLASS_WRAP_OPT_IN);
    // The control the message names is on screen.
    expect(checkRow(root, LEGACY_CLASS_WRAP_OPT_IN)?.hidden).toBe(false);
  });

  it('previews the same refusal before the click', async () => {
    const root = await panelFor(cloud([2, 64, 64, 33]));
    pickFormat(root, 'LAS 1.2');
    await settle(); // the preview's class tables load lazily, then it re-renders
    expect(note(root).textContent).toBe(legacyClassWrapRefusal({ points: 3, codes: [33, 64] }));
    expect(note(root).className).toContain('is-error');
  });

  it('writes the file once the opt-in is ticked, and reports the wrap as a warning', async () => {
    const root = await panelFor(cloud([2, 64]));
    pickFormat(root, 'LAS 1.2');
    setCheckbox(root, LEGACY_CLASS_WRAP_OPT_IN, true);
    await settle();
    expect(note(root).className).toContain('is-warn');
    await pressExport(root);

    expect(hoisted.downloads.map((d) => d.name)).toEqual(['survey.las']);
    expect(status(root).textContent).toBe(legacyClassWrapWarning(1));
    expect(status(root).className).toContain('is-warn');
  });

  it('choosing LAS 1.4 writes the full classes with no opt-in', async () => {
    const root = await panelFor(cloud([2, 64]));
    pickFormat(root, 'LAS 1.2');
    pickFormat(root, 'LAS 1.4');
    await pressExport(root);
    expect(hoisted.downloads.length).toBe(1);
    expect(status(root).className).not.toContain('is-error');
  });

  it('refuses at full resolution when only the re-decoded file carries the codes', async () => {
    // The display subsample has no class above 31, so the preview is silent;
    // the write gate reads the file that is actually converted.
    const full = cloud([2, 6, 200]);
    const root = await panelFor(cloud([2, 6]), {
      hasFullSource: () => true,
      isReduced: () => true,
      getFullCloud: async () => full,
      getActiveScanId: () => 'scan-a',
    });
    setCheckbox(root, 'Convert at full resolution', true);
    pickFormat(root, 'LAS 1.2');
    await pressExport(root);

    expect(hoisted.downloads).toEqual([]);
    expect(status(root).textContent).toBe(legacyClassWrapRefusal({ points: 1, codes: [200] }));
  });
});

describe('ExportPanel — LAS 1.2 whose classes all fit', () => {
  it('exports as before and the preview says nothing about wrapping', async () => {
    const root = await panelFor(cloud([0, 2, 6, 31]));
    pickFormat(root, 'LAS 1.2');
    await settle();
    expect(note(root).textContent).not.toMatch(/wrap|above 31|5-bit|5 bits|clamp/i);
    await pressExport(root);
    expect(hoisted.downloads.length).toBe(1);
    expect(status(root).className).not.toContain('is-error');
  });
});

describe('ExportPanel — the opt-in row', () => {
  it('shows only while LAS 1.2 would write a classification', async () => {
    const root = await panelFor(cloud([2, 64]));
    const row = (): FakeEl | undefined => checkRow(root, LEGACY_CLASS_WRAP_OPT_IN);
    expect(row(), 'the opt-in row is missing').toBeDefined();
    expect(row()!.hidden, 'shown for the default LAS 1.4').toBe(true);
    pickFormat(root, 'LAS 1.2');
    expect(row()!.hidden).toBe(false);
    setCheckbox(root, 'Include classification', false);
    expect(row()!.hidden, 'shown with the classification omitted').toBe(true);
  });

  it('stays hidden for a cloud with no classification', async () => {
    const plain = new PointCloud({
      positions: new Float32Array([0, 0, 0]),
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'plain.las',
    });
    const root = await panelFor(plain);
    pickFormat(root, 'LAS 1.2');
    expect(checkRow(root, LEGACY_CLASS_WRAP_OPT_IN)!.hidden).toBe(true);
  });
});

describe('exportClassFacts', () => {
  it('hands the host the class buffer by reference with its provenance', async () => {
    const { exportClassFacts } = await import('../src/ui/ExportPanel');
    const c = cloud([2, 64]);
    const facts = exportClassFacts(c);
    expect(facts.classProvenance).toBe('source');
    expect(facts.classification).toBe(c.classification);
  });
});
