/**
 * stage.test.ts — running one stage records it whether or not it succeeds.
 *
 * The stage runner is the only place the clock and the memory sampler are
 * composed, and it exists so three suites cannot each invent their own version
 * of "what happens when a stage throws". The behaviour that matters: a failed
 * stage still reports the timing and peak memory it actually consumed, because
 * "the decode blew up after 40 seconds and 6 GB" is a result, not a blank.
 */
import { describe, test, expect } from 'vitest';
import { runStage, runStageAsync } from '../../benchmarks/framework/stage';
import { isMeasured, measured, type StageResult } from '../../benchmarks/framework/types';

describe('runStage', () => {
  test('records the name, a measured duration in ms and peak RSS in bytes', () => {
    const { stage, value } = runStage('decode', () => 7);
    expect(stage.name).toBe('decode');
    expect(stage.status).toBe('ok');
    expect(value).toBe(7);
    if (!isMeasured(stage.duration) || !isMeasured(stage.peakMemory)) {
      throw new Error('expected both stage metrics to be measured in Node');
    }
    expect(stage.duration.unit).toBe('ms');
    expect(stage.duration.value).toBeGreaterThanOrEqual(0);
    expect(stage.peakMemory.unit).toBe('bytes');
    expect(stage.peakMemory.value).toBeGreaterThan(0);
  });

  test('a successful stage carries no error field', () => {
    expect(runStage('ok', () => 1).stage.error).toBeUndefined();
  });

  test('a throwing stage is failed, keeps its measurements, and reports no value', () => {
    const { stage, value } = runStage('decode', () => {
      throw new Error('truncated chunk');
    });
    expect(stage.status).toBe('failed');
    expect(stage.error).toBe('truncated chunk');
    expect(value).toBeUndefined();
    expect(isMeasured(stage.duration)).toBe(true);
    expect(isMeasured(stage.peakMemory)).toBe(true);
  });

  test('a thrown non-Error is stringified rather than lost', () => {
    const { stage } = runStage('decode', () => {
      throw 'nope';
    });
    expect(stage.status).toBe('failed');
    expect(stage.error).toBe('nope');
  });

  test('the error is the message, never a stack — a stack is machine-specific', () => {
    const { stage } = runStage('decode', () => {
      throw new Error('boom');
    });
    expect(stage.error).toBe('boom');
    expect(stage.error).not.toContain('at ');
    expect(stage.error).not.toContain('.ts:');
  });

  test('a multi-line message is collapsed to one line', () => {
    // Error.message is often multi-line (a parser quoting its input), and a raw
    // newline ends a Markdown row mid-table, turning the rest into a paragraph.
    const { stage } = runStage('decode', () => {
      throw new Error('bad header\n  at offset 12\r\nexpected LASF');
    });
    expect(stage.error).toBe('bad header; at offset 12; expected LASF');
    expect(stage.error).not.toMatch(/[\r\n]/);
  });

  /**
   * The status is the discriminant, so the two impossible records have to be
   * impossible to write. An unused `@ts-expect-error` is itself a typecheck
   * error, which is what makes these assertions fail if the union loosens.
   */
  test('a failure with no explanation, or a success carrying one, does not typecheck', () => {
    const common = {
      name: 'decode',
      duration: measured(1, 'ms', { runtime: 'node', deterministic: false }),
      peakMemory: measured(2, 'bytes', { runtime: 'node', deterministic: false }),
    } as const;

    // @ts-expect-error status:'failed' REQUIRES the error that explains it
    const unexplained: StageResult = { ...common, status: 'failed' };

    // @ts-expect-error status:'ok' forbids an error — there was nothing to report
    const contradictory: StageResult = { ...common, status: 'ok', error: 'boom' };

    expect(unexplained.status).toBe('failed');
    expect(contradictory.status).toBe('ok');
  });
});

describe('runStageAsync', () => {
  test('awaits the body and records the stage', async () => {
    const { stage, value } = await runStageAsync('load', async () => {
      await Promise.resolve();
      return 'done';
    });
    expect(stage.status).toBe('ok');
    expect(value).toBe('done');
    expect(isMeasured(stage.duration)).toBe(true);
  });

  test('a rejected body is failed, with its message and its measurements', async () => {
    const { stage, value } = await runStageAsync('load', async () => {
      await Promise.resolve();
      throw new Error('404 from the tile server');
    });
    expect(stage.status).toBe('failed');
    expect(stage.error).toBe('404 from the tile server');
    expect(value).toBeUndefined();
    expect(isMeasured(stage.duration)).toBe(true);
  });
});
