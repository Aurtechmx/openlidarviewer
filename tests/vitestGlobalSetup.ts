/**
 * Global teardown that removes vitest's own transform directory.
 *
 * With the forks pool, vitest writes every transformed module to
 * `<os tmpdir>/<random id>/ssr/` so workers can read it from disk instead of
 * receiving it over IPC. A project removes its own directory on close, but the
 * default project shares the fetcher of the root `Vitest` instance, which
 * writes to a second directory (`Vitest._tmpDir`) that nothing removes. Each
 * run of the unit suite left one such directory behind, tens of megabytes
 * each, and they accumulated without bound.
 *
 * `_tmpDir` is internal to vitest. If a later release renames or removes it,
 * this teardown does nothing rather than failing the run; the guard below
 * keeps it from ever deleting anything outside the OS temp directory.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { TestProject } from 'vitest/node';

export default function setup(project: TestProject): () => void {
  return () => {
    const dir = (project.vitest as unknown as { _tmpDir?: unknown })._tmpDir;
    if (typeof dir !== 'string') return;
    if (dirname(resolve(dir)) !== resolve(tmpdir())) return;
    rmSync(dir, { recursive: true, force: true });
  };
}
