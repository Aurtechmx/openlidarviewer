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
import { bareSpecifier, markdownTargets, linkCandidates, importSpecifiers, scriptFileTargets, documentedScripts, manifestInventoryPaths, classifyMarkdownReferences, rootDocumentReferences, readsPackageFromNodeModules } from '../../scripts/verify-archive-portability.mjs';

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

describe('manifestInventoryPaths', () => {
  it('reads the documents and directories a manifest declares', () => {
    const text = [
      '- `POLICY_DOCUMENT.md`: the canonical policy.',
      '- `docs/validation/test-evidence.json`: development runs.',
      '- `src/`: application source.',
      'MIT. See `LICENSE`.',
    ].join('\n');
    expect(manifestInventoryPaths(text)).toEqual([
      'POLICY_DOCUMENT.md',
      'docs/validation/test-evidence.json',
      'src/',
      'LICENSE',
    ]);
  });

  it('reads nothing out of a code span that is prose rather than a path', () => {
    expect(manifestInventoryPaths('Run `npm run gate` and read `the notes`.')).toEqual([]);
  });

  it('does not join a code span that spans a line break', () => {
    expect(manifestInventoryPaths('walks `npm run\nrelease:verify` from the tag.')).toEqual([]);
  });
});

describe('classifyMarkdownReferences', () => {
  it('separates local targets from external ones instead of dropping the externals', () => {
    const text = [
      '[sibling](./sibling.md)',
      '[home](https://example.org/x)',
      '[mail](mailto:someone@example.org)',
      '[scheme-relative](//cdn.example.org/a.png)',
      '[section](#results)',
      '<!--@include: ../../TOP.md-->',
    ].join('\n');
    expect(classifyMarkdownReferences(text, 'docs-site/guide/index.md')).toEqual([
      { via: 'link', raw: './sibling.md', kind: 'local', target: 'docs-site/guide/sibling.md' },
      { via: 'link', raw: 'https://example.org/x', kind: 'external', target: null },
      { via: 'link', raw: 'mailto:someone@example.org', kind: 'external', target: null },
      { via: 'link', raw: '//cdn.example.org/a.png', kind: 'external', target: null },
      { via: 'link', raw: '#results', kind: 'anchor', target: null },
      { via: 'include', raw: '../../TOP.md', kind: 'local', target: 'TOP.md' },
    ]);
  });

  it('reads a site-absolute link as the site root inside docs-site and as a deployed URL outside it', () => {
    expect(classifyMarkdownReferences('[a](/releases/v1.md)', 'docs-site/index.md')).toEqual([
      { via: 'link', raw: '/releases/v1.md', kind: 'local', target: 'docs-site/releases/v1.md' },
    ]);
    expect(classifyMarkdownReferences('[a](/releases/v1)', 'README.md')).toEqual([
      { via: 'link', raw: '/releases/v1', kind: 'deployed', target: null },
    ]);
  });

  it('keeps the path of a target that carries a fragment or a query', () => {
    expect(classifyMarkdownReferences('[a](./x.md#part?y=1)', 'README.md')).toEqual([
      { via: 'link', raw: './x.md#part?y=1', kind: 'local', target: 'x.md' },
    ]);
  });
});

describe('rootDocumentReferences', () => {
  it('finds a root document named in prose and in a code span, not only in a link', () => {
    expect(rootDocumentReferences('governed by CLAIMS_AND_LIMITATIONS.md and `STABILITY_POLICY.md`.')).toEqual([
      'CLAIMS_AND_LIMITATIONS.md',
      'STABILITY_POLICY.md',
    ]);
  });

  it('finds a versioned root document', () => {
    expect(rootDocumentReferences('see VALIDATION_REPORT_v0.5.9.md for the inherited claims')).toEqual([
      'VALIDATION_REPORT_v0.5.9.md',
    ]);
  });

  it('does not read a document under a directory as a root document', () => {
    expect(rootDocumentReferences('docs/releases/RELEASE_NOTES_v0.6.0.md is the copy under docs/')).toEqual([]);
  });

  it('reads nothing out of prose that names no document', () => {
    expect(rootDocumentReferences('The policy is versioned and reviewed before a tag.')).toEqual([]);
    expect(rootDocumentReferences('lower-case names like readme.md are not root documents')).toEqual([]);
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
