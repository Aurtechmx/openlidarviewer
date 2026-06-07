import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * tests/flexAxisReuse.test.ts
 *
 * Guards against a specific footgun: a button class whose `flex: 1` is designed
 * for a horizontal flex ROW being reused on an element that lives in a
 * COLUMN-flex container, where `flex: 1` instead makes it grow on the VERTICAL
 * axis (ballooning to fill any free height).
 *
 * `.olv-export-btn` declares `flex: 1` for the horizontal `.olv-export` row.
 * The Export panel's Convert CTA (`.olv-bc-convert.olv-export-btn`) is a direct
 * child of the column-flex `.olv-export-body`, so it MUST neutralise that grow
 * (mirroring the existing `.olv-report-row .olv-export-btn { flex: 0 0 auto }`).
 */
describe('flex-axis reuse — column-context buttons must not inherit row grow', () => {
  const css = readFileSync(
    fileURLToPath(new URL('../src/style.css', import.meta.url)),
    'utf8',
  );

  function ruleBody(selector: string): string | null {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = css.match(new RegExp(`${esc}\\s*\\{([^}]*)\\}`));
    return m ? m[1] : null;
  }

  it('.olv-bc-convert pins flex to content height (flex: 0 0 auto)', () => {
    const body = ruleBody('.olv-bc-convert');
    expect(body, '.olv-bc-convert rule not found').not.toBeNull();
    expect(body!, 'must reset the row-oriented flex:1 it inherits from .olv-export-btn').toMatch(
      /flex\s*:\s*0\s+0\s+auto/,
    );
  });
});
