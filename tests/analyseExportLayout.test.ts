import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * tests/analyseExportLayout.test.ts
 *
 * Regression guard for the Analyse-panel contour-export row layout.
 *
 * The `.olv-analyse-export` flex row holds two children that use
 * `flex-basis: 100%` and are meant to drop onto their OWN full-width lines:
 *   - `.olv-analyse-dl.is-primary` — the primary "DEM (ZIP)" action.
 *   - `.olv-analyse-dem-note`      — the export honesty caveat.
 *
 * If the row is not `flex-wrap: wrap`, those 100%-basis children cannot wrap:
 * they collapse into slivers on the single nowrap line, the note's text wraps
 * vertically into a tall column, and (because a flex row defaults to
 * `align-items: stretch`) EVERY export button inflates to that height. The
 * symptom is GEOJSON / SVG / DXF / MAP PDF / DEM rendering as full-height
 * columns. This is purely visual, so no unit test other than a stylesheet
 * contract can catch a future removal of `flex-wrap`.
 */
describe('Analyse export row — must wrap so 100%-basis children get their own line', () => {
  const css = readFileSync(
    fileURLToPath(new URL('../src/style.css', import.meta.url)),
    'utf8',
  );

  function ruleBody(selector: string): string | null {
    // Escape regex metacharacters in the selector, then grab the first
    // `{ ... }` body for it.
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = css.match(new RegExp(`${esc}\\s*\\{([^}]*)\\}`));
    return m ? m[1] : null;
  }

  it('.olv-analyse-export is a flex row that wraps', () => {
    const body = ruleBody('.olv-analyse-export');
    expect(body, '.olv-analyse-export rule not found').not.toBeNull();
    expect(body!).toMatch(/display\s*:\s*flex/);
    expect(body!, 'flex-wrap: wrap is required (see test header)').toMatch(
      /flex-wrap\s*:\s*wrap/,
    );
  });

  it('the primary DEM button still declares flex-basis: 100% (its own line)', () => {
    const body = ruleBody('.olv-analyse-dl.is-primary');
    expect(body, '.olv-analyse-dl.is-primary rule not found').not.toBeNull();
    expect(body!).toMatch(/flex-basis\s*:\s*100%/);
  });

  it('the DEM note still declares flex-basis: 100% (its own line)', () => {
    const body = ruleBody('.olv-analyse-dem-note');
    expect(body, '.olv-analyse-dem-note rule not found').not.toBeNull();
    expect(body!).toMatch(/flex-basis\s*:\s*100%/);
  });
});
