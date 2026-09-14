/**
 * The persistent "Add dataset" control is the only way to open a second dataset
 * once the empty state hides — and the only way at all on a phone, which has no
 * drag-and-drop. It lives in the Layers header, which is what it adds to. It
 * used to float over the canvas at bottom-left, one pixel from the tool dock,
 * which sits at a higher z-index and covered it: the control was revealed
 * exactly when a scan loaded, which is exactly when the dock appeared, so it
 * was unreachable for the whole of its visible life.
 *
 * These read the sources and the concatenated stylesheet (constructing either
 * surface needs build-time defines and a canvas), and pin the things that make
 * the control work: it is a real button in the Layers header, it opens through
 * the one approval-gated ingest path rather than a second route, and it carries
 * a visible focus ring.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import { readAppCss } from './support/appCss';

const read = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf8');
const STAGE = read('src/ui/Stage.ts');
const INSPECTOR = read('src/ui/Inspector.ts');
const CSS = readAppCss();

describe('the Add dataset control', () => {
  it('is a real button in the Layers header, beside the grouping control', () => {
    expect(INSPECTOR).toMatch(/const addDataset = el\('button', \{/);
    expect(INSPECTOR).toMatch(/text: '\+ Add dataset'/);
    // Both controls sit in the one header row, the primary action first.
    expect(INSPECTOR).toMatch(/_groupBar = el\('div', \{ className: 'olv-group-bar' \}, \[addDataset, newGroup\]\)/);
  });

  it('does not float over the canvas any more', () => {
    // The old chip and its absolute positioning are gone from both the source
    // and the stylesheet, so nothing can be occluded by the dock again.
    expect(STAGE).not.toMatch(/olv-add-dataset olv-hidden/);
    expect(CSS).not.toMatch(/\.olv-add-dataset\s*\{/);
  });

  it('opens through the one approval-gated ingest path', () => {
    // The button asks the Stage, which owns the single file input and its
    // approval step; it does not carry an ingest route of its own.
    expect(INSPECTOR).toMatch(/addDataset\.addEventListener\('click', \(\) => this\._cb\.onAddDataset\?\.\(\)\)/);
    expect(STAGE).toMatch(/promptAddDataset\(\): void \{\s*this\._addDataset\.click\(\);/);
    const openCalls = STAGE.match(/this\._approveFile\(file\)\.then\(\(ok\) => \{ if \(ok\) options\.onOpenFile\?\.\(file\); \}\)/g) ?? [];
    expect(openCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('has a visible focus ring in the stylesheet', () => {
    expect(CSS).toMatch(/\.olv-group-new:focus-visible\s*\{/);
    expect(CSS).toMatch(/\.olv-add-dataset-row\s*\{/);
  });
});
