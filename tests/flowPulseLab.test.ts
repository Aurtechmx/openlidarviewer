/**
 * flowPulseLab.test.ts — the Flow Pulse view shows what the runner said.
 *
 * Rendered through the recording DOM stub, as the Dataset Story card is. The
 * view owns no wording of its own about the run, so these tests compare the
 * rendered text against the runner's limitations rather than against copies
 * of them.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { installRecordingDom, type RecordingEl } from './helpers/recordingDom';
import { flowDtmOfCounted as dtmOf } from './helpers/flowFixtures';

beforeAll(installRecordingDom);

const digestModule = await import('../src/science/dtmProductDigest');
const { buildIdentityProvenance } = await import('../src/build/buildIdentity');
const { renderFlowPulseLab, runLabFlowPulse, flowScaleOf } = await import('../src/ui/fieldSimulation/flowPulseLab');
type LabInput = Parameters<typeof runLabFlowPulse>[0] & object;

function input(over: Partial<LabInput> = {}, resolved = true): LabInput {
  return {
    result: { dtm: dtmOf([[3, 2, 1], [3, 2, 1]]), horizontalScaleResolved: resolved } as never,
    isGeographic: false, worldOriginY: null, resolvedUnitToMetres: resolved ? 1 : null,
    layerId: 'scan-1', filename: 'site', ...over,
  };
}

const textOf = (node: HTMLElement) => (node as unknown as RecordingEl).textContent;

describe('a completed run', () => {
  it('shows every limitation the runner produced, verbatim', () => {
    const outcome = runLabFlowPulse(input({}, false));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.limitations.length).toBeGreaterThan(1);
    const text = textOf(renderFlowPulseLab(outcome));
    for (const sentence of outcome.limitations) expect(text).toContain(sentence);
  });

  it('withholds square metres when the horizontal scale is unresolved', () => {
    const outcome = runLabFlowPulse(input({}, false));
    const text = textOf(renderFlowPulseLab(outcome));
    expect(text).not.toContain('m²');
    expect(text).toContain('Withheld: the horizontal scale');
    // Cell counts survive, because direction does not depend on the unit.
    expect(text).toContain('3 cells');
  });

  it('reports square metres once the scale is resolved', () => {
    const text = textOf(renderFlowPulseLab(runLabFlowPulse(input())));
    expect(text).toContain('m²');
    expect(text).not.toContain('Withheld: the horizontal scale');
  });
});

describe('a refusal is a plain message', () => {
  it('names the missing analysis when no surface is on the panel', () => {
    const outcome = runLabFlowPulse(null);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const text = textOf(renderFlowPulseLab(outcome));
    expect(text).toContain('did not run');
    expect(text).toContain(outcome.reason);
  });

});

describe('a geographic frame with no world origin', () => {
  it.each([null, undefined, Number.NaN])('refuses with UNITS_UNRESOLVED when the origin is %s', (origin) => {
    const outcome = runLabFlowPulse(input({ isGeographic: true, worldOriginY: origin as never }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('UNITS_UNRESOLVED');
    expect(textOf(renderFlowPulseLab(outcome))).toContain(outcome.reason);
  });

  it('still runs a projected frame with no origin', () => {
    expect(runLabFlowPulse(input({ worldOriginY: null })).ok).toBe(true);
  });
});

describe('the frame the run reads', () => {
  it('takes latitude from the grid centre in world coordinates, as the analysis did', () => {
    const scale = flowScaleOf(input({ isGeographic: true, worldOriginY: 40 }));
    expect(scale.latitudeDeg).toBe(41); // 40 + 0 + (2 rows / 2) * 1
    expect(scale.resolved).toBe(true);
  });

  it('leaves a projected frame without a latitude', () => {
    expect(flowScaleOf(input()).latitudeDeg).toBeNull();
  });
});

describe('the record build field', () => {
  it('names the canonical build identity, not the bare version', () => {
    const outcome = runLabFlowPulse(input());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.build).toBe(buildIdentityProvenance());
    expect(outcome.record.build).toContain('·');
  });
});

describe('the grid digest', () => {
  it('is computed only for a run the runner accepts', () => {
    const spy = vi.spyOn(digestModule, 'dtmProductDigest');
    runLabFlowPulse(input({ isGeographic: true, worldOriginY: null }));
    expect(spy).toHaveBeenCalledTimes(0);
    runLabFlowPulse(input());
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('the conditioning control', () => {
  it('defaults to raw — an unspecified second argument matches the prior single-argument call', () => {
    const withDefault = runLabFlowPulse(input());
    const explicitRaw = runLabFlowPulse(input(), 'raw');
    expect(withDefault.ok).toBe(true);
    expect(explicitRaw.ok).toBe(true);
    if (!withDefault.ok || !explicitRaw.ok) return;
    expect(withDefault.record.parameters.conditioning).toBe('raw');
    expect(withDefault.record.digest).toBe(explicitRaw.record.digest);
  });

  it('names the method actually used: raw omits Priority-Flood, conditioned includes it', () => {
    const raw = runLabFlowPulse(input(), 'raw');
    const conditioned = runLabFlowPulse(input(), 'priority-flood');
    expect(raw.ok).toBe(true);
    expect(conditioned.ok).toBe(true);
    if (!raw.ok || !conditioned.ok) return;
    expect(raw.record.methods.some((m) => m.includes('priority-flood'))).toBe(false);
    expect(conditioned.record.methods.some((m) => m.includes('priority-flood'))).toBe(true);
    expect(conditioned.record.parameters.conditioning).toBe('priority-flood');
  });

  it('shows the run record\'s own methods in the rendered card', () => {
    const outcome = runLabFlowPulse(input(), 'priority-flood');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const text = textOf(renderFlowPulseLab(outcome));
    for (const method of outcome.record.methods) expect(text).toContain(method);
  });
});
