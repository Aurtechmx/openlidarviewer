import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { EXPORT_BUTTON_TOOLTIP } from '../src/ui/ExportPanel';

describe('Export button tooltip', () => {
  it('names the clip as the limit and does not claim the class filter limits the write', () => {
    expect(EXPORT_BUTTON_TOOLTIP).toContain('active clip limits');
    expect(EXPORT_BUTTON_TOOLTIP).toContain('class filter does not');
    expect(EXPORT_BUTTON_TOOLTIP).not.toMatch(/clip or class filter/);
  });

  it('is the title the panel uses', () => {
    const src = readFileSync('src/ui/ExportPanel.ts', 'utf8');
    expect(src).toContain('title: EXPORT_BUTTON_TOOLTIP');
  });
});
