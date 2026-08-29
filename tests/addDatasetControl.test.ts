/**
 * The persistent "Add dataset" control is the only way to open a second dataset
 * once the empty state hides — and the only way at all on a phone, which has no
 * drag-and-drop. These read the Stage source and the concatenated stylesheet
 * (constructing the Stage needs build-time defines and a canvas), and pin the
 * three things that make the control work: it exists as a real button, it is
 * revealed with the first scan and hidden when the empty state returns, and it
 * reuses the one approval-gated open callback rather than a second ingest path.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import { readAppCss } from './support/appCss';

const STAGE = readFileSync(resolve(__dirname, '../src/ui/Stage.ts'), 'utf8');
const CSS = readAppCss();

describe('the Add dataset control', () => {
  it('is a real button, not a decorated span', () => {
    expect(STAGE).toMatch(/this\._addDataset = el\('button', \{/);
    expect(STAGE).toMatch(/className: 'olv-add-dataset olv-hidden'/);
  });

  it('reuses the single approval-gated open callback', () => {
    // Same path as the empty-state picker: approve, then onOpenFile. No second
    // ingest route.
    const openCalls = STAGE.match(/this\._approveFile\(file\)\.then\(\(ok\) => \{ if \(ok\) options\.onOpenFile\?\.\(file\); \}\)/g) ?? [];
    // One in the empty-state picker, one in the Add dataset control.
    expect(openCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('is revealed with the first scan and hidden when the empty state returns', () => {
    expect(STAGE).toMatch(/hideEmptyState\(\): void \{[\s\S]*?this\._addDataset\.classList\.remove\('olv-hidden'\)/);
    expect(STAGE).toMatch(/showEmptyState\(\): void \{[\s\S]*?this\._addDataset\.classList\.add\('olv-hidden'\)/);
  });

  it('has a focus-visible outline in the stylesheet', () => {
    expect(CSS).toMatch(/\.olv-add-dataset\s*\{/);
    expect(CSS).toMatch(/\.olv-add-dataset:focus-visible\s*\{/);
  });
});
