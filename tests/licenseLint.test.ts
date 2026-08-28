import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { checkLicense } from '../scripts/lint-license.mjs';

// A minimal repository fixture that satisfies the license boundary. Each test
// starts from this valid tree and mutates ONE surface to prove the guard.
function writeValidFixture(root: string): void {
  const w = (p: string, s: string) => {
    const abs = resolve(root, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, s);
  };
  // The real canonical AGPL text is large; the linter only needs its markers.
  w('LICENSE', 'GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007\n\n...license body...\n');
  w('package.json', JSON.stringify({ name: 'openlidarviewer', version: '0.6.7', license: 'AGPL-3.0-only' }, null, 2));
  w('LICENSING.md', '# Licensing\nAGPL-3.0-only.\n');
  w('COMMERCIAL-LICENSING.md', '# Commercial licensing\n');
  w('docs/CLA.md', '# Contributor License Agreement\n');
  w('CITATION.cff', 'cff-version: 1.2.0\nversion: "0.6.7"\nlicense: AGPL-3.0-only\n');
  w('README.md', [
    '[![License](https://img.shields.io/badge/license-AGPL--3.0--only-blue)](LICENSE)',
    '## License',
    'OpenLiDARViewer v0.6.7 and later is licensed under the GNU Affero General Public License v3.0 only (AGPL-3.0-only).',
  ].join('\n\n'));
  w('src/main.ts', 'console.log(`OpenLiDARViewer v${x} — open source under the AGPL-3.0-only license.`);\n');
  w('docs/releases/RELEASE_NOTES_v0.6.7.md', '# v0.6.7\n## Licensing change\nFirst release under AGPL-3.0-only.\n');
}

describe('lint:license boundary', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(resolve(tmpdir(), 'olv-lic-')); writeValidFixture(root); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('passes on a valid AGPL-3.0-only tree', () => {
    expect(checkLicense(root)).toEqual([]);
  });

  it('rejects package.json declaring MIT', () => {
    writeFileSync(resolve(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.6.7', license: 'MIT' }, null, 2));
    expect(checkLicense(root).some((p) => /package\.json license/.test(p))).toBe(true);
  });

  it('rejects a README that claims MIT (badge)', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8').replace('license-AGPL--3.0--only-blue', 'license-MIT-lightgrey');
    writeFileSync(resolve(root, 'README.md'), readme);
    expect(checkLicense(root).some((p) => /README license badge/.test(p))).toBe(true);
  });

  it('rejects a LICENSE from the wrong family (MIT text)', () => {
    writeFileSync(resolve(root, 'LICENSE'), 'MIT License\n\nPermission is hereby granted, free of charge, to any person...\n');
    const problems = checkLicense(root);
    expect(problems.some((p) => /canonical GNU AGPL/.test(p) || /MIT permission text/.test(p))).toBe(true);
  });

  it('rejects release notes that omit the license change', () => {
    writeFileSync(resolve(root, 'docs/releases/RELEASE_NOTES_v0.6.7.md'), '# v0.6.7\nSome features.\n');
    expect(checkLicense(root).some((p) => /does not describe the license change/.test(p))).toBe(true);
  });

  it('rejects a console banner that still claims MIT', () => {
    writeFileSync(resolve(root, 'src/main.ts'), 'console.log(`OLV v${x} — open source under the MIT license.`);\n');
    expect(checkLicense(root).some((p) => /console banner still claims the MIT/.test(p))).toBe(true);
  });

  it('rejects CITATION.cff declaring MIT', () => {
    writeFileSync(resolve(root, 'CITATION.cff'), 'cff-version: 1.2.0\nversion: "0.6.7"\nlicense: MIT\n');
    const problems = checkLicense(root);
    expect(problems.some((p) => /CITATION\.cff/.test(p))).toBe(true);
  });

  it('ACCEPTS an accurate historical MIT statement', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
      + '\n\nReleases through v0.6.6 were distributed under the MIT License and remain under those terms.';
    writeFileSync(resolve(root, 'README.md'), readme);
    expect(checkLicense(root)).toEqual([]);
  });
});
