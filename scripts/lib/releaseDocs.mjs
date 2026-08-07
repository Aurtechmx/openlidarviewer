/**
 * releaseDocs.mjs — the one place that knows where a release's versioned
 * documents live.
 *
 * The four truth documents (release notes, known limitations, validation
 * report, reproducibility) moved from the repository root under
 * `docs/releases/` in the v0.6.4 cycle. Several scripts built these paths by
 * hand, so the move broke each one silently: the tag-time ref check reported a
 * missing document, the evidence lint fell back to a different file, and the
 * release workflow copied a path that no longer existed. Deriving the paths
 * from one function keeps them from drifting apart again.
 */

/** Directory the versioned release documents live in, relative to repo root. */
export const RELEASE_DOCS_DIR = 'docs/releases';

/**
 * The four versioned truth documents for a release, as repo-root-relative
 * paths. `version` is the bare semver, e.g. "0.6.4".
 */
export function releaseDocsFor(version) {
  return {
    releaseNotes: `${RELEASE_DOCS_DIR}/RELEASE_NOTES_v${version}.md`,
    knownLimitations: `${RELEASE_DOCS_DIR}/KNOWN_LIMITATIONS_v${version}.md`,
    validationReport: `${RELEASE_DOCS_DIR}/VALIDATION_REPORT_v${version}.md`,
    reproducibility: `${RELEASE_DOCS_DIR}/REPRODUCIBILITY_v${version}.md`,
  };
}

/** The same four paths as an array, in a stable order. */
export function releaseDocPaths(version) {
  return Object.values(releaseDocsFor(version));
}
