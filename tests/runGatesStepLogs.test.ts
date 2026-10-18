/**
 * runGatesStepLogs.test.ts: scripts/run-gates.mjs keeps each step's whole
 * output in release/gate-steps/<step>.log and names that file beside the tail
 * it prints for a failed step, and the logs stay out of what is shipped.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
// @ts-expect-error - plain .mjs script, no types
import { DEFAULT_STEP_LOG_DIR, failureBlock, prepareStepLogDir, stepLogName, writeStepLog } from '../scripts/lib/gateStepLogs.mjs';

const ROOT = resolve(__dirname, '..');

describe('gate step logs', () => {
  it('names a log after its npm script, without path separators', () => {
    expect(stepLogName('test:unit')).toBe('test_unit.log');
    expect(stepLogName('lint:module-graph')).toBe('lint_module-graph.log');
    expect(stepLogName('a/b c')).toBe('a_b_c.log');
  });

  it('keeps the whole output and prints only the tail with the path of the log', () => {
    const root = mkdtempSync(join(tmpdir(), 'olv-gate-steps-'));
    const dir = join(root, 'release', 'gate-steps');
    prepareStepLogDir(dir);
    writeFileSync(join(dir, 'stale.log'), 'from an earlier run');
    prepareStepLogDir(dir);
    expect(readdirSync(dir)).toEqual([]);

    const output = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const path = writeStepLog(dir, 'test:unit', output);
    expect(readFileSync(path, 'utf8')).toBe(output);

    const block = failureBlock({ script: 'test:unit', skipped: false, code: 1, output, logPath: path, root, tailLines: 40 });
    expect(block).toContain('==== test:unit: exit 1 ====');
    expect(block).toContain('line 500');
    expect(block).toContain('line 461');
    expect(block).not.toContain('line 460\n');
    expect(block.trimEnd().endsWith(`---- full output: ${join('release', 'gate-steps', 'test_unit.log')}`)).toBe(true);
  });

  it('a skipped step ran nothing, so it names no log', () => {
    const block = failureBlock({ script: 'test:e2e', skipped: true, code: null, output: 'skipped: needs build, which did not pass\n', logPath: undefined, root: ROOT, tailLines: 40 });
    expect(block).toContain('==== test:e2e: skipped ====');
    expect(block).not.toContain('full output');
  });

  it('the runner writes every finished step and prints the path of each failure', () => {
    const src = readFileSync(join(ROOT, 'scripts/run-gates.mjs'), 'utf8');
    expect(src).toMatch(/onDone: \(step, r\) => \{\s*logPaths\.set\(step\.script, writeStepLog\(logDir, step\.script, r\.output\)\)/);
    expect(src).toMatch(/failureBlock\(\{[^}]*logPath: logPaths\.get\(s\.script\)/);
    expect(src).toMatch(/prepareStepLogDir\(logDir\)/);
    expect(DEFAULT_STEP_LOG_DIR).toBe('release/gate-steps');
  });

  it('the logs are git-ignored and never staged, packaged or shipped', () => {
    const ignored = execFileSync('git', ['check-ignore', 'release/gate-steps/test_unit.log'], { cwd: ROOT, encoding: 'utf8' }).trim();
    expect(ignored).toBe('release/gate-steps/test_unit.log');
    // The source archive is copied with the generated release/ tree and every *.log excluded.
    const pkg = readFileSync(join(ROOT, 'scripts/package.sh'), 'utf8');
    expect(pkg).toContain("--exclude '/release/' --exclude '*.log'");
    // The release payload is assembled file by file; nothing under gate-steps is copied.
    const wf = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
    const payload = wf.slice(wf.indexOf('Assemble the flat release payload'), wf.indexOf('ls -la release/payload'));
    expect(payload).not.toContain('gate-steps');
    expect(existsSync(join(ROOT, 'scripts/lib/gateStepLogs.mjs'))).toBe(true);
  });
});
