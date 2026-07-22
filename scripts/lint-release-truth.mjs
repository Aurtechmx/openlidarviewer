#!/usr/bin/env node
/**
 * lint-release-truth.mjs
 *
 * Catches the class of drift a human review found in v0.6.0-alpha.3: the public
 * TRUTH surfaces contradicting the machine-readable state they describe. None of
 * these break a build, and `lint:release-sync` / `lint:evidence` did not see
 * them, so they shipped:
 *   - an alpha.3 limitations doc still quoting alpha.2 monolith line counts;
 *   - "nothing is E4" / "every reference slot is pending" wording while the
 *     registry has one E4 claim and one supplied reference slot;
 *   - a dependency-audit doc still headed with the previous release;
 *   - a direct-dependency version in THIRD_PARTY_NOTICES.md that disagreed with
 *     package.json;
 *   - validation prose claiming ALL terrain evidence is inherited unchanged;
 *   - a release checklist missing required release-asset entries.
 *
 * Expected values are DERIVED from authoritative machine files
 * (package.json, monolith-size-baseline.json, src/validation/crossCheck.ts, the
 * claim register). The scan is scoped to the CURRENT release's truth documents
 * only — historical alpha.1/alpha.2/v0.5.9 files are allowed to state their own
 * facts and are never scanned here.
 *
 * The rule logic is a pure function of a `read(path)` accessor so
 * tests/releaseTruthLint.test.ts can prove each stale phrase fails without
 * touching the real tree. `read(path)` returns the file text, or null if absent.
 *
 * Usage: `node scripts/lint-release-truth.mjs` (also `npm run lint:release-truth`,
 * wired into `test:release:execute`).
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Collect every truth-drift problem. `read(relPath)` returns the file's text or
 * null when it does not exist. Returns an array of human-readable problem
 * strings (empty when the tree is clean).
 */
export function collectReleaseTruthProblems(read) {
  const problems = [];
  const pkgText = read('package.json');
  if (pkgText == null) return { problems: ['package.json is missing.'], version: null, currentPre: null, e4Claims: 0, suppliedSlots: 0 };
  const pkg = JSON.parse(pkgText);
  const version = pkg.version;

  const alphaMatch = version.match(/-(alpha|beta|rc)\.(\d+)/);
  const currentPre = alphaMatch ? `${alphaMatch[1]}.${alphaMatch[2]}` : null;

  const KNOWN = `KNOWN_LIMITATIONS_v${version}.md`;
  const VALREPORT = `VALIDATION_REPORT_v${version}.md`;
  const ARCHMAP = 'docs/architecture/architecture-map.md';
  const CLAIMS = 'docs/validation/claim-register.yaml';
  const EVTEST = 'tests/evidenceRegistry.test.ts';
  const DEPS = 'DEPENDENCIES.md';
  const NOTICES = 'THIRD_PARTY_NOTICES.md';
  const CHECKLIST = 'RELEASE_CHECKLIST.md';

  // ── 1. Monolith line counts, derived from the ratchet baseline ────────────
  const baseText = read('docs/validation/monolith-size-baseline.json');
  if (baseText == null) {
    problems.push('docs/validation/monolith-size-baseline.json is missing — cannot check monolith counts.');
  } else {
    const base = JSON.parse(baseText);
    const withSep = (n) => n.toLocaleString('en-US'); // 7521 -> "7,521"
    const expected = new Set(Object.values(base.files).map((f) => withSep(f.lines)));
    const expectedList = [...expected].join(', ');
    for (const doc of [KNOWN, ARCHMAP]) {
      const text = read(doc);
      if (text == null) {
        problems.push(`${doc} is missing — cannot check monolith counts.`);
        continue;
      }
      for (const m of text.matchAll(/\b7,\d{3}\b/g)) {
        if (!expected.has(m[0])) {
          problems.push(
            `${doc} states monolith count "${m[0]}", but the ratchet baseline ` +
              `(docs/validation/monolith-size-baseline.json) says ${expectedList}. ` +
              `Update the doc to the current line counts.`,
          );
        }
      }
      for (const f of Object.values(base.files)) {
        if (!text.includes(withSep(f.lines))) {
          problems.push(`${doc} never states the current count ${withSep(f.lines)} for a monolith.`);
        }
      }
    }
  }

  // ── 2. Present-tense prior-release identifiers in current truth docs ───────
  if (currentPre) {
    for (const doc of [KNOWN, VALREPORT]) {
      const text = read(doc);
      if (text == null) continue;
      for (const m of text.matchAll(/DISABLED in (alpha|beta|rc)\.(\d+)/g)) {
        const pre = `${m[1]}.${m[2]}`;
        if (pre !== currentPre) {
          problems.push(
            `${doc} says "DISABLED in ${pre}" — this is a present-tense claim about ` +
              `the current release, which is ${currentPre}. Say "${currentPre}".`,
          );
        }
      }
    }
  }

  // ── 3. "nothing is E4" wording vs the actual registry ─────────────────────
  let suppliedSlots = 0;
  const cc = read('src/validation/crossCheck.ts');
  if (cc == null) problems.push('src/validation/crossCheck.ts unreadable — cannot verify E4 wording.');
  else suppliedSlots = (cc.match(/status:\s*'supplied'/g) || []).length;

  let e4Claims = 0;
  const reg = read(CLAIMS);
  if (reg == null) problems.push(`${CLAIMS} unreadable — cannot verify E4 wording.`);
  else e4Claims = (reg.match(/currentEvidence:\s*E4_/g) || []).length;

  const STALE_E4 = /nothing (?:here )?is E4|no claim (?:reaches|is at) E4|every reference slot is pending|all reference slots are pending/i;
  if (suppliedSlots >= 1 || e4Claims >= 1) {
    for (const doc of [CLAIMS, EVTEST, VALREPORT, KNOWN]) {
      const text = read(doc);
      if (text == null) continue;
      const m = STALE_E4.exec(text);
      if (m) {
        problems.push(
          `${doc} says "${m[0]}", but the registry has ${e4Claims} E4 claim(s) and ` +
            `${suppliedSlots} supplied reference slot(s) (src/validation/crossCheck.ts). ` +
            `Correct the wording.`,
        );
      }
    }
  }

  // ── 4. Dependency-audit doc names the current release ─────────────────────
  {
    const text = read(DEPS);
    if (text == null) problems.push(`${DEPS} is missing.`);
    else {
      const h = text.match(/^#\s*Dependency audit\s*[—-]\s*v([0-9][0-9A-Za-z.\-]*)/m);
      if (!h) problems.push(`${DEPS} has no "# Dependency audit — vX.Y.Z" heading to check.`);
      else if (h[1] !== version) {
        problems.push(`${DEPS} is headed "v${h[1]}", expected v${version} — it is a stale audit record.`);
      }
    }
  }

  // ── 5. THIRD_PARTY_NOTICES direct-dep rows agree with the manifest ────────
  {
    const text = read(NOTICES);
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    if (text == null) problems.push(`${NOTICES} is missing.`);
    else {
      const listed = new Map();
      for (const line of text.split('\n')) {
        const m = line.match(/^\|\s*([@A-Za-z0-9/._-]+)\s*\|\s*([~^]?[0-9][0-9A-Za-z.\-]*)\s*\|/);
        if (m && declared[m[1]]) listed.set(m[1], m[2]);
      }
      for (const [name, range] of Object.entries(declared)) {
        if (!listed.has(name)) {
          problems.push(`${NOTICES} is missing a row for direct dependency "${name}" (declared ${range}).`);
        } else if (listed.get(name) !== range) {
          problems.push(
            `${NOTICES} lists "${name}" declared range ${listed.get(name)}, but package.json declares ${range}.`,
          );
        }
      }
    }
  }

  // ── 6. Validation report does not claim ALL terrain evidence is unchanged ──
  {
    const text = read(VALREPORT);
    if (text != null) {
      const overclaim = /terrain and contour (?:correctness )?claims are\s*(?:\*\*)?inherited unchanged/i;
      if (overclaim.test(text)) {
        problems.push(
          `${VALREPORT} says the terrain and contour claims are "inherited unchanged" — ` +
            `alpha.3 changed the evidence state of SLOPE-RASTER (E3->E4). Distinguish ` +
            `inherited ALGORITHMS from the new E4 evidence.`,
        );
      }
    }
  }

  // ── 7. Release checklist requires the full asset set ──────────────────────
  {
    const text = read(CHECKLIST);
    if (text == null) problems.push(`${CHECKLIST} is missing.`);
    else {
      const required = [
        ['source ZIP', /source zip/i],
        ['deploy ZIP', /deploy zip/i],
        ['sbom.json', /sbom\.json/i],
        ['release manifest', /release[- ]manifest|release manifest/i],
        ['SHA256SUMS', /SHA256SUMS/],
        ['gate.log', /gate\.log/],
        ['gate.log.sha256', /gate\.log\.sha256/],
        ['test-evidence.json', /test-evidence\.json/],
        ['release notes', /RELEASE_NOTES/],
      ];
      for (const [label, re] of required) {
        if (!re.test(text)) problems.push(`${CHECKLIST} does not require the "${label}" release asset.`);
      }
    }
  }

  return { problems, version, currentPre, e4Claims, suppliedSlots };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => (existsSync(resolve(ROOT, p)) ? readFileSync(resolve(ROOT, p), 'utf8') : null);
  const { problems, version, currentPre, e4Claims, suppliedSlots } = collectReleaseTruthProblems(read);

  if (problems.length === 0) {
    console.log(
      `lint:release-truth OK — monolith counts, ${currentPre ?? 'release'} identifiers, ` +
        `E4 wording (${e4Claims} E4 / ${suppliedSlots} supplied), dependency audit, ` +
        `THIRD_PARTY versions, validation wording, and the checklist asset set all agree ` +
        `with the machine state for v${version}.`,
    );
    process.exit(0);
  }

  console.error('lint:release-truth FAILED');
  console.error('');
  console.error(`Public truth documents contradict the machine state (v${version}):`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error('');
  process.exit(1);
}
