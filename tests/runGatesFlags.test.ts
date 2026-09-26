import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const run = (...args: string[]) =>
  spawnSync(process.execPath, ['scripts/run-gates.mjs', '--list', ...args], { encoding: 'utf8' });

describe('run-gates flag checks', () => {
  it('refuses a group that no step belongs to', () => {
    const r = run('--only-group=nosuch');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('names no group');
  });

  it('refuses a --jobs value that is not a whole number of 1 or more', () => {
    for (const bad of ['abc', '0', '-1', '1.5']) expect(run(`--jobs=${bad}`).status).toBe(2);
  });

  it('refuses flags that leave no step', () => {
    expect(run('--stop-before=typecheck').status).toBe(2);
  });

  it('lists a known group', () => {
    const r = run('--only-group=static', '--jobs=4');
    expect(r.status).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });
});
