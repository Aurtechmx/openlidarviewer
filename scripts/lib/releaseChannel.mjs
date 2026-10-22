/**
 * releaseChannel.mjs: the release channel a version belongs to.
 *
 * A semantic version with a prerelease part (0.7.0-alpha.1) is a prerelease;
 * one without (0.7.0) is stable. Evidence and the release manifest both read
 * the channel from here, so a stable tag is never published as a prerelease
 * and a prerelease is never published as stable. A development record keeps
 * the `development` channel and is never authoritative.
 */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** 'stable' or 'prerelease' for a valid semantic version, or null when the version is not one. */
export function releaseChannelFor(version) {
  const m = SEMVER.exec(String(version ?? ''));
  if (!m) return null;
  return m[4] ? 'prerelease' : 'stable';
}

/**
 * Problems with a release's version, tag and channel taken together: the version
 * must be a semantic version, the tag must be `v` + version, and a stated
 * channel must be the one the version implies.
 */
export function releaseChannelProblems({ version, tag, channel }) {
  const problems = [];
  const expected = releaseChannelFor(version);
  if (!expected) problems.push(`version ${version} is not a semantic version`);
  if (tag != null && version && tag !== `v${version}`) problems.push(`tag ${tag} does not match v${version}`);
  if (channel != null && expected && channel !== expected) {
    problems.push(`release channel ${channel} does not match version ${version} (${expected})`);
  }
  return problems;
}
