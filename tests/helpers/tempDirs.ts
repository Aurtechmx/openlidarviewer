/**
 * Temporary directories a test file creates and removes again.
 *
 * Call `useTempDirs()` once at the top level of a test file. It registers an
 * `afterAll` that deletes every directory the returned `make` created, so a
 * test that writes a scaffold under the OS temp dir does not leave it behind
 * after the run.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

export function useTempDirs(): (prefix: string) => string {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  return (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
}
