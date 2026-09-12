/**
 * deploySmokeContract.mjs — the one definition of a deploy-smoke result.
 *
 * The producer (scripts/smoke-deploy-zip.mjs) and the verifier
 * (scripts/verify-release-assets.mjs) both need to agree on what a valid result
 * is. Stated twice, they drift: the producer gains a check, the verifier keeps
 * accepting records without it, and the gate quietly stops requiring the thing
 * it was added to require. So the schema version, the project name and the list
 * of mandatory checks live here and are imported by both.
 *
 * The check names are the CONTRACT, not a log. `checks` being a non-empty array
 * was the first version of this rule and it was worth nothing: a record naming
 * one trivial check satisfied it while no browser had opened the archive.
 */

/** The result schema this repository writes and accepts. */
export const DEPLOY_SMOKE_SCHEMA_VERSION = 1;

/** The project a result must name, so another project's record cannot satisfy it. */
export const DEPLOY_SMOKE_PROJECT = 'openlidarviewer';

/**
 * Every check a passing run must have performed, by name.
 *
 * The first four establish that the bytes verified are the bytes shipped; the
 * last two are the browser specs that actually drive the extracted archive. A
 * result missing any of them describes a weaker run than the release requires.
 */
export const REQUIRED_SMOKE_CHECKS = Object.freeze([
  'archive-listed-in-checksums',
  'archive-digest-matches-checksums',
  'archive-extracts',
  'archive-has-index-html',
  'smoke.spec.ts',
  'lazyChunkLoad.spec.ts',
]);

/**
 * Structural problems with `value` as a deploy-smoke result, ignoring anything
 * that needs the staged directory to judge (archive name, digest, commit).
 *
 * Returns [] when the record is structurally sound. Every falsy JSON value —
 * `null`, `false`, `0`, `""` — and every array reaches this as a defect rather
 * than as a skipped check: the verifier's original `if (smoke)` guard treated
 * all four as "nothing to check" and passed the release.
 */
export function deploySmokeStructureProblems(value) {
  const problems = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(
      `deploy-smoke result must be a JSON object, got ${
        Array.isArray(value) ? 'an array' : value === null ? 'null' : typeof value
      }`,
    );
    return problems;
  }
  if (value.schemaVersion !== DEPLOY_SMOKE_SCHEMA_VERSION) {
    problems.push(
      `deploy-smoke schemaVersion is ${JSON.stringify(value.schemaVersion)}, ` +
        `expected ${DEPLOY_SMOKE_SCHEMA_VERSION}`,
    );
  }
  if (value.project !== DEPLOY_SMOKE_PROJECT) {
    problems.push(
      `deploy-smoke names project ${JSON.stringify(value.project)}, ` +
        `expected ${JSON.stringify(DEPLOY_SMOKE_PROJECT)}`,
    );
  }
  // Strictly true. `"true"`, 1 and a truthy object are not a pass.
  if (value.ok !== true) {
    problems.push(`deploy-smoke result does not record a pass (ok is ${JSON.stringify(value.ok)})`);
  }
  if (!Array.isArray(value.checks)) {
    problems.push('deploy-smoke result names no executed checks');
  } else {
    const missing = REQUIRED_SMOKE_CHECKS.filter((c) => !value.checks.includes(c));
    if (missing.length > 0) {
      problems.push(`deploy-smoke result is missing required check(s): ${missing.join(', ')}`);
    }
  }
  return problems;
}
