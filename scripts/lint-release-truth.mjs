#!/usr/bin/env node
/**
 * lint-release-truth.mjs
 *
 * Catches a class of drift where the public
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
  const RELEASE_NOTES = `RELEASE_NOTES_v${version}.md`;
  const ARCHMAP = 'docs/architecture/architecture-map.md';
  const CLAIMS = 'docs/validation/claim-register.yaml';
  const EVTEST = 'tests/evidenceRegistry.test.ts';
  const DEPS = 'DEPENDENCIES.md';
  const NOTICES = 'THIRD_PARTY_NOTICES.md';
  const RELEASE_ASSETS = 'docs/release/RELEASE_ASSETS.md';

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
  // Runs for STABLE versions too: a stable doc saying "DISABLED in alpha.3"
  // is a present-tense claim about a superseded release — the exact blind
  // spot the v0.6.0 promotion exposed (rule was gated on currentPre, so it
  // switched itself off at the release that needed it most).
  {
    const say = currentPre ?? `v${version}`;
    for (const doc of [KNOWN, VALREPORT]) {
      const text = read(doc);
      if (text == null) continue;
      for (const m of text.matchAll(/DISABLED in (alpha|beta|rc)\.(\d+)/g)) {
        const pre = `${m[1]}.${m[2]}`;
        if (pre !== currentPre) {
          problems.push(
            `${doc} says "DISABLED in ${pre}" — this is a present-tense claim about ` +
              `the current release, which is ${say}. Say "${say}".`,
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
      const h = text.match(/^#\s*Dependency audit\s*(?:[—-]\s*|\()v([0-9][0-9A-Za-z.\-]*)/m);
      if (!h) problems.push(`${DEPS} has no "# Dependency audit (vX.Y.Z)" heading to check.`);
      else if (h[1] !== version) {
        problems.push(`${DEPS} is headed "v${h[1]}", expected v${version} — it is a stale audit record.`);
      }
    }
  }

  // ── 4b. Dependency audit names the canonical toolchain, not a stale one ──
  // The heading check above caught a document still titled for the previous
  // release. It did not catch one titled correctly while recording the wrong
  // runtime: the audit shipped saying Node 26 / npm 11 after the project had
  // pinned 22.17.1 / 10.9.2. Derive the expected strings from .nvmrc and the
  // packageManager pin so this check moves when the pins move.
  {
    const text = read(DEPS);
    if (text != null) {
      const nvmrc = (read('.nvmrc') ?? '').trim();
      if (/^\d+\.\d+\.\d+$/.test(nvmrc) && !text.includes(nvmrc)) {
        problems.push(`${DEPS} never names the canonical Node ${nvmrc} (.nvmrc).`);
      }
      const pmNpm = String(pkg.packageManager ?? '').split('@')[1];
      if (pmNpm && !text.includes(pmNpm)) {
        problems.push(`${DEPS} never names the canonical npm ${pmNpm} (package.json packageManager).`);
      }
      const lockText = read('package-lock.json');
      if (lockText) {
        const lockfileVersion = JSON.parse(lockText).lockfileVersion;
        const row = new RegExp(`lockfileVersion[^\n]*\\b${lockfileVersion}\\b`);
        if (!row.test(text)) {
          problems.push(`${DEPS} does not state lockfileVersion ${lockfileVersion} from package-lock.json.`);
        }
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

  // ── 7. The shipped asset index documents the full asset set ───────────────
  // RELEASE_CHECKLIST.md is an internal process aid and is export-ignored, so
  // the source archive cannot depend on it. The public, shipped index of what a
  // release attaches is docs/release/RELEASE_ASSETS.md — assert the asset set
  // there, so this lint passes from inside the extracted archive too.
  {
    const text = read(RELEASE_ASSETS);
    if (text == null) problems.push(`${RELEASE_ASSETS} is missing.`);
    else {
      const required = [
        ['source ZIP', /source[- ][^\n]*\.zip/i],
        ['deploy ZIP', /deploy[- ][^\n]*\.zip/i],
        ['sbom.json', /sbom\.json/i],
        ['release manifest', /release[- ]manifest/i],
        ['SHA256SUMS', /SHA256SUMS/],
        ['gate.log', /gate\.log/],
        ['gate.log.sha256', /gate\.log\.sha256/],
        ['test-evidence.json', /test-evidence\.json/],
        ['release notes', /RELEASE_NOTES/],
      ];
      for (const [label, re] of required) {
        if (!re.test(text)) problems.push(`${RELEASE_ASSETS} does not document the "${label}" release asset.`);
      }
    }
  }

  // ── 8. The shipped mount flag agrees with the current truth docs ──────────
  // PR #238 flipped MULTI_LAYER_MOUNT_ENABLED on AFTER v0.6.3 tagged, while all
  // three truth docs still say multi-layer mounting is disabled — a live
  // contradiction the mount wording above never saw, because rule 2 only
  // matched alpha/beta/rc phrasing. Assert the shipped flag and the docs
  // describe the same state, in both directions.
  {
    const svc = read('src/app/LayerService.ts');
    if (svc == null) {
      problems.push('src/app/LayerService.ts unreadable — cannot verify the mount flag.');
    } else {
      const flagMatch = svc.match(/export const MULTI_LAYER_MOUNT_ENABLED\s*=\s*(true|false)\s*;/);
      if (!flagMatch) {
        problems.push('src/app/LayerService.ts has no "export const MULTI_LAYER_MOUNT_ENABLED = true|false;" declaration to check.');
      } else {
        const mountEnabled = flagMatch[1] === 'true';
        // A doc asserting mounting is OFF. Bounded by sentence/line so the span
        // stays within one claim.
        const MOUNT_DISABLED_CLAIM =
          /(?:multi-layer mount\w*|mounting)[^.\n]*\b(?:disabled|remains disabled)\b|MULTI_LAYER_MOUNT_ENABLED\s*=\s*false/i;
        // A doc asserting mounting is ON. Requires "is" so "Turning mounting on
        // waits …" and "mounting is off" do not read as an enabled claim.
        const MOUNT_ENABLED_CLAIM =
          /(?:multi-layer mount\w*|mounting)\s+is(?:\s+now)?\s+(?:enabled|on)\b|MULTI_LAYER_MOUNT_ENABLED\s*=\s*true/i;
        for (const doc of [KNOWN, VALREPORT, RELEASE_NOTES]) {
          const text = read(doc);
          if (text == null) continue;
          if (mountEnabled) {
            const m = MOUNT_DISABLED_CLAIM.exec(text);
            if (m) {
              problems.push(
                `${doc} says "${m[0]}", but src/app/LayerService.ts ships ` +
                  `MULTI_LAYER_MOUNT_ENABLED = true. Re-disable the flag or correct the doc.`,
              );
            }
          } else {
            const m = MOUNT_ENABLED_CLAIM.exec(text);
            if (m) {
              problems.push(
                `${doc} says "${m[0]}", but src/app/LayerService.ts ships ` +
                  `MULTI_LAYER_MOUNT_ENABLED = false. Enable the flag or correct the doc.`,
              );
            }
          }
        }
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
