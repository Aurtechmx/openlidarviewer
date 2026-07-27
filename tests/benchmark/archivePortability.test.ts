/**
 * Unit cover for the pure predicates behind `npm run benchmark:archive-portability`.
 *
 * The suite itself runs against an extracted archive in a temp directory and is
 * a script, not a vitest suite, because it must not import anything from the
 * application: an app import would pull in the Vite `BUILD_IDENTITY` define and
 * tie the check to a build of the working tree, which is the coupling the whole
 * suite exists to break.
 *
 * What is testable in isolation is the parsing: which link is a link, which
 * string is an import, which path a script tells a reader to run. Each case
 * below has a matching negative, because a matcher that never says no cannot
 * catch anything.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs tooling module, no type declarations
import { bareSpecifier, markdownTargets, linkCandidates, importSpecifiers, scriptFileTargets, documentedScripts, readsPackageFromNodeModules } from '../../scripts/verify-archive-portability.mjs';

describe('bareSpecifier', () => {
  it('names the package for bare and scoped specifiers', () => {
    expect(bareSpecifier('three')).toBe('three');
    expect(bareSpecifier('three/examples/jsm/controls/OrbitControls.js')).toBe('three');
    expect(bareSpecifier('@loaders.gl/core')).toBe('@loaders.gl/core');
    expect(bareSpecifier('@loaders.gl/core/dist/index.js')).toBe('@loaders.gl/core');
  });

  it('returns null for anything that is not a package', () => {
    for (const s of ['./local', '../up', '/abs', 'node:fs', 'data:text/js,0', 'https://x/y.js', '']) {
      expect(bareSpecifier(s)).toBeNull();
    }
  });
});

describe('markdownTargets', () => {
  it('resolves relative links and includes against the file that holds them', () => {
    const t = markdownTargets('[a](./sibling.md) and <!--@include: ../../TOP.md-->', 'docs-site/guide/index.md');
    expect(t).toEqual([
      { kind: 'link', target: 'docs-site/guide/sibling.md' },
      { kind: 'include', target: 'TOP.md' },
    ]);
  });

  it('keeps the path of a sectioned include', () => {
    expect(markdownTargets('<!--@include: ../../docs/usage.md#embed-reference-->', 'docs-site/reference/x.md')).toEqual([
      { kind: 'include', target: 'docs/usage.md' },
    ]);
  });

  it('treats a site-absolute link as site-relative only inside docs-site', () => {
    expect(markdownTargets('[f](/formats/)', 'docs-site/guide/index.md')).toEqual([
      { kind: 'link', target: 'docs-site/formats/' },
    ]);
    expect(markdownTargets('[f](/formats/)', 'README.md')).toEqual([]);
  });

  it('ignores external URLs, mail links and bare anchors', () => {
    expect(markdownTargets('[a](https://x/y) [b](mailto:a@b.c) [c](#section)', 'README.md')).toEqual([]);
  });
});

describe('linkCandidates', () => {
  it('offers the extensionless and index forms VitePress accepts', () => {
    expect(linkCandidates('docs-site/guide/user-guide')).toContain('docs-site/guide/user-guide.md');
    expect(linkCandidates('docs-site/formats/')).toContain('docs-site/formats/index.md');
  });
});

describe('importSpecifiers', () => {
  it('finds static, side-effect, re-export, dynamic and require forms', () => {
    const src = [
      "import { A } from 'three';",
      "import '@fontsource/manrope/latin-400.css';",
      "export { B } from './b';",
      "const m = await import('proj4');",
      "const p = require('pdf-lib');",
    ].join('\n');
    expect(importSpecifiers(src)).toEqual(['three', '@fontsource/manrope/latin-400.css', './b', 'proj4', 'pdf-lib']);
  });

  it('does not mistake prose for an import', () => {
    const src = ['/* derived from "matches" and from "NAD83" */', "// falls back from 'x'", "const s = 'imported from \"three\"';"].join('\n');
    expect(importSpecifiers(src)).toEqual([]);
  });
});

describe('scriptFileTargets', () => {
  it('lists the files an npm script tree executes', () => {
    const targets = scriptFileTargets({
      a: 'node scripts/lint-sbom.mjs',
      b: 'bash scripts/package.sh --source-only',
      c: 'vitest run tests/benchmark/runSuites.test.ts --testTimeout=600000',
      d: 'playwright test --project=deterministic tests/e2e/smoke.spec.ts',
    });
    expect(targets).toEqual(
      expect.arrayContaining(['scripts/lint-sbom.mjs', 'scripts/package.sh', 'tests/benchmark/runSuites.test.ts', 'tests/e2e/smoke.spec.ts']),
    );
  });

  it('finds nothing in a script that runs no file from the tree', () => {
    expect(scriptFileTargets({ dev: 'vite', typecheck: 'tsc --noEmit' })).toEqual([]);
  });
});

describe('documentedScripts', () => {
  it('picks up every npm run named in prose', () => {
    expect(documentedScripts('Run `npm run gate`, then npm run release:verify -- --dir release.')).toEqual(['gate', 'release:verify']);
  });

  it('picks up nothing from prose that names no command', () => {
    expect(documentedScripts('Install the dependencies and open the page.')).toEqual([]);
  });
});

describe('readsPackageFromNodeModules', () => {
  // The real case: a build script assembles the path one segment at a time, so
  // the joined package name never appears as a single string.
  const segmented = 'ROOT / "node_modules" / "@fontsource-variable" / "inter" / "files" / "x.woff2"';

  it('finds a scoped package whose path is built from separate segments', () => {
    expect(readsPackageFromNodeModules([segmented], '@fontsource-variable/inter')).toBe(true);
  });

  it('finds a package named as one joined path', () => {
    expect(readsPackageFromNodeModules(['open("node_modules/laz-perf/lib.wasm")'], 'laz-perf')).toBe(true);
  });

  it('does not report a package nothing reads', () => {
    expect(readsPackageFromNodeModules([segmented], 'three')).toBe(false);
    expect(readsPackageFromNodeModules([], '@fontsource-variable/inter')).toBe(false);
  });

  it('needs both halves of a scoped name, not either one', () => {
    expect(readsPackageFromNodeModules(['node_modules/@fontsource-variable/roboto'], '@fontsource-variable/inter')).toBe(false);
    expect(readsPackageFromNodeModules(['node_modules/other-scope/inter'], '@fontsource-variable/inter')).toBe(false);
  });
});
