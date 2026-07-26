/**
 * sourceGuards.test.ts — static guards on the framework source itself.
 *
 * Two properties cannot be proven by exercising the API, because the offending
 * call would simply produce a plausible-looking number: that no module on the
 * hashed-artifact path reads the wall clock or a random source, and that no
 * module fills a missing measurement with 0. Both are checked by reading the
 * source, so a future suite author cannot reintroduce them unnoticed.
 */
import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRAMEWORK = fileURLToPath(new URL('../../benchmarks/framework', import.meta.url));
const BENCHMARKS = fileURLToPath(new URL('../../benchmarks', import.meta.url));
const REPO = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Every form an import specifier can take.
 *
 * `from 'x'` alone missed four of them, and this repo has no ESLint to enforce
 * a quote style, so the double-quoted case is the likeliest to appear:
 *   import { x } from "node:crypto"    — double quotes
 *   import 'node:crypto'               — side-effect only, no `from`
 *   await import('node:fs')            — dynamic
 *   export { x } from "node:os"        — re-export, also `from`
 */
const SPECS = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

const FRAMEWORK_FILES = sourceFiles(FRAMEWORK);
/**
 * EVERY benchmark module, not just the framework's.
 *
 * The clock/random and dependency guards below are properties of anything that
 * feeds a hashed artifact, and the fixtures and the pipeline driver do exactly
 * that. Scoping them to `benchmarks/framework` left the generator that produces
 * the data and the driver that produces the artifacts entirely unguarded — and
 * the suites landing next would have been unguarded too, by default and
 * silently. Only the module manifest below stays framework-scoped: it pins a
 * fixed file list, which is right for a stable core and wrong for a directory
 * suites keep adding to.
 */
const FILES = sourceFiles(BENCHMARKS);

describe('the framework source', () => {
  test('ships every module the suites are built on', () => {
    const names = FRAMEWORK_FILES.map((f) => f.slice(FRAMEWORK.length + 1));
    expect(names).toEqual([
      'artifacts.ts',
      'clock.ts',
      'env.ts',
      'index.ts',
      'memory.ts',
      'node.ts',
      'reporters/csv.ts',
      'reporters/html.ts',
      'reporters/json.ts',
      'reporters/markdown.ts',
      'reporters/metricText.ts',
      'stage.ts',
      'types.ts',
    ]);
  });

  test('nothing reachable from index.ts imports a node: builtin', () => {
    // The schema advertises browser-taken metrics and clock/memory both have
    // browser branches, so a browser-side suite has to be able to bundle the
    // barrel. Re-exporting captureEnvironment made node:child_process a static
    // dependency of the WHOLE surface and Vite could not resolve it at all.
    //
    // The walk follows anything that resolves INSIDE THE REPO, not just inside
    // benchmarks/framework: `artifacts.ts` deliberately depends on
    // src/canonicalHash.ts and src/terrain/export/sha256.ts, both shared with
    // the app, and someone speeding up that hand-rolled sha256 with node:crypto
    // would break the browser barrel while a framework-only walk stayed green.
    const seen = new Set<string>();
    const offenders: string[] = [];

    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(SPECS)) {
        const spec = m[1];
        if (spec.startsWith('node:')) {
          offenders.push(`${relative(REPO, file)} imports ${spec}`);
          continue;
        }
        if (!spec.startsWith('.')) continue;
        const target = join(dirname(file), spec.endsWith('.ts') ? spec : `${spec}.ts`);
        if (target.startsWith(REPO)) visit(target);
      }
    };

    visit(join(FRAMEWORK, 'index.ts'));
    expect(offenders).toEqual([]);
    // Sanity: the walk actually reached the modules, rather than passing by
    // never opening anything. Eleven framework files plus the two src helpers.
    expect(seen.size).toBeGreaterThanOrEqual(13);
  });

  test('the Node-only entry point is where the node: imports live', () => {
    const node = readFileSync(join(FRAMEWORK, 'node.ts'), 'utf8');
    expect(node).toMatch(/from ['"]node:crypto['"]/);
    expect(node).toMatch(/captureEnvironment/);
  });

  test('the fixtures and the driver stay runtime-neutral', () => {
    // Both are reachable from a browser-side suite: the generator so a browser
    // run measures the identical cloud, the driver so it can fill in the four
    // stages Node cannot measure. One `node:` import in either makes that
    // impossible, and the bundler is where you find out.
    for (const dir of [join(BENCHMARKS, 'fixtures'), join(BENCHMARKS, 'pipeline')]) {
      for (const file of sourceFiles(dir)) {
        const src = readFileSync(file, 'utf8');
        for (const m of src.matchAll(SPECS)) {
          expect(m[1].startsWith('node:'), `${relative(REPO, file)} imports ${m[1]}`).toBe(false);
        }
      }
    }
  });

  test('never calls Date.now() or Math.random() — both would poison an artifact hash', () => {
    for (const file of FILES) {
      const src = readFileSync(file, 'utf8');
      // Strip block/line comments first: the rule is about CALLS, and these
      // modules legitimately name the two functions when explaining the rule.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
      expect(code, file).not.toMatch(/Date\.now\s*\(/);
      expect(code, file).not.toMatch(/Math\.random\s*\(/);
      expect(code, file).not.toMatch(/new Date\s*\(/);
    }
  });

  test('declares no runtime dependency outside node: builtins and the reused src helpers', () => {
    for (const file of FILES) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(SPECS)) {
        const spec = m[1];
        const ok = spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../');
        expect(ok, `${file} imports ${spec}`).toBe(true);
      }
    }
  });
});
