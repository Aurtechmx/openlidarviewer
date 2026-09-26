/**
 * Scores recoverPointRecords against the intake corpus, with the definitions
 * of validation/intake-corpus/criteria.json. Shared by the tuning unit tests
 * and the one-shot held-out runner.
 */
// @ts-expect-error plain ESM generator without type declarations
import { generateCorpus } from '../../validation/intake-corpus/generate.mjs';
import { recoverPointRecords } from '../../src/io/intakeRecovery/recoverPointRecords';

export interface SampleOutcome {
  id: string;
  label: 'positive' | 'negative';
  layoutKey?: string;
  offered: boolean;
  reason?: string;
  layoutExact?: boolean;
  layoutMismatch?: string[];
  coordinateError?: number | null;
  countMatches?: boolean;
}

type Field = { name: string; offset: number; type: string; scale?: number; origin?: number };
type Truth =
  | { kind: 'binary'; headerBytes: number; stride: number; endianness: string; fields: Field[] }
  | { kind: 'text'; delimiter: string; headerLines: number; coordinateColumns: number[] };

export function scoreSample(entry: { id: string; label: 'positive' | 'negative'; layoutKey?: string; layout?: Truth }, bytes: Uint8Array, truth: Float64Array | null): SampleOutcome {
  const out = recoverPointRecords(bytes);
  const base: SampleOutcome = { id: entry.id, label: entry.label, layoutKey: entry.layoutKey, offered: out.status === 'offer' };
  if (out.status !== 'offer') return { ...base, reason: out.reason };
  if (entry.label === 'negative' || !entry.layout || !truth) return base;
  const t = entry.layout, l = out.layout;
  const mismatch: string[] = [];
  if (t.kind !== l.kind) mismatch.push('kind');
  else if (t.kind === 'binary' && l.kind === 'binary') {
    if (t.headerBytes !== l.headerBytes) mismatch.push('headerBytes');
    if (t.stride !== l.stride) mismatch.push('stride');
    if (t.endianness !== l.endianness) mismatch.push('endianness');
    ['x', 'y', 'z'].forEach((a, k) => {
      const f = t.fields.find((q) => q.name === a)!;
      if (f.offset !== l.offsets[k]) mismatch.push(`${a}.offset`);
      if (f.type !== l.type) mismatch.push(`${a}.type`);
      if ((f.scale ?? 1) !== l.scale) mismatch.push(`${a}.scale`);
      if ((f.origin ?? 0) !== 0) mismatch.push(`${a}.origin`);
    });
  } else if (t.kind === 'text' && l.kind === 'text') {
    if (t.delimiter !== l.delimiter) mismatch.push('delimiter');
    if (t.headerLines !== l.headerLines) mismatch.push('headerLines');
    if (t.coordinateColumns.join() !== l.coordinateColumns.join()) mismatch.push('coordinateColumns');
  }
  const n = truth.length / 3;
  const countMatches = out.pointCount === n;
  let err: number | null = null;
  if (countMatches) {
    let maxAbs = 0, worst = 0;
    for (let i = 0; i < truth.length; i++) {
      maxAbs = Math.max(maxAbs, Math.abs(truth[i]));
      worst = Math.max(worst, Math.abs(out.points[i] - truth[i]));
    }
    err = worst / Math.max(1, maxAbs);
  }
  return { ...base, layoutExact: mismatch.length === 0, layoutMismatch: mismatch, coordinateError: err, countMatches };
}

export function scoreSplit(split: 'tuning' | 'heldout'): SampleOutcome[] {
  const samples = generateCorpus().filter((s: { entry: { split: string } }) => s.entry.split === split);
  return samples.map((s: { entry: Parameters<typeof scoreSample>[0]; bytes: Buffer; truth: Float64Array | null }) =>
    scoreSample(s.entry, new Uint8Array(s.bytes.buffer, s.bytes.byteOffset, s.bytes.byteLength), s.truth));
}

export interface CriteriaVerdict {
  positives: number; negatives: number;
  falsePositives: number; falsePositiveRate: number;
  layoutExact: number; layoutExactRate: number;
  offeredPositives: number; coordinateFailures: number; maxCoordinateError: number | null;
  pass: { falsePositiveRate: boolean; layoutExactRate: boolean; coordinateError: boolean };
  verdict: 'PASS' | 'FAIL';
}

export function evaluate(outcomes: SampleOutcome[], th: { negativeFalsePositiveRateMax: number; positiveLayoutExactRateMin: number; offeredCoordinateRelativeErrorMax: number }): CriteriaVerdict {
  const pos = outcomes.filter((o) => o.label === 'positive');
  const neg = outcomes.filter((o) => o.label === 'negative');
  const fp = neg.filter((o) => o.offered).length;
  const exact = pos.filter((o) => o.offered && o.layoutExact).length;
  const offered = pos.filter((o) => o.offered);
  const coordFail = offered.filter((o) => o.coordinateError == null || o.coordinateError > th.offeredCoordinateRelativeErrorMax).length;
  const errs = offered.map((o) => o.coordinateError).filter((e): e is number => e != null);
  const pass = {
    falsePositiveRate: fp / neg.length <= th.negativeFalsePositiveRateMax,
    layoutExactRate: exact / pos.length >= th.positiveLayoutExactRateMin,
    coordinateError: coordFail === 0,
  };
  return {
    positives: pos.length, negatives: neg.length, falsePositives: fp, falsePositiveRate: fp / neg.length,
    layoutExact: exact, layoutExactRate: exact / pos.length, offeredPositives: offered.length,
    coordinateFailures: coordFail, maxCoordinateError: errs.length ? Math.max(...errs) : null,
    pass, verdict: pass.falsePositiveRate && pass.layoutExactRate && pass.coordinateError ? 'PASS' : 'FAIL',
  };
}
