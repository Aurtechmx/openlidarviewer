/**
 * render.ts
 *
 * The comparison as a document a reader can act on without reading the JSON.
 *
 * THE HEADLINE IS THE STATUS, NOT A TICK. A suppressed comparison prints the
 * reason it was suppressed in the same position a pass would print its claim,
 * so a reader skimming the top of the file cannot mistake "not measured here"
 * for "measured and agreed". The tolerance table prints the pre-registered
 * gate next to every observation, so a threshold and the number it judged are
 * never separated.
 *
 * WHAT IS NOT COVERED IS PRINTED ON A PASS, not only on a failure. The limits
 * of a result are part of the result.
 *
 * Pure. No I/O, no clock, no randomness.
 */

import { adapterName, type BackendComparison } from './compare';
import type { BackendLegRecord } from './record';
import { PRE_REGISTERED_TOLERANCES } from './tolerances';

const HEADLINE: Readonly<Record<BackendComparison['status'], string>> = {
  'equivalent-within-tolerance':
    'The GPU and CPU backends agree on every compared quantity, within thresholds registered before the comparison ran.',
  'backends-diverged':
    'The GPU and CPU backends disagree beyond a pre-registered threshold. The quantity and magnitude are below.',
  'backend-unavailable':
    'Not measured. The requested backend did not execute, so no comparison was run and no agreement is claimed.',
  'record-not-credible':
    'Not measured. A leg claims a backend its environment cannot provide, so its numbers were not read.',
  'parameters-diverged':
    'Not measured. The two legs ran different parameters, so their outputs answer different questions.',
};

function num(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  if (Math.abs(value) >= 1e-3 && Math.abs(value) < 1e6) return String(Number(value.toPrecision(6)));
  return value.toExponential(3);
}

/** The legs table: what each leg asked for, what ran, and on what. */
function legsTable(legs: readonly BackendLegRecord[]): string {
  const rows = legs.map((l) => {
    const adapter = l.adapter === null ? 'none' : adapterName(l.adapter);
    return `| ${l.legId} | ${l.environment} | ${l.requestedBackend} | **${l.executedBackend}** | ${l.reason} | ${adapter} |`;
  });
  return [
    '| leg | environment | requested | executed | engine reason | adapter |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** Full report for one comparison. */
export function comparisonMarkdown(
  comparison: BackendComparison,
  legs: readonly BackendLegRecord[],
): string {
  const out: string[] = [];
  out.push('# Backend equivalence: GPU against the CPU reference');
  out.push('');
  out.push(`Status: \`${comparison.status}\``);
  out.push('');
  out.push(HEADLINE[comparison.status]);
  if (comparison.suppressionReason !== null) {
    out.push('');
    out.push(`Reason: ${comparison.suppressionReason}`);
  }

  out.push('');
  out.push('## Which backend executed');
  out.push('');
  out.push(
    'Read from the engine\'s own `getComputePath()` after initialisation, not from what the leg asked for. The engine falls back to the CPU reference silently when no WebGPU adapter is present, which is correct product behaviour and would make a request-based record report agreement between the CPU and itself.',
  );
  out.push('');
  out.push(legsTable(legs));

  out.push('');
  out.push('## Pre-registered thresholds');
  out.push('');
  out.push(
    'Fixed in `benchmarks/backends/tolerances.ts` before any comparison ran. The CPU reference computes in f64 and stores f32; the WGSL kernels compute in f32 and may fuse or reassociate, and their `atan2` and `sqrt` are implementation precision. That representation difference is an expected source of divergence, and the floor column is what it alone accounts for.',
  );
  out.push('');
  out.push('| quantity | unit | gate | f32 floor | derived from |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const t of PRE_REGISTERED_TOLERANCES) {
    out.push(
      `| ${t.quantity} | ${t.unit} | ${num(t.gate)} | ${t.representationFloor === null ? 'exact' : num(t.representationFloor)} | ${t.derivation} |`,
    );
  }

  out.push('');
  out.push('## Observations');
  out.push('');
  if (comparison.quantities.length === 0) {
    out.push('None. The comparison was suppressed for the reason above.');
  } else {
    out.push('| quantity | max observed | gate | cells | verdict |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const q of comparison.quantities) {
      const verdict = !q.withinGate
        ? 'exceeds the gate'
        : q.representationFloor === null
          ? 'exact, as the threshold requires'
          : q.aboveRepresentationFloor
            ? 'within the gate, above the f32 floor'
            : 'within the f32 floor';
      out.push(
        `| ${q.quantity} | ${num(q.observed)} ${q.unit} | ${num(q.gate)} | ${q.cells} | ${verdict} |`,
      );
    }
  }

  if (comparison.divergences.length > 0) {
    out.push('');
    out.push('## Divergences');
    out.push('');
    for (const d of comparison.divergences) out.push(`- ${d}`);
  }

  out.push('');
  out.push('## Not covered');
  out.push('');
  for (const n of comparison.notCovered) out.push(`- ${n}`);
  out.push('');
  return out.join('\n');
}
