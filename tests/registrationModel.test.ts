/**
 * registrationModel.test.ts — the fail-closed registration-model selector.
 */

import { describe, it, expect } from 'vitest';
import { selectRegistrationModel, type RegistrationInputs } from '../src/registration/registrationModel';

const base: RegistrationInputs = {
  crsCompatible: false, originsKnown: false, capture: 'terrestrial', sameAreaEpochs: false,
};

describe('selectRegistrationModel', () => {
  it('proven CRS + known origins → mount (no solve)', () => {
    const d = selectRegistrationModel({ ...base, crsCompatible: true, originsKnown: true });
    expect(d.model).toBe('mount');
    expect(d.reasonCode).toBe('PROVEN_FRAME_MOUNT');
  });

  it('airborne same-area epochs → PLANAR ICP (protects the vertical change signal)', () => {
    const d = selectRegistrationModel({ ...base, capture: 'airborne', sameAreaEpochs: true });
    expect(d.model).toBe('planar-icp');
    expect(d.reasonCode).toBe('AIRBORNE_EPOCH_PLANAR');
  });

  it('a full 6-DOF fit is NOT chosen for airborne epochs — the key change-detection guard', () => {
    const d = selectRegistrationModel({ ...base, capture: 'airborne', sameAreaEpochs: true });
    expect(d.model).not.toBe('full-6dof');
  });

  it('terrestrial / object with no shared frame → full 6-DOF', () => {
    expect(selectRegistrationModel({ ...base, capture: 'terrestrial' }).model).toBe('full-6dof');
    expect(selectRegistrationModel({ ...base, capture: 'object' }).model).toBe('full-6dof');
  });

  it('refuses when overlap is known-low (mount excepted, which needs no overlap)', () => {
    const d = selectRegistrationModel({ ...base, capture: 'terrestrial', overlapEstimate: 0.05 });
    expect(d.allowed).toBe(false);
    expect(d.reasonCode).toBe('LOW_OVERLAP');
    // ...but a proven frame still mounts even with low overlap (no solve needed).
    const m = selectRegistrationModel({ ...base, crsCompatible: true, originsKnown: true, overlapEstimate: 0.05 });
    expect(m.model).toBe('mount');
  });

  it('refuses when the capture is unknown and there is no proven frame', () => {
    const d = selectRegistrationModel({ ...base, capture: 'unknown' });
    expect(d.allowed).toBe(false);
    expect(d.reasonCode).toBe('MODEL_UNDETERMINED');
  });

  it('a compatible CRS without known origins does not silently mount', () => {
    // Half a frame is not a frame: needs a solve, not a direct mount.
    const d = selectRegistrationModel({ ...base, crsCompatible: true, originsKnown: false, capture: 'terrestrial' });
    expect(d.model).toBe('full-6dof');
  });
});
