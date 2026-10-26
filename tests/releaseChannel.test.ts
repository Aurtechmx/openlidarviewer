/**
 * releaseChannel.test.ts: stable and prerelease versions are published as what
 * they are.
 *
 * The evidence collector and the manifest builder both labelled every
 * authoritative release `prerelease`, so a stable 0.7.0 would have shipped
 * marked as a prerelease. Both now read the channel from the version, keep
 * `development` for local records, and reject a tag or channel that does not
 * match the version.
 */
import { describe, expect, it } from 'vitest';
import { releaseChannelFor, releaseChannelProblems } from '../scripts/lib/releaseChannel.mjs';
import { buildManifest, PAYLOAD_KINDS } from '../scripts/create-release-manifest.mjs';

describe('releaseChannelFor', () => {
  it('reads stable and prerelease from the version', () => {
    expect(releaseChannelFor('0.7.0')).toBe('stable');
    expect(releaseChannelFor('0.7.0-alpha.1')).toBe('prerelease');
    expect(releaseChannelFor('1.0.0-rc.2+build.5')).toBe('prerelease');
    expect(releaseChannelFor('1.0.0+build.5')).toBe('stable');
  });

  it('gives no channel for a string that is not a semantic version', () => {
    expect(releaseChannelFor('v0.7.0')).toBeNull();
    expect(releaseChannelFor('0.7')).toBeNull();
    expect(releaseChannelFor(undefined)).toBeNull();
  });
});

describe('releaseChannelProblems', () => {
  it('accepts a matching version, tag and channel', () => {
    expect(releaseChannelProblems({ version: '0.7.0', tag: 'v0.7.0', channel: 'stable' })).toEqual([]);
    expect(releaseChannelProblems({ version: '0.7.0-alpha.1', tag: 'v0.7.0-alpha.1', channel: 'prerelease' })).toEqual([]);
  });

  it('rejects a stable version labelled prerelease, and the reverse', () => {
    expect(releaseChannelProblems({ version: '0.7.0', tag: 'v0.7.0', channel: 'prerelease' })[0]).toMatch(/does not match version 0\.7\.0 \(stable\)/);
    expect(releaseChannelProblems({ version: '0.7.0-alpha.1', tag: 'v0.7.0-alpha.1', channel: 'stable' })[0]).toMatch(/\(prerelease\)/);
  });

  it('rejects a tag that is not v + the version', () => {
    expect(releaseChannelProblems({ version: '0.7.0', tag: 'v0.7.1', channel: null })[0]).toMatch(/tag v0\.7\.1 does not match v0\.7\.0/);
  });
});

describe('the release manifest takes its channel from the version', () => {
  const assets = Object.fromEntries(PAYLOAD_KINDS.map((k: string) => [k, { file: `${k}.bin`, sizeBytes: 1, sha256: 'x' }]));
  const evidence = (version: string, over: Record<string, unknown> = {}) => ({
    version, commit: 'abc1234', tag: `v${version}`, releaseChannel: version.includes('-') ? 'prerelease' : 'stable',
    releaseAuthoritative: true, gateExit: 0, stages: { mutation: 'executed' }, ...over,
  });
  const build = (version: string, over: Record<string, unknown> = {}) =>
    buildManifest({ version, evidence: evidence(version, over), assets, builtAt: '2026-01-01T00:00:00.000Z', sourceDateEpoch: '1767225600' });

  it('marks a stable version stable and a prerelease prerelease', () => {
    expect(build('0.7.0').manifest!.releaseChannel).toBe('stable');
    expect(build('0.7.0-alpha.1').manifest!.releaseChannel).toBe('prerelease');
  });

  it('refuses evidence whose channel does not match the version', () => {
    const r = build('0.7.0', { releaseChannel: 'prerelease' });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/release channel prerelease does not match version 0\.7\.0/);
  });

  it('refuses development evidence and evidence with no channel', () => {
    expect(build('0.7.0', { releaseChannel: 'development', releaseAuthoritative: false }).ok).toBe(false);
    expect(build('0.7.0', { releaseChannel: undefined }).problems.join(' ')).toMatch(/names no release channel/);
  });
});

describe('buildManifest — the reproducible timestamp', () => {
  const version = '0.7.0';
  const assets = Object.fromEntries(PAYLOAD_KINDS.map((k) => [k, { file: `${k}.bin`, sizeBytes: 1, sha256: 'a'.repeat(64) }]));
  const evidence = {
    version, tag: `v${version}`, commit: 'b'.repeat(40), releaseChannel: 'stable', releaseAuthoritative: true,
    gateExit: 0, stages: { staticGate: 'passed', mutation: 'not-executed' }, mutation: { measuredAtCommit: 'c'.repeat(40) },
  };
  const build = (sourceDateEpoch: string | null) =>
    buildManifest({ version, evidence, assets, builtAt: '2026-01-01T00:00:00.000Z', sourceDateEpoch });

  it('records the committer time as a number', () => {
    const r = build('1767225600');
    expect(r.ok).toBe(true);
    expect(r.manifest!.sourceDateEpoch).toBe(1767225600);
  });

  it('refuses a release manifest with no timestamp, naming the variable', () => {
    const r = build(null);
    expect(r.ok).toBe(false);
    expect(r.problems.some((p: string) => p.includes('SOURCE_DATE_EPOCH'))).toBe(true);
  });

  it('refuses a value that is not a Unix time in seconds', () => {
    expect(build('2026-01-01').problems.some((p: string) => p.includes('not a Unix time'))).toBe(true);
  });
});
