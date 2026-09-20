import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEV_FLAG_DEFAULTS } from '../src/perf/devFlags';
import { TIER_ORDER } from '../src/render/continuity/continuityTier';

// `fileURLToPath`, not `.pathname`: the latter yields `/C:/...` on Windows,
// which no filesystem call accepts. The repo has a lint for exactly this.
const SCRIPT = fileURLToPath(new URL('../scripts/lint-tier-evidence.mjs', import.meta.url));
const REAL_FLAGS = new URL('../src/perf/devFlags.ts', import.meta.url);
const REAL_RECORDS = fileURLToPath(new URL('../validation/renderer-benchmark', import.meta.url));
const original = readFileSync(REAL_FLAGS, 'utf8');

/**
 * Run the lint against copies.
 *
 * Editing the real defaults table would be writing to a source file while the
 * rest of the suite reads it, and would leave the tree edited if this died
 * between the write and the restore.
 */
function run(tier?: string, records = REAL_RECORDS): { code: number; out: string } {
  const args = [SCRIPT];
  if (tier !== undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'olv-tier-'));
    const flags = join(dir, 'devFlags.ts');
    writeFileSync(flags, original.replace("continuityTier: 'source',", tier));
    args.push(flags, records);
  }
  try {
    return { code: 0, out: execFileSync('node', args, { encoding: 'utf8' }) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('the shipped default', () => {
  it('is source, which is what the ladder means by off', () => {
    expect(DEV_FLAG_DEFAULTS.continuityTier).toBe('source');
    expect(TIER_ORDER).toContain(DEV_FLAG_DEFAULTS.continuityTier);
  });

  it('passes the lint as the tree stands', () => {
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toContain('needs no measurement');
  });
});

describe('the lint refuses a rung nothing measured', () => {
  it.each(['sizing', 'closure', 'full'])('fails on a default of %s', (tier) => {
    const { code, out } = run(`continuityTier: '${tier}',`);
    expect(code).toBe(1);
    expect(out).toContain('no benchmark record');
    expect(out).toContain(`"${tier}"`);
  });

  it('names every rung the shipped one is built on', () => {
    // A default of full that measured only full skipped the two beneath it.
    const { out } = run("continuityTier: 'full',");
    for (const tier of ['sizing', 'closure', 'full']) expect(out).toContain(`"${tier}"`);
  });

  it('fails on a default that is not a rung at all', () => {
    const { code, out } = run("continuityTier: 'best',");
    expect(code).toBe(1);
    expect(out).toContain('not a rung');
  });

  it('fails when the line it reads has gone', () => {
    // The lint reads one line of one file. If the flag moves, this says so
    // rather than passing an unread default.
    const { code, out } = run('');
    expect(code).toBe(1);
    expect(out).toContain('no continuityTier default found');
  });
});

describe('what counts as evidence', () => {
  it('accepts a rung a record measured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olv-rec-'));
    mkdirSync(join(dir, 'records'));
    writeFileSync(join(dir, 'records', 'run.json'), JSON.stringify({
      cases: [{ continuity: { mode: 'sizing' } }],
    }));
    const { code, out } = run("continuityTier: 'sizing',", join(dir, 'records'));
    expect(code).toBe(0);
    expect(out).toContain('backed by records measuring sizing');
  });

  it('does not count a record it cannot read', () => {
    // A malformed record is the benchmark verifier's to report. Counting it
    // here would let a broken file authorise a default.
    const dir = mkdtempSync(join(tmpdir(), 'olv-rec-'));
    mkdirSync(join(dir, 'records'));
    writeFileSync(join(dir, 'records', 'run.json'), '{ not json');
    const { code } = run("continuityTier: 'sizing',", join(dir, 'records'));
    expect(code).toBe(1);
  });
});
