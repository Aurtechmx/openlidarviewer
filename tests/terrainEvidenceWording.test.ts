/** UI wording on terrain surfaces stays within what the evidence supports. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { HELP_TOPICS } from '../src/app/helpCatalog';

const src = (p: string): string => readFileSync(join(__dirname, '..', p), 'utf8');

describe('terrain evidence wording', () => {
  it('help text calls the hold-out an internal check, not validation', () => {
    const text = HELP_TOPICS.map((t) => JSON.stringify(t)).join(' ');
    expect(text).not.toMatch(/validates the surface/i);
    expect(text).toMatch(/internal check/i);
  });
  it('the scan fitness verdict names hold-out, not accuracy', () => {
    const s = src('src/terrain/quality/scanFitness.ts');
    expect(s).not.toContain('density and accuracy all pass');
    expect(s).toContain('density and hold-out residuals all pass');
  });
  it('Contour Studio launch reasons do not call area and scale validated', () => {
    expect(src('src/terrain/contourStudio/contourStudioLaunchState.ts')).not.toMatch(/validated area/i);
  });
});
