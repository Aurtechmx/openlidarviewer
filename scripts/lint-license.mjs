#!/usr/bin/env node
/**
 * lint-license.mjs
 *
 * Machine-verifies the OpenLiDARViewer licensing boundary so a release cannot
 * drift away from it:
 *
 *   current project license  AGPL-3.0-only
 *   first AGPL release       v0.6.7
 *   last MIT release         v0.6.6
 *
 * It asserts the CURRENT-license surfaces (package.json, LICENSE, CITATION.cff,
 * .zenodo.json, codemeta.json, the README License section and badge, the app
 * console banner, and the current release notes) all say AGPL-3.0-only. It does
 * NOT blindly reject the string
 * "MIT": historical statements ("releases through v0.6.6 were distributed under
 * MIT"), third-party notices, and license texts legitimately mention MIT, and
 * those are left alone. Only the guarded current-license surfaces are checked,
 * which is the context-aware allowlist the release-gate philosophy asks for.
 *
 * `checkLicense(root)` returns the problem list so tests can drive it against
 * mutated fixtures. Usage: `node scripts/lint-license.mjs` (also
 * `npm run lint:license`, wired into test:release:execute and the release gate).
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';

export const CURRENT_LICENSE = 'AGPL-3.0-only';
export const FIRST_AGPL_RELEASE = '0.6.7';
export const LAST_MIT_RELEASE = '0.6.6';

/** Verify the current-license surfaces under `root`; returns a list of problems. */
export function checkLicense(root) {
  const problems = [];
  const read = (p) => { const f = resolve(root, p); return existsSync(f) ? readFileSync(f, 'utf8') : null; };
  const must = (cond, msg) => { if (!cond) problems.push(msg); };

  const pkgText = read('package.json');
  must(pkgText != null, 'package.json is missing.');
  const pkg = pkgText ? JSON.parse(pkgText) : {};
  must(pkg.license === CURRENT_LICENSE, `package.json license is ${JSON.stringify(pkg.license)}, expected ${CURRENT_LICENSE}.`);
  const version = pkg.version;

  const lic = read('LICENSE') || '';
  must(/GNU AFFERO GENERAL PUBLIC LICENSE/.test(lic) && /Version 3, 19 November 2007/.test(lic), 'LICENSE is not the canonical GNU AGPL v3 text.');
  must(!/Permission is hereby granted, free of charge/.test(lic), 'LICENSE still contains MIT permission text.');

  for (const f of ['LICENSING.md', 'COMMERCIAL-LICENSING.md', 'docs/CLA.md']) {
    must(existsSync(resolve(root, f)), `${f} is missing.`);
  }

  const cff = read('CITATION.cff') || '';
  must(/license:\s*AGPL-3\.0-only/.test(cff), 'CITATION.cff license is not AGPL-3.0-only.');
  must(!/license:\s*MIT\b/.test(cff), 'CITATION.cff still declares MIT as the current license.');

  // The project manifest's own License section. A historical "released under MIT
  // through v0.6.6" sentence stays legal; what fails is the section leading with
  // a bare MIT declaration (the stale "MIT. See LICENSE." this closed).
  const manifest = read('docs/project/MANIFEST.md') || '';
  must(/AGPL-3\.0-only/.test(manifest), 'docs/project/MANIFEST.md does not state AGPL-3.0-only as the current license.');
  must(!/##\s*License\s*\n+\s*MIT\b/.test(manifest), 'docs/project/MANIFEST.md still declares MIT as the current license.');

  // The archival and machine-readable metadata surfaces. These carry the
  // license to Zenodo and to software indexers, and on the v0.6.7 relicense
  // both shipped MIT and were caught only by hand — lint:license did not read
  // them. Zenodo uses the SPDX identifier; codemeta uses the SPDX URL.
  const zenodoText = read('.zenodo.json');
  must(zenodoText != null, '.zenodo.json is missing.');
  if (zenodoText != null) {
    let zenodo = {};
    try { zenodo = JSON.parse(zenodoText); } catch { problems.push('.zenodo.json is not valid JSON.'); }
    must(zenodo.license === CURRENT_LICENSE, `.zenodo.json license is ${JSON.stringify(zenodo.license)}, expected ${CURRENT_LICENSE}.`);
  }

  const codemetaText = read('codemeta.json');
  must(codemetaText != null, 'codemeta.json is missing.');
  if (codemetaText != null) {
    let codemeta = {};
    try { codemeta = JSON.parse(codemetaText); } catch { problems.push('codemeta.json is not valid JSON.'); }
    const cmLicense = typeof codemeta.license === 'string' ? codemeta.license : '';
    must(/AGPL-3\.0-only/.test(cmLicense), `codemeta.json license is ${JSON.stringify(codemeta.license)}, expected the AGPL-3.0-only SPDX URL.`);
    must(!/\/MIT\b/.test(cmLicense), 'codemeta.json still declares the MIT license.');
  }

  const readme = read('README.md') || '';
  must(/license-AGPL/.test(readme), 'README license badge is not AGPL.');
  must(/\(AGPL-3\.0-only\)/.test(readme), 'README License section does not state AGPL-3.0-only.');

  const main = read('src/main.ts') || '';
  must(!/under the MIT license/.test(main), 'src/main.ts console banner still claims the MIT license.');
  must(/AGPL-3\.0-only license/.test(main), 'src/main.ts console banner does not name AGPL-3.0-only.');

  // The docs site's VitePress theme footer. It renders on every published docs
  // page, so a stale "MIT licensed" there is a wrong-license public declaration
  // just like the manifest surfaces above. lint:license did not read it before.
  const docsSiteConfig = read('docs-site/.vitepress/config.mts') || '';
  must(!/\bMIT licensed\b/.test(docsSiteConfig), 'docs-site/.vitepress/config.mts footer still claims "MIT licensed" as the current license.');
  must(/AGPL-3\.0-only/.test(docsSiteConfig), 'docs-site/.vitepress/config.mts footer does not name AGPL-3.0-only.');

  if (version) {
    const notes = read(`docs/releases/RELEASE_NOTES_v${version}.md`);
    must(notes != null, `docs/releases/RELEASE_NOTES_v${version}.md is missing.`);
    if (notes != null) {
      must(/AGPL-3\.0-only/.test(notes) && /licens/i.test(notes), `RELEASE_NOTES_v${version}.md does not describe the license change.`);
    }
  }
  return problems;
}

// CLI
if (isCliEntry(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const problems = checkLicense(root);
  if (problems.length > 0) {
    console.error('lint:license FAILED\n');
    for (const p of problems) console.error(`  • ${p}`);
    console.error(`\nHistorical MIT references are allowed where they describe releases through v${LAST_MIT_RELEASE}. The checks above cover only the current-license surfaces.`);
    process.exit(1);
  }
  console.log(`lint:license OK — project license ${CURRENT_LICENSE}, first AGPL release v${FIRST_AGPL_RELEASE}, last MIT release v${LAST_MIT_RELEASE}; historical MIT references allowed where accurate.`);
}
