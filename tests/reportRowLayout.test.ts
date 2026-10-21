/**
 * The report row holds a template picker beside the Report PDF button. The
 * picker takes the free space and the button sizes to its label; the generic
 * `.olv-export-btn` is `width: 100%`, which made the button as wide as the
 * whole row, squeezed the picker to 13px and ran it off the panel.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = (name: string): string => readFileSync(fileURLToPath(new URL(`../src/styles/${name}`, import.meta.url)), 'utf8');

describe('report row layout', () => {
  it('sizes the button to its content and drops the stand-alone top margin', () => {
    const rule = /\.olv-report-row \.olv-export-btn \{([^}]*)\}/.exec(css('56-inspector-panels.css'))?.[1] ?? '';
    expect(rule).toMatch(/width:\s*auto/);
    expect(rule).toMatch(/flex:\s*0 0 auto/);
    expect(rule).toMatch(/margin-top:\s*0/);
  });

  it('keeps the generic export button full width for a button on its own row', () => {
    expect(css('90-converter-export.css')).toMatch(/\.olv-export-btn \{[^}]*width:\s*100%/);
  });

  it('gives the picker the elastic share', () => {
    const rule = /\.olv-report-select \{([^}]*)\}/.exec(css('56-inspector-panels.css'))?.[1] ?? '';
    expect(rule).toMatch(/flex:\s*1/);
    expect(rule).toMatch(/min-width:\s*0/);
  });
});
