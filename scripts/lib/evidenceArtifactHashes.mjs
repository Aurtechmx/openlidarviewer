/**
 * evidenceArtifactHashes.mjs — bind the recorded gate run to the artefacts it ran against.
 *
 * `collect-evidence.mjs` writes `packageLockSha256` and `sbom.sha256` into
 * docs/validation/test-evidence.json, and `create-release-manifest.mjs` copies
 * both into the release manifest. Nothing read them back. A record could name
 * one dependency tree while the repository shipped another, and every lint
 * stayed green, so the hashes documented a run rather than pinning it.
 *
 * Four states per artefact, none of them silent:
 *
 *   recorded + on disk + equal      pass
 *   recorded + on disk + different  fail, with both digests
 *   recorded + absent from disk     fail; the record claims a file that is not here
 *   not recorded + on disk          fail; an unbound artefact is not a verified one
 *   not recorded + absent from disk nothing exists to check, reported as a note
 *
 * The "not recorded + on disk" case is a failure on purpose. A record written
 * by an older schema carries no hash, and treating that absence as agreement is
 * the fail-open shape that already shipped once here: a missing value read as a
 * known-good one. The schema version appears in the message so a stale record
 * is diagnosable, but it never converts a failure into a pass.
 */

import { createHash } from 'node:crypto';

/** Schema version of `collect-evidence.mjs` that writes both hash fields. */
export const ARTIFACT_HASH_SCHEMA_VERSION = 3;

/**
 * The artefacts a record binds, as {field, file, recorded}. `field` is the
 * dotted path quoted in failure messages; `recorded` pulls the digest out of a
 * parsed evidence record.
 */
export const BOUND_ARTIFACTS = [
  {
    field: 'packageLockSha256',
    file: 'package-lock.json',
    recorded: (e) => e?.packageLockSha256 ?? null,
  },
  {
    field: 'sbom.sha256',
    file: 'sbom.json',
    recorded: (e) => e?.sbom?.sha256 ?? null,
  },
];

const isDigest = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

/** Hex sha256 of a Buffer or string. */
export const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Compare each recorded artefact digest against the file on disk.
 *
 * `readBytes(relativePath)` returns a Buffer for a readable file and null for
 * one that is absent or unreadable. `evidencePath` only names the record in
 * messages.
 *
 * Returns {problems, notes, checked}: `problems` fails the lint, `notes` are
 * the artefacts that exist nowhere and so were not checked, and `checked` lists
 * the fields actually verified.
 */
export function collectArtifactHashProblems({
  evidence,
  readBytes,
  evidencePath = 'docs/validation/test-evidence.json',
}) {
  const problems = [];
  const notes = [];
  const checked = [];
  const schema = evidence?.schemaVersion;

  for (const { field, file, recorded } of BOUND_ARTIFACTS) {
    const claimed = recorded(evidence);
    const bytes = readBytes(file);
    const present = bytes !== null && bytes !== undefined;

    if (claimed === null || claimed === undefined) {
      if (present) {
        problems.push(
          `${evidencePath} does not record ${field}, but ${file} is present on disk `
          + `(sha256 ${sha256Of(bytes)}). The record has schemaVersion ${JSON.stringify(schema)}; `
          + `schemaVersion ${ARTIFACT_HASH_SCHEMA_VERSION} writes this field. An absent hash is not a `
          + 'match, so the run is not bound to this artefact. Re-run "npm run evidence".',
        );
      } else {
        notes.push(`${field}: not recorded and ${file} is not present; nothing to verify.`);
      }
      continue;
    }

    if (!isDigest(claimed)) {
      problems.push(
        `${evidencePath} records ${field} ${JSON.stringify(claimed)}, which is not a sha256 digest.`,
      );
      continue;
    }

    if (!present) {
      problems.push(
        `${evidencePath} records ${field} ${claimed}, but ${file} is not present in this tree, `
        + 'so the recorded run cannot be tied to it.',
      );
      continue;
    }

    const actual = sha256Of(bytes);
    if (actual !== claimed) {
      problems.push(
        `${evidencePath} records ${field} ${claimed}, but ${file} on disk hashes to ${actual}. `
        + 'The recorded test run measured a different file than this tree ships. '
        + 'Re-run "npm run evidence" against a passing gate.',
      );
      continue;
    }

    checked.push(`${field} = ${claimed}`);
  }

  return { problems, notes, checked };
}
