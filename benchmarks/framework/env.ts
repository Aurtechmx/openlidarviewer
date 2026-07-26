/**
 * env.ts
 *
 * Capture the provenance of a benchmark run: OS, CPU, architecture, Node
 * version, git commit and release version.
 *
 * Node-side only — it reads `node:os`, the filesystem and `git`. The rest of the
 * framework stays runtime-neutral; this module is the one that touches the host.
 *
 * Two rules it never breaks:
 *
 *  - It never throws. A benchmark run that dies because `git` is not installed,
 *    or because the tree was unpacked from a source tarball with no `.git`, has
 *    turned a provenance gap into a lost measurement. Every field is captured
 *    independently, and a failure downgrades that one field to unavailable.
 *  - It never substitutes a placeholder. 'unknown', '' and 'n/a' all survive
 *    into a paper table looking like captured data; `{ status: 'unavailable',
 *    reason }` cannot be mistaken for one.
 */

import os from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { capturedEnv, unavailableEnv, type BenchmarkEnvironment, type EnvValue } from './types';

/** The repo root, two levels up from `benchmarks/framework/`. */
const DEFAULT_REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** A hung `git` must not hang the suite; a commit hash is not worth a stall. */
const GIT_TIMEOUT_MS = 5_000;

export interface CaptureEnvironmentOptions {
  /** Where to look for `.git` and `package.json`. Defaults to the repo root. */
  readonly repoRoot?: string;
}

/**
 * Run one capture, downgrading any throw to an unavailable field.
 *
 * The reason carries the thrown message because the useful distinction for a
 * reviewer is *why* — "git is not on PATH" and "not a git repository" call for
 * different fixes, and a generic "could not determine" hides both.
 */
function capture(what: string, read: () => string | null): EnvValue {
  try {
    const value = read();
    if (value === null || value.trim() === '') return unavailableEnv(`${what}: not reported by this host`);
    return capturedEnv(value.trim());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return unavailableEnv(`${what}: ${detail}`);
  }
}

/** Run a git command in `repoRoot`, letting the caller's try/catch see failures. */
function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    // stderr silenced: "not a git repository" is an expected outcome in a source
    // tarball, and printing it would look like a benchmark failure.
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** Read HEAD's full commit hash, or null when this is not a usable checkout. */
function readGitCommit(repoRoot: string): string | null {
  const out = git(repoRoot, ['rev-parse', 'HEAD']).trim();
  return /^[0-9a-f]{40}$/.test(out) ? out : null;
}

/**
 * Capture everything a reader needs to place this run.
 *
 * The short commit is DERIVED from the full one rather than read via
 * `git rev-parse --short`: that command's length follows repo config, so two
 * machines could report different short hashes for the same commit, and the
 * short form would stop being a prefix of the full one.
 */
export function captureEnvironment(options: CaptureEnvironmentOptions = {}): BenchmarkEnvironment {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;

  const gitCommitFull = capture('git commit', () => readGitCommit(repoRoot));
  const gitCommitShort =
    gitCommitFull.status === 'captured'
      ? capturedEnv(gitCommitFull.value.slice(0, 7))
      : unavailableEnv(gitCommitFull.reason);

  return {
    os: capture('os', () => `${os.platform()} ${os.release()}`),
    // `os.cpus()` returns an empty array on some containerised hosts, which is
    // why this reads the first entry defensively instead of indexing blind.
    cpuModel: capture('cpu model', () => os.cpus()[0]?.model ?? null),
    arch: capture('arch', () => process.arch),
    nodeVersion: capture('node version', () => process.version),
    gitCommitFull,
    gitCommitShort,
    /**
     * Whether the working tree matches the commit above.
     *
     * A commit hash on its own is a provenance claim the run may not be entitled
     * to: a benchmark run from a modified checkout reports a clean hash, and "I
     * regenerated this at that commit" then means nothing. For the
     * reproducibility suite this is the field that decides whether the rest of
     * the block can be trusted.
     */
    gitDirty: capture('git working tree', () =>
      git(repoRoot, ['status', '--porcelain']).trim() === '' ? 'clean' : 'dirty',
    ),
    releaseVersion: capture('release version', () => {
      const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
        version?: unknown;
      };
      return typeof pkg.version === 'string' ? pkg.version : null;
    }),
  };
}
