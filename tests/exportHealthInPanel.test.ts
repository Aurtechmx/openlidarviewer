/**
 * exportHealthInPanel.test.ts
 *
 * The export-health model already existed, built by `buildExportHealth` and
 * rendered by `renderExportHealthPanel`, but the only route to it was a
 * command-palette modal: the readiness that decides whether an export is
 * defensible was not visible where the export happens. The panel now renders
 * that same model at the top of its body.
 *
 * The property under test is that the panel RENDERS the canonical model and
 * never re-derives readiness from its own fields, so the block and the palette
 * check cannot disagree.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PANEL = readFileSync(resolve(__dirname, '../src/ui/ExportPanel.ts'), 'utf8');
const MAIN = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8');

describe('export health is shown where the export happens', () => {
  it('renders the block first, above the point-cloud controls', () => {
    const body = PANEL.slice(PANEL.indexOf("const body = el('div', { className: 'olv-export-body' });"));
    const health = body.indexOf('this._health');
    const firstLabel = body.indexOf("this._label('Point cloud')");
    expect(health).toBeGreaterThan(-1);
    expect(health).toBeLessThan(firstLabel);
  });

  it('renders the canonical model rather than re-deriving readiness', () => {
    // The panel calls the shared renderer on whatever the host's callback
    // returns. It must not compute a verdict of its own.
    expect(PANEL).toMatch(/renderExportHealthPanel\(health\)/);
    expect(PANEL).toMatch(/const health = this\._cb\.exportHealth\?\.\(\) \?\? null;/);
    expect(PANEL).not.toMatch(/verdict\s*=\s*['"](ready|caution|blocked)['"]/);
  });

  it('the host feeds it the canonical builder, not a UI heuristic', () => {
    expect(MAIN).toMatch(/exportHealth: \(\) => \(hasScan\(\) \? buildExportHealth\(buildCurrentStoryInputs\(\)\) : null\)/);
  });

  it('re-renders with the rest of the panel, so it cannot go stale', () => {
    const refresh = PANEL.slice(PANEL.indexOf('refresh(): void {'));
    expect(refresh.slice(0, 260)).toMatch(/this\._renderHealth\(\);/);
  });

  it('a host that wires no callback gets the panel it had before', () => {
    // Optional callback, empty block: nothing is asserted about readiness when
    // the host supplies no model.
    expect(PANEL).toMatch(/exportHealth\?: \(\) => ExportHealth \| null;/);
    expect(PANEL).toMatch(/if \(!health\) return;/);
  });
});
