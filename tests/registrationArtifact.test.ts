/**
 * registrationArtifact.test.ts — the typed provenance record for a repeat-epoch
 * registration.
 *
 * The record wraps the alignment the solver produced with the identity of the
 * two scans, the registered method, and a staleness stamp. These cases pin that
 * it carries the transform faithfully, names the method at its version, and that
 * the one-line readout states applied / refused / not-run honestly.
 */

import { describe, it, expect } from 'vitest';
import {
  buildRegistrationArtifact,
  summarizeRegistration,
} from '../src/terrain/change/registrationArtifact';
import type { EpochAlignment } from '../src/terrain/change/alignEpochs';
import { method } from '../src/science/methodRegistry';

const scans = { targetId: 'a', targetName: '2025.laz', sourceId: 'b', sourceName: '2026.laz' };

function alignment(over: Partial<EpochAlignment> = {}): EpochAlignment {
  return {
    attempted: true,
    applied: true,
    appliedDof: 'yaw+xy',
    refused: false,
    degenerate: false,
    rmsResidualM: 0.042,
    yawDeg: 1.3,
    translation: [0.1, -0.2, 0],
    sampleCount: 5000,
    overlapFraction: 0.87,
    ...over,
  } as EpochAlignment;
}

describe('buildRegistrationArtifact', () => {
  it('carries the alignment, the scans, and the registered method at its version', () => {
    const art = buildRegistrationArtifact(alignment(), scans, 1_700_000_000_000);
    expect(art.kind).toBe('registration');
    expect(art.scans).toEqual(scans);
    expect(art.appliedDof).toBe('yaw+xy');
    expect(art.rmsResidualM).toBeCloseTo(0.042);
    expect(art.translation).toEqual([0.1, -0.2, 0]);
    expect(art.overlapFraction).toBeCloseTo(0.87);
    expect(art.generatedAt).toBe(1_700_000_000_000);
    // The method reference resolves to a real registered method.
    expect(art.method.id).toBe('olv.registration.epoch-horizontal-icp');
    expect(method(art.method.id)?.version).toBe(art.method.version);
  });
});

describe('summarizeRegistration', () => {
  it('states an applied registration with its residual, DOF and overlap', () => {
    const s = summarizeRegistration(buildRegistrationArtifact(alignment(), scans, 0));
    expect(s).toContain('applied (yaw+xy)');
    expect(s).toContain('residual 0.042 m');
    expect(s).toContain('overlap 87%');
    expect(s).toContain('olv.registration.epoch-horizontal-icp@');
  });

  it('names a refused registration without implying the transform was used', () => {
    const s = summarizeRegistration(
      buildRegistrationArtifact(
        alignment({ applied: false, refused: true, appliedDof: 'none' }),
        scans,
        0,
      ),
    );
    expect(s).toContain('refused');
    expect(s).toContain('compared unshifted');
  });

  it('names a not-run registration plainly', () => {
    const s = summarizeRegistration(
      buildRegistrationArtifact(
        alignment({ applied: false, refused: false, appliedDof: 'none' }),
        scans,
        0,
      ),
    );
    expect(s).toContain('not applied');
    expect(s).toContain('their own frames');
  });
});
