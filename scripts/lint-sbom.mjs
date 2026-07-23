#!/usr/bin/env node
/**
 * lint-sbom.mjs
 *
 * The SBOM is generated, shipped, and read by people who cannot regenerate it.
 * A stale one shipped once already: `metadata.component` still identified
 * alpha.2 while package.json was alpha.3. `lint:release-sync` now checks the
 * root identity, but nothing checked that the COMPONENT SET still describes the
 * lockfile it claims to describe — an SBOM can carry the right version header
 * and a dependency list from three releases ago.
 *
 * This validates SBOM IDENTITY and DEPENDENCY CONSISTENCY against package.json
 * and package-lock.json. It is not full CycloneDX schema validation; the
 * structural checks below cover bomFormat, specVersion and the components
 * array, nothing more. Claiming schema validation without running a schema
 * validator would be the kind of overstatement the rest of this file exists
 * to catch:
 *   1. structural shape (bomFormat / specVersion / components)
 *   2. root identity: name, version, bom-ref, purl
 *   3. every direct PRODUCTION dependency appears as a component
 *   4. each such component's version equals the LOCKED version
 *   5. no superseded root identity (an older version string in the root)
 *
 * Dev dependencies are deliberately NOT required: the SBOM is generated with
 * `--omit dev`, so their absence is correct, not drift.
 *
 * The rule logic is a pure function of a `read(path)` accessor so
 * tests/sbomLint.test.ts can exercise it against fixtures.
 *
 * Usage: `node scripts/lint-sbom.mjs` (also `npm run lint:sbom`).
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** Collect SBOM problems. `read(relPath)` returns text or null. */
export function collectSbomProblems(read) {
  const problems = [];
  const pkgText = read('package.json');
  const lockText = read('package-lock.json');
  const sbomText = read('sbom.json');

  if (pkgText == null) return { problems: ['package.json is missing.'], componentCount: 0 };
  if (lockText == null) return { problems: ['package-lock.json is missing.'], componentCount: 0 };
  if (sbomText == null) return { problems: ['sbom.json is missing.'], componentCount: 0 };

  const pkg = JSON.parse(pkgText);
  const lock = JSON.parse(lockText);
  const version = pkg.version;

  let sbom;
  try {
    sbom = JSON.parse(sbomText);
  } catch {
    return { problems: ['sbom.json is not valid JSON — regenerate it.'], componentCount: 0 };
  }

  // 1. Structural validity.
  if (sbom.bomFormat !== 'CycloneDX') {
    problems.push(`sbom.json bomFormat is "${sbom.bomFormat}", expected "CycloneDX".`);
  }
  if (!/^1\.\d+$/.test(String(sbom.specVersion ?? ''))) {
    problems.push(`sbom.json specVersion "${sbom.specVersion}" is not a CycloneDX 1.x version.`);
  }
  const components = Array.isArray(sbom.components) ? sbom.components : null;
  if (components == null) {
    problems.push('sbom.json has no components array.');
  } else if (components.length === 0) {
    problems.push('sbom.json lists zero components — it cannot describe this project.');
  }

  // 2. Root identity.
  const root = sbom?.metadata?.component ?? {};
  if (root.name !== 'openlidarviewer') {
    problems.push(`sbom.json root component name is "${root.name}", expected "openlidarviewer".`);
  }
  if (root.version !== version) {
    problems.push(
      `sbom.json root version is "${root.version}", expected "${version}" — regenerate the SBOM from this release's lockfile.`,
    );
  }
  for (const field of ['bom-ref', 'purl']) {
    const value = root[field];
    if (value && !String(value).includes(version)) {
      problems.push(`sbom.json root ${field} "${value}" does not identify v${version}.`);
    }
  }

  // 3 + 4. Direct production dependencies present, at their LOCKED versions.
  //
  // The locked version is the authority: a range in package.json ("^4.4.2")
  // legitimately resolves to something else ("4.4.3"), and the SBOM must
  // describe what is installed, not what was asked for.
  if (components) {
    // CycloneDX splits an npm scope into `group` + `name`: "@loaders.gl/core"
    // is stored as group "@loaders.gl", name "core". Keying on `name` alone
    // reports every scoped dependency as missing — a false failure against a
    // perfectly good SBOM, which is worse than no check at all.
    const byName = new Map();
    for (const c of components) {
      if (!c || !c.name) continue;
      byName.set(c.group ? `${c.group}/${c.name}` : c.name, c);
    }
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      const comp = byName.get(name);
      if (!comp) {
        problems.push(`sbom.json is missing direct production dependency "${name}".`);
        continue;
      }
      const locked = lock.packages?.[`node_modules/${name}`]?.version;
      if (locked && comp.version !== locked) {
        problems.push(
          `sbom.json lists "${name}" at ${comp.version}, but package-lock resolves ${locked}.`,
        );
      }
    }
  }

  return { problems, componentCount: components ? components.length : 0, version };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => (existsSync(resolve(ROOT, p)) ? readFileSync(resolve(ROOT, p), 'utf8') : null);
  const { problems, componentCount, version } = collectSbomProblems(read);

  if (problems.length === 0) {
    console.log(
      `lint:sbom OK — root openlidarviewer@${version}, ${componentCount} components, every direct ` +
        `production dependency at its locked version (identity + consistency checks, not full schema validation).`,
    );
    process.exit(0);
  }

  console.error('lint:sbom FAILED');
  console.error('');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('');
  console.error('  Regenerate with: npx @cyclonedx/cyclonedx-npm --omit dev --output-file sbom.json');
  process.exit(1);
}
