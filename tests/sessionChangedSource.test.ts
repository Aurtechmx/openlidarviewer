import { describe, expect, it, vi } from 'vitest';
import { loadPly } from '../src/io/loadPly';
import { fileSourceFingerprint } from '../src/io/sourceFingerprint';
import * as codec from '../src/io/session';
import { serializeActiveSession } from '../src/app/sessionSnapshot';
import { importSession, type SessionIoDeps } from '../src/app/sessionIo';
import { scanFactsFromStatic } from '../src/app/sessionScanFacts';
import { mapSessionLayers } from '../src/io/sessionOwnership';
import { buildSessionProjectFrame, carryHeldSessionWork } from '../src/io/sessionFrame';
import { fingerprintKey } from '../src/model/layerFingerprintKey';
import type { Viewer } from '../src/render/Viewer';
import type { Measurement } from '../src/render/measure/types';

async function survey(x: number) {
  const file = new File([['ply', 'format ascii 1.0', 'element vertex 3', 'property float x',
    'property float y', 'property float z', 'end_header', '0 0 0', '10 10 10', `${x} 4 4`, ''].join('\n')], 'survey.ply');
  const cloud = await loadPly(await file.arrayBuffer(), file.name);
  cloud.sourceDigest = await fileSourceFingerprint(file);
  return cloud;
}

describe('revised scan with the same filename, point count and bounds', () => {
  it('does not silently put last survey’s measurement onto the revised geometry', async () => {
    const [original, revised] = await Promise.all([survey(4), survey(7)]);
    expect(original.sourceDigest).toBeTruthy();
    expect(original.sourceDigest).not.toBe(revised.sourceDigest);
    const m: Measurement = { id: 'm1', name: 'To recorded return', kind: 'distance', points: [[0,0,0], [4,4,4]] };
    const session = serializeActiveSession(codec, {
      activeCloud: () => original,
      getViewer: () => ({ measure: { unitSystem: 'metric', getMeasurements: () => [m] },
        annotate: { getAnnotations: () => [] } }) as unknown as Viewer,
      captureViewState: () => ({}), savedViews: () => [], origin: () => original.sourceOrigin,
      analysedResult: () => null, verticalUnitToMetres: () => null, crs: () => null, layerGroups: () => [], appVersion: '0.7.1',
    });
    const loadMeasurements = vi.fn();
    const msg = vi.fn();
    const viewer = { clouds: () => ['new'], getCloud: () => revised, streamingCloud: null,
      measure: { loadMeasurements }, annotate: { loadAnnotations: vi.fn() } };
    const deps: SessionIoDeps = { viewerReady: Promise.resolve(), getViewer: () => viewer as unknown as Viewer,
      loadSession: async () => codec, getActiveScanId: () => 'new', getActiveLayerId: () => 'new',
      getActiveCloud: () => revised, exportOrigin: () => revised.sourceOrigin, appVersion: '0.7.1',
      bookmarks: { restore: vi.fn(), names: () => [] }, setInspectorViews: vi.fn(), restoreLayerGroups: vi.fn(),
      refreshMeasurePanel: vi.fn(), refreshAnnotationPanel: vi.fn(), applyViewState: vi.fn(), setCrsOverride: () => null,
      showToast: msg, setDropError: vi.fn() };
    const result = await importSession(new File([session], 'survey.olvsession'), {}, deps);
    expect({ restored: result, applied: loadMeasurements.mock.calls.length }).toEqual({ restored: false, applied: 0 });
    expect(msg.mock.calls.map(([m]) => m).join(' ')).toMatch(/content|fingerprint/i);
    const parsed = codec.parseSession(session);
    expect(codec.matchSessionToScan(parsed.scanSummary, scanFactsFromStatic(original)).verdict).toBe('strong');
  });
});

it('keeps legacy and different schemes compatible, but holds work on a changed frame layer', async () => {
  const [original, revised] = await Promise.all([survey(4), survey(7)]);
  const sourceFingerprint = fingerprintKey(scanFactsFromStatic(original));
  const input = { layerId: 'old', sourceOrigin: original.sourceOrigin, sourceFingerprint, sourceName: original.name,
    upAxis: 'y' as const, contentFingerprint: original.sourceDigest! };
  const frame = buildSessionProjectFrame({ projectOrigin: original.sourceOrigin, layers: [input] });
  const session = codec.parseSession(codec.serializeSession({ upAxis: 'y', origin: [...original.sourceOrigin],
    unitSystem: 'metric', annotations: [], measurements: [], views: [], projectFrame: frame }));
  const record = session.projectFrame!.layers[0]!;
  const live = { layerId: 'new', sourceOrigin: revised.sourceOrigin, fingerprint: sourceFingerprint, upAxis: 'y' as const };
  const kind = (d?: string) => mapSessionLayers(session.projectFrame!, [{ ...live, contentFingerprint: d }]).byId.get('old')?.kind;
  expect(record.contentFingerprint).toBe(original.sourceDigest);
  expect(kind(revised.sourceDigest!)).toBe('missing');
  expect(kind(original.sourceDigest!)).toBe('resolved');
  expect(kind()).toBe('resolved');
  expect(kind(revised.sourceDigest!.replace('olvsrc1-', 'olvsrc2-'))).toBe('resolved');
  expect(kind(revised.sourceDigest!.replace('-file:', '-copc:'))).toBe('resolved');
  const active = buildSessionProjectFrame({ projectOrigin: revised.sourceOrigin, layers: [
    { ...input, layerId: 'new', contentFingerprint: revised.sourceDigest! },
  ] });
  const carried = carryHeldSessionWork(active, { upAxis: 'y', projectOrigin: original.sourceOrigin,
    layers: [record], measurements: [], annotations: [] });
  expect(carried.frame.layers).toHaveLength(2);
});
