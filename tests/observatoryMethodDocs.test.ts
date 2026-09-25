/**
 * observatoryMethodDocs.test.ts — OB-INT-04: every registered `observation`
 * method id has a section in docs/observatory/methods.md.
 *
 * The seven `olv.observation.*` ids are registered in `methodRegistry.ts`
 * ahead of most of their implementations (docs/observatory/SPEC.md §4
 * OB-INT-04), so the one thing this test enforces is that early registration
 * never outruns the documentation that says what "registered" means here:
 * every id gets a heading, and every section names the phase that will (or,
 * for `olv.observation.states`, already did in part) implement it.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { METHOD_REGISTRY } from '../src/science/methodRegistry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = readFileSync(resolve(ROOT, 'docs/observatory/methods.md'), 'utf8');

const observationIds = Object.values(METHOD_REGISTRY)
  .filter((entry) => entry.category === 'observation')
  .map((entry) => entry.id)
  .sort();

describe('OB-INT-04: docs/observatory/methods.md sections', () => {
  it('finds at least the seven ids the Observatory decision rules named', () => {
    // A registry that lost every 'observation' entry would make every
    // assertion below vacuously pass over an empty list.
    expect(observationIds.length).toBeGreaterThanOrEqual(7);
  });

  it.each(observationIds)('%s has a section heading', (id) => {
    expect(DOC, `no "## \`${id}\`" heading in methods.md`).toMatch(
      new RegExp(`^## \`${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`\\s*$`, 'm'),
    );
  });

  it.each(observationIds)('%s names its implementing phase', (id) => {
    const start = DOC.indexOf(`## \`${id}\``);
    expect(start, `section for ${id} not found`).toBeGreaterThanOrEqual(0);
    const nextHeading = DOC.indexOf('\n## ', start + 1);
    const section = DOC.slice(start, nextHeading === -1 ? DOC.length : nextHeading);
    expect(section, `${id}'s section carries no "#### Phase" heading naming a phase`).toMatch(
      /#### Phase\s*\n+\s*O\d+/,
    );
  });

  it('the register never claims a section reads as an implementation for a method with none', () => {
    // Every id whose registry summary says "not implemented" must have its
    // methods.md section say so too, in the section's own Status paragraph.
    // The two documents are not allowed to disagree about which methods run.
    for (const entry of Object.values(METHOD_REGISTRY)) {
      if (entry.category !== 'observation') continue;
      if (!/not implemented/i.test(entry.summary)) continue;
      const start = DOC.indexOf(`## \`${entry.id}\``);
      const nextHeading = DOC.indexOf('\n## ', start + 1);
      const section = DOC.slice(start, nextHeading === -1 ? DOC.length : nextHeading);
      expect(section, `${entry.id}'s section does not restate "not implemented"`).toMatch(
        /not implemented in v0\.7/i,
      );
    }
  });
});
