/**
 * fieldSimulationLazyBoundary.test.ts: the simulation feature stays lazy.
 *
 * The eager entry chunk measures 809 KiB against a 812 KiB ceiling, so three
 * substantial feature clusters cannot arrive without a plan for where they
 * load. This fixes the boundary before the code exists: nothing under
 * `src/simulation/` or `src/ui/fieldSimulation/` may be reachable from the
 * entry over static imports. A dynamic `import()` is how they are meant to
 * arrive, and dynamic edges are deliberately not followed here.
 *
 * Neither directory exists yet, so the boundary assertion passes on an empty
 * set. That would be a guard proving nothing, which is why the discrimination
 * test below runs first: it pins that the walk actually separates an eager
 * module from a lazily-loaded one on today's tree. A check that cannot fail is
 * worse than no check, because it reads like cover.
 *
 * The graph comes from `lint-module-graph.mjs` rather than a second walker.
 * Two implementations of "what does the shell import" would eventually
 * disagree, and the lint's version is the one the architecture gate enforces.
 */
import { describe, expect, it } from 'vitest';

import { measureModuleGraph } from '../scripts/lint-module-graph.mjs';

/** Directories the next implementation fills, which must load on demand. */
const LAZY_ONLY = ['src/simulation/', 'src/ui/fieldSimulation/'];

/** The entry the browser loads first. */
const ENTRY = 'src/main.ts';

/**
 * Every module the shell pulls in through static imports.
 *
 * Value edges only. A type-only import is erased at build time and a dynamic
 * one is the lazy boundary itself, so following either would report modules
 * that never reach the entry chunk.
 */
function eagerlyReachable(): Set<string> {
  const { graph } = measureModuleGraph();
  const seen = new Set<string>();
  const stack = [ENTRY];
  while (stack.length > 0) {
    const file = stack.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const node = graph.get(file) as { value: ReadonlyMap<string, number> } | undefined;
    if (!node) continue;
    for (const next of node.value.keys()) stack.push(next);
  }
  return seen;
}

const eager = eagerlyReachable();

describe('the walk can tell eager from lazy', () => {
  it('reaches a module the shell imports directly', () => {
    // The most-imported module in the tree. If this is absent the walk is
    // broken and every other assertion here is vacuous.
    expect(eager.has('src/ui/dom.ts')).toBe(true);
  });

  it('does not reach modules behind a dynamic import', () => {
    // Both ride their own chunks: the Viewer through the lazy render-engine
    // boot, the context menu through `loadContextMenu`.
    expect(eager.has('src/render/Viewer.ts')).toBe(false);
    expect(eager.has('src/ui/contextMenu.ts')).toBe(false);
  });

  it('reaches a strict subset of the tree, so it is not simply collecting files', () => {
    const { graph } = measureModuleGraph();
    expect(eager.size).toBeGreaterThan(50);
    expect(eager.size).toBeLessThan(graph.size);
  });
});

describe('the field-simulation clusters stay off the entry chunk', () => {
  it.each(LAZY_ONLY)('no module under %s is statically reachable from the shell', (dir) => {
    const offenders = [...eager].filter((f) => f.startsWith(dir)).sort();
    expect(
      offenders,
      `${dir} must be reached through a dynamic import, not from the entry`,
    ).toEqual([]);
  });

  it('has modules to keep out, so the assertion above is no longer vacuous', () => {
    // This replaces the note recording that both directories were empty. The
    // flow-routing core now lives under `src/simulation/`, which is what makes
    // the boundary assertion above a real check rather than a statement about
    // an empty set: there is something that could leak onto the entry chunk,
    // and it does not.
    const { graph } = measureModuleGraph();
    const present = [...graph.keys()].filter((f) => LAZY_ONLY.some((d) => f.startsWith(d)));
    expect(present.length).toBeGreaterThan(0);
    expect(present.every((f) => !eager.has(f))).toBe(true);
  });
});
