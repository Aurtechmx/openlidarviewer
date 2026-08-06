import { describe, it, expect } from 'vitest';
import { serializeSession, parseSession, SESSION_VERSION } from '../src/io/session';
import type { InspectionSession } from '../src/io/session';
import type { Vec3 } from '../src/render/measure/types';

const p = (x: number, y: number, z: number): Vec3 => [x, y, z];

function baseSession(): Omit<InspectionSession, 'app' | 'kind' | 'version'> {
  return {
    upAxis: 'z',
    origin: p(100, 200, 300),
    unitSystem: 'metric',
    views: [],
    measurements: [],
    annotations: [],
  };
}

describe('session — additive stable layerId round-trip', () => {
  it('serialises and parses the layerId and layerName (display label)', () => {
    const json = serializeSession({
      ...baseSession(),
      layerId: 'layer_abc123',
      layerName: 'North scarp',
    });
    const parsed = parseSession(json);
    expect(parsed.layerId).toBe('layer_abc123');
    expect(parsed.layerName).toBe('North scarp');
    expect(parsed.version).toBe(SESSION_VERSION);
  });

  it('preserves the id byte-for-byte across export then import', () => {
    const first = serializeSession({ ...baseSession(), layerId: 'layer_xyz' });
    const parsed = parseSession(first);
    const second = serializeSession({
      ...baseSession(),
      layerId: parsed.layerId,
      layerName: parsed.layerName,
    });
    expect(parseSession(second).layerId).toBe('layer_xyz');
  });

  it('omits the field from the JSON when no id is supplied (byte-shape preserved)', () => {
    const json = serializeSession(baseSession());
    expect(json).not.toContain('layerId');
    expect(json).not.toContain('layerName');
  });

  it('loads a current-schema session that lacks the field (backward compat)', () => {
    // A v-current session written before this field existed: same version, no
    // layerId. The loader must tolerate it and leave the field undefined so the
    // caller can assign a fresh id.
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: SESSION_VERSION,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [],
    };
    const parsed = parseSession(JSON.stringify(doc));
    expect(parsed.layerId).toBeUndefined();
    expect(parsed.layerName).toBeUndefined();
  });

  it('ignores a malformed layerId without throwing', () => {
    const doc = {
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: SESSION_VERSION,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [],
      layerId: 42,
      layerName: { not: 'a string' },
    };
    const parsed = parseSession(JSON.stringify(doc));
    expect(parsed.layerId).toBeUndefined();
    expect(parsed.layerName).toBeUndefined();
  });
});
