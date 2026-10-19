/**
 * Every Dependabot ecosystem waits the same time before offering a release: a
 * freshly published malicious version is usually yanked before it reaches a
 * pull request. The GitHub Actions entry had no cooldown while npm had one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const yml = readFileSync(fileURLToPath(new URL('../.github/dependabot.yml', import.meta.url)), 'utf8');
const entries = yml.split(/^ {2}- package-ecosystem:/m).slice(1);

describe('.github/dependabot.yml', () => {
  it('has the npm and github-actions ecosystems', () => {
    expect(entries.map((e) => /^\s*"([^"]+)"/.exec(e)?.[1])).toEqual(expect.arrayContaining(['npm', 'github-actions']));
  });

  it.each(entries.map((e) => [/^\s*"([^"]+)"/.exec(e)?.[1] ?? '?', e] as const))('%s waits 7 days (14 for a major) before offering a release', (_name, entry) => {
    expect(entry).toMatch(/cooldown:\s*\n\s*default-days: 7\s*\n\s*semver-major-days: 14/);
  });
});
