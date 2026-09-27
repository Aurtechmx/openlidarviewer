/**
 * observatoryStationMarkers.test.ts: the 3D station markers (OB-INV-04,
 * OB-INV-05). Observed stations get the solid glyph, suggested stations the
 * hollow dashed glyph and the shared label, an assumed origin gets a caveat
 * badge, and drawing markers never adds a station to the run record.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  buildObservedStationBuffer,
  buildSuggestedStationBuffer,
  stationMarkerSize,
  SUGGESTED_RING_SEGMENTS,
  SUGGESTED_MAST_DASHES,
} from '../src/render/observatoryStationMarkerGeometry';
import { ObservatoryStationMarkers, ASSUMED_ORIGIN_BADGE, OBSERVED_STATION_COLOR, SUGGESTED_STATION_COLOR } from '../src/render/ObservatoryStationMarkers';
import { SUGGESTED_STATION_LABEL } from '../src/observation/stationSuggestion';
import { runObservatoryOverCloud, type ObservatoryRunOutcome } from '../src/app/observatoryFromCloud';
import { wallAndGroundCloud } from './helpers/observatoryPlanningFixtures';
import { installRecordingDom } from './helpers/recordingDom';
import { readFileSync } from 'node:fs';

beforeAll(() => {
  installRecordingDom();
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = class HTMLInputElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement {};
});

function fakeHost() {
  const objects = new Set<THREE.Object3D>();
  let frames = 0;
  return {
    objects,
    get frames() { return frames; },
    add: (o: THREE.Object3D) => { objects.add(o); },
    remove: (o: THREE.Object3D) => { objects.delete(o); },
    requestFrame: () => { frames++; },
  };
}

const RUN = { voxelEdge: 0.5, declaredStepBudget: 50_000_000, filename: 'wall.ptx', metresPerUnit: 1, buildTag: 'test', planning: { candidateCap: 12 } } as const;

function run(originStatus = 'DECLARED'): Extract<ObservatoryRunOutcome, { status: 'ok' }> {
  const out = runObservatoryOverCloud(wallAndGroundCloud(originStatus), RUN);
  if (out.status !== 'ok' || !out.planning) throw new Error('test setup: the run must succeed with planning');
  return out;
}

describe('station marker geometry', () => {
  it('the observed glyph is solid: a mast, a closed diamond and both diagonals', () => {
    expect(buildObservedStationBuffer([[0, 0, 0]], 2).length).toBe((1 + 4 + 2) * 6);
  });

  it('the suggested glyph is hollow and dashed: half the ring arcs, half the mast steps, nothing through the centre', () => {
    const verts = buildSuggestedStationBuffer([[5, 5, 0]], 2);
    expect(verts.length).toBe((SUGGESTED_RING_SEGMENTS / 2 + SUGGESTED_MAST_DASHES / 2) * 6);
    // Every vertex at the station's own height lies on the ring, never at its centre.
    for (let i = 0; i < verts.length; i += 3) {
      if (verts[i + 2] === 0 && !(verts[i] === 5 && verts[i + 1] === 5)) {
        expect(Math.hypot(verts[i]! - 5, verts[i + 1]! - 5)).toBeCloseTo(1, 5);
      }
    }
  });

  it('the two glyph colours differ and marker size follows the voxel edge', () => {
    expect(OBSERVED_STATION_COLOR).not.toBe(SUGGESTED_STATION_COLOR);
    expect(stationMarkerSize(0.5)).toBe(1.5);
    expect(stationMarkerSize(0)).toBe(1);
  });
});

describe('ObservatoryStationMarkers', () => {
  it('labels suggested stations with the shared constant and assumed origins with a caveat badge', () => {
    const host = fakeHost();
    const m = new ObservatoryStationMarkers(host);
    m.show({
      observed: [{ id: 'S1', position: [0, 0, 0], assumedOrigin: false }, { id: 'S2', position: [1, 0, 0], assumedOrigin: true }],
      suggested: [{ rank: 1, position: [4, 4, 0] }],
      size: 1,
      suggestedLabel: SUGGESTED_STATION_LABEL,
    });
    const texts = m.labels().map((l) => `${l.kind}:${l.text}`);
    expect(texts).toEqual(['observed:S1', 'observed:S2', `caveat:${ASSUMED_ORIGIN_BADGE}`, `suggested:${SUGGESTED_STATION_LABEL} 1`]);
    expect(host.objects.size).toBe(1);
  });

  it('an empty input, clear and dispose all detach from the host; dispose is idempotent', () => {
    const host = fakeHost();
    const m = new ObservatoryStationMarkers(host);
    const one = { observed: [{ id: 'S1', position: [0, 0, 0] as const, assumedOrigin: false }], suggested: [], size: 1, suggestedLabel: SUGGESTED_STATION_LABEL };
    m.show(one);
    m.show({ ...one, observed: [] });
    expect(host.objects.size).toBe(0);
    m.show(one);
    m.clear();
    expect(host.objects.size).toBe(0);
    expect(m.labels()).toEqual([]);
    m.show(one);
    m.dispose();
    m.dispose();
    expect(host.objects.size).toBe(0);
    m.show(one);
    expect(host.objects.size).toBe(0);
  });
});

describe('stationMarkerInput', async () => {
  const { stationMarkerInput } = await import('../src/ui/observatory/observatoryPanel');

  it('uses record stations as observed and selected candidates as suggested, without touching record.stations', () => {
    const out = run('ASSUMED');
    const before = JSON.stringify(out.record.stations);
    const shift = (p: readonly [number, number, number]) => [p[0] - 1, p[1] - 2, p[2] - 3] as const;
    const input = stationMarkerInput(out, shift, 1);
    expect(input.observed.map((o) => o.id)).toEqual(out.record.stations.map((s) => s.id));
    expect(input.observed.every((o) => o.assumedOrigin)).toBe(true);
    expect(input.suggested.length).toBe(out.planning!.suggestion.selectedCandidateIndices.length);
    expect(input.suggested.length).toBeGreaterThan(0);
    const first = out.planning!.candidates.find((c) => c.candidateIndex === out.planning!.suggestion.selectedCandidateIndices[0])!;
    expect(input.suggested[0]!.position).toEqual([first.position[0] - 1, first.position[1] - 2, first.position[2] - 3]);
    expect(input.suggestedLabel).toBe(SUGGESTED_STATION_LABEL);
    expect(JSON.stringify(out.record.stations)).toBe(before);
    expect(out.record.stations.length).toBe(input.observed.length);
  });

  it('the panel keeps no second copy of the suggested-station label', () => {
    const src = readFileSync('src/ui/observatory/observatoryPanel.ts', 'utf8');
    expect(src).not.toContain("'SUGGESTED STATION (not observed)'");
    expect(src).toContain('planning.label');
  });
});
