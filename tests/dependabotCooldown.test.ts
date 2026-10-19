/**
 * Every Dependabot ecosystem waits before offering a release: a freshly
 * published malicious version is usually yanked before it reaches a pull
 * request. The GitHub Actions entry had no cooldown while npm had one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const yml = readFileSync(fileURLToPath(new URL('../.github/dependabot.yml', import.meta.url)), 'utf8');
const entries = yml.split(/^ {2}- package-ecosystem:/m).slice(1);
const named = entries.map((e) => [/^\s*"([^"]+)"/.exec(e)?.[1] ?? '?', e] as const);

describe('.github/dependabot.yml', () => {
  it('has the npm and github-actions ecosystems', () => {
    expect(named.map(([name]) => name)).toEqual(expect.arrayContaining(['npm', 'github-actions']));
  });

  it.each(named.filter(([name]) => name === 'npm'))('%s waits 7 days (14 for a major) before offering a release', (_name, entry) => {
    expect(entry).toMatch(/cooldown:\s*\n\s*default-days: 7\s*\n\s*semver-major-days: 14/);
  });

  // Dependabot rejects the whole file when github-actions sets a semver-*-days
  // key, so that entry has the 7-day default only.
  it('github-actions waits 7 days and sets no per-semver delay', () => {
    const entry = named.find(([name]) => name === 'github-actions')?.[1] ?? '';
    expect(entry).toMatch(/cooldown:\s*\n\s*default-days: 7\s*\n/);
    expect(entry).not.toMatch(/semver-(major|minor|patch)-days/);
  });
});
