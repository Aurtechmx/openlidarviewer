/**
 * A glTF/GLB or E57 file that declares no CRS opens as local coordinates in
 * metres, declared by its format specification.
 *
 * glTF 2.0 states that all linear distances are in metres, and ASTM E2807
 * (E57) defines its Cartesian coordinates in metres. A standalone .glb with
 * no CRS opened as "CRS unknown" (kind unknown, confidence none), so a phone
 * scan lost every metric figure. It now resolves to local coordinates in
 * metres with the source 'format-specification', no georeference implied. An
 * E57 that declares coordinate metadata keeps its previous path, and the user
 * can still pick another CRS.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadGltf } from '../src/io/loadGltf';
import { loadE57 } from '../src/io/loadE57';
import { parseE57 } from '../src/io/e57/parseE57';
import { CrsService, type CrsOverridePort } from '../src/geo/CrsService';
import type { CrsOverride } from '../src/geo/CrsOverrideStore';
import { LOCAL_UNIT_NAMES } from '../src/geo/CrsOverrideStore';
import { volumeClaimRefusal } from '../src/geo/SpatialContext';
import { hasHorizontalCrs, resolveLayerUpFrame } from '../src/geo/frame/layerUpFrame';
import { hasEstablishedCrs } from '../src/convert/axisHandling';
import { crsIsKnown } from '../src/app/kmlActions';
import { parseResolvedCrs } from '../src/io/sessionCrs';
import { renderCrs } from '../src/ui/inspector/renderCrs';
import { crsText } from '../src/app/sessionLog/sessionLogRecorder';
import { buildLayerHealth, type LayerHealthInput } from '../src/app/layerHealth';
import type { CrsInfo } from '../src/io/crs';
import { READ_EVERY_RECORD, parseResult, scan } from './helpers/e57ScanFixtures';
import { FakeEl } from './support/measurePanelDom';
import { installInspectorFakeDom } from './helpers/inspectorLazyHarness';

vi.mock('../src/io/e57/parseE57', () => ({ parseE57: vi.fn() }));
const mockedParse = vi.mocked(parseE57);

const glb = (): ArrayBuffer => {
  const file = readFileSync(fileURLToPath(new URL('./fixtures/tiny.glb', import.meta.url)));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
};

function memoryPort(): CrsOverridePort {
  const entries = new Map<string, CrsOverride>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => { entries.set(key, { ...value, updatedAt: 1 }); },
    clear: (key) => { entries.delete(key); },
  };
}

function open(name: string, detected: CrsInfo | undefined): CrsService {
  const svc = new CrsService(memoryPort());
  svc.resolveForScan({ name, detected, source: 'las-vlr' });
  return svc;
}

const e57Scan = () => scan('s', 2, {
  cartesianX: Float64Array.from([10.5, 12.5]),
  cartesianY: Float64Array.from([20.5, 22.5]),
  cartesianZ: Float64Array.from([5.5, 7.5]),
});

beforeEach(() => mockedParse.mockReset());

describe('a standalone glTF/GLB with no CRS', () => {
  it('opens as local coordinates in metres from the glTF specification', async () => {
    const cloud = await loadGltf(glb(), 'glb', 'tiny.glb');
    const svc = open('tiny.glb', cloud.metadata?.crs ?? undefined);
    const crs = svc.current()!;
    expect(crs.kind).toBe('local');
    expect(crs.name).toBe(LOCAL_UNIT_NAMES.metre);
    expect(crs.linearUnit).toBe('metre');
    expect(crs.linearUnitToMetres).toBe(1);
    expect(crs.source).toBe('format-specification');
    expect(crs.formatSpecification).toBe('glTF');
    expect(crs.confidence).toBe('medium');
    expect(crs.epsg).toBeUndefined();
    expect(crs.localFrameName).toBeUndefined();
    expect(svc.context().metricClaimsPermitted).toBe(true);
  });

  it('a lasso volume states m³', async () => {
    const cloud = await loadGltf(glb(), 'glb', 'tiny.glb');
    const svc = open('tiny.glb', cloud.metadata?.crs ?? undefined);
    expect(volumeClaimRefusal(svc.context(), svc.validation())).toBeNull();
    expect(svc.validation().canSaveMeasurement).toBe(true);
  });

  it('implies no georeference: Y stays up, exports stay unplaced, KML refuses it', async () => {
    const cloud = await loadGltf(glb(), 'glb', 'tiny.glb');
    const declared = cloud.metadata!.crs!;
    expect(hasHorizontalCrs(declared)).toBe(false);
    expect(hasEstablishedCrs(declared)).toBe(false);
    expect(resolveLayerUpFrame({ format: 'glb', crs: declared })).toEqual({ ok: true, axis: 'y', basis: 'specification' });
    const resolved = open('tiny.glb', declared).current()!;
    expect(resolveLayerUpFrame({ format: 'glb', crs: resolved })).toEqual({ ok: true, axis: 'y', basis: 'specification' });
    expect(crsIsKnown(resolved)).toBe(false);
  });

  it('a picker override applies, and "Use detected" returns to the specification frame', async () => {
    const cloud = await loadGltf(glb(), 'glb', 'tiny.glb');
    const detected = cloud.metadata?.crs ?? undefined;
    const svc = open('tiny.glb', detected);
    svc.setOverride({ override: { epsg: null, kind: 'local', localUnit: 'us-survey-foot' }, detected, source: 'las-vlr' });
    expect(svc.current()!.linearUnit).toBe('us-survey-foot');
    expect(svc.current()!.source).toBe('user-override');
    svc.setOverride({ override: { epsg: null, kind: 'detected' }, detected, source: 'las-vlr' });
    expect(svc.current()!.source).toBe('format-specification');
    expect(svc.current()!.linearUnit).toBe('metre');
  });
});

describe('an E57', () => {
  it('with no CRS opens as local coordinates in metres from the E57 specification', async () => {
    mockedParse.mockReturnValue(parseResult([e57Scan()]));
    const cloud = await loadE57(new ArrayBuffer(0), 'site.e57', { plan: READ_EVERY_RECORD });
    const crs = open('site.e57', cloud.metadata?.crs ?? undefined).current()!;
    expect(crs.kind).toBe('local');
    expect(crs.linearUnit).toBe('metre');
    expect(crs.source).toBe('format-specification');
    expect(crs.formatSpecification).toBe('E57');
    const svc = open('site.e57', cloud.metadata?.crs ?? undefined);
    expect(volumeClaimRefusal(svc.context(), svc.validation())).toBeNull();
  });

  it('that declares coordinate metadata keeps its previous path', async () => {
    mockedParse.mockReturnValue({
      ...parseResult([e57Scan()]),
      sourceMetadata: { standard: [{ name: 'coordinateMetadata', value: 'PROJCS["WGS 84 / UTM zone 12N",AUTHORITY["EPSG","32612"]]' }], extensions: [] },
    });
    const cloud = await loadE57(new ArrayBuffer(0), 'site.e57', { plan: READ_EVERY_RECORD });
    expect(cloud.metadata?.crs).toBeUndefined();
    const crs = open('site.e57', cloud.metadata?.crs ?? undefined).current()!;
    expect(crs.kind).toBe('unknown');
    expect(crs.source).toBe('default-assumption');
  });
});

describe('the specification frame round-trips and is labelled', () => {
  beforeAll(() => installInspectorFakeDom());

  it('a session keeps its source', async () => {
    const cloud = await loadGltf(glb(), 'glb', 'tiny.glb');
    const resolved = open('tiny.glb', cloud.metadata?.crs ?? undefined).current()!;
    const back = parseResolvedCrs(JSON.parse(JSON.stringify(resolved)))!;
    expect(back.source).toBe('format-specification');
    expect(back.formatSpecification).toBe('glTF');
    expect(back.kind).toBe('local');
    expect(back.linearUnit).toBe('metre');
  });

  it.each([['glTF', 'Source: glTF specification (metres)'], ['E57', 'Source: E57 specification (metres)']] as const)('the Inspector names the %s specification', async (format, line) => {
    const crs = open('x', {
      source: 'format-specification', name: LOCAL_UNIT_NAMES.metre, linearUnit: 'metre', linearUnitToMetres: 1,
      isGeographic: false, localFrame: true, formatSpecification: format,
    }).current()!;
    const body = new FakeEl('div');
    renderCrs(body as unknown as HTMLElement, crs, () => {});
    expect(body.textContent).toContain(line);
    expect(body.textContent).toContain('Confidence: Medium');
  });

  it('the session log and Layer Health name the source', async () => {
    const cloud = await loadGltf(glb(), 'glb', 'tiny.glb');
    const resolved = open('tiny.glb', cloud.metadata?.crs ?? undefined).current()!;
    expect(crsText(resolved)).toBe('Local coordinates in metres (no CRS), from the glTF specification');
    const input: LayerHealthInput = {
      name: 'tiny.glb', crsName: resolved.name, crsSource: resolved.source, horizontalUnit: 'metre', verticalUnit: 'metre',
      verticalDatum: null, compatibility: 'unknown', mounted: true, sourceOrigin: [0, 0, 0], frameOffset: [0, 0, 0],
      precisionMm: 0.02, precisionBasis: 'projected-linear-unit', streaming: false, soleLayer: true,
    } as LayerHealthInput;
    const row = buildLayerHealth(input).find((r) => r.label === 'Coordinate system')!;
    expect(row.value).toBe('Local coordinates in metres (no CRS) (format specification, metres)');
  });
});
