import { describe, it, expect, vi } from 'vitest';
import {
  beginReturnsSection,
  exportProfileReturns,
  finishReturnsSection,
  ProfileReturnsRefusal,
  type ProfileReturnsPorts,
  type ProfileReturnsRequest,
} from '../src/app/profileReturnsExport';
import { prepareWorkbenchSection, sectionOnDatum } from '../src/app/profileWorkbenchSection';
import {
  createProfileSectionSeam,
  type ProfileSeamLayer,
  type ProfileSeamResidentNode,
  type ProfileSectionSeamDeps,
} from '../src/render/measure/profileSectionSeam';
import { GEOGRAPHIC_CRS_MEASURE_NOTICE } from '../src/render/measure/format';
import { buildZip, crc32, zipStoreParts } from '../src/convert/zipStore';
import type { PointCloud } from '../src/model/PointCloud';

const ORIGIN = [500000.25, 4000000.5, 100] as const;

interface CloudFacts {
  name: string;
  classificationProvenance: string;
  intensity?: Uint16Array;
  pointCount: number;
  metadata: object;
}

/** One static layer along X at Y=0, plus optional streamed nodes, on a real seam. */
function rig(opts: { name?: string; nodes?: ProfileSeamResidentNode[]; points?: number } = {}) {
  const n = opts.points ?? 11;
  const name = opts.name ?? 'survey.las';
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) positions.set([(i * 10) / (n - 1), 0.1, 1 + i * 0.25], i * 3);
  const classification = new Uint8Array(n).fill(2);
  const flags = new Uint8Array(n);
  flags[3] = 4; // Withheld
  const layer = {
    id: 'layer-1', displayName: name, positions, bounds: null,
    channels: { classification, classificationFlags: flags },
    mesh: { visible: true }, locked: false, compatibility: 'compatible', mounted: true, placement: null,
  };
  let layers: unknown[] = [layer];
  let nodes = opts.nodes ?? [];
  const deps: ProfileSectionSeamDeps = {
    layers: () => layers as ProfileSeamLayer[],
    residentNodes: () => nodes,
    streamingMayCombine: () => true,
    worldUp: () => [0, 0, 1],
    streamingCoverage: () => (nodes.length > 0 ? { residentNodes: nodes.length, totalNodes: 99 } as never : null),
    streamingSourceId: () => 'streaming:big.copc.laz',
  };
  const seam = createProfileSectionSeam(deps);
  const cloud: CloudFacts = { name, classificationProvenance: 'source', pointCount: n, metadata: {} };
  const m = { id: 'p1', kind: 'profile', name: 'Profile 1', points: [[0, 0, 0], [10, 0, 0]] };
  const summary = { id: 'p1', name: 'Profile 1', kind: 'profile', profileChart: [{}, {}], profileDatumKnown: true, value: '10 m' };
  const state = {
    measurements: [m], summaries: [summary] as unknown[], epoch: 0, corridor: 1,
    frame: { geographic: false, verticalRefused: false, verticalUnitKnown: false, verticalUnitToMetres: null, up: [0, 0, 1] },
    origin: ORIGIN as readonly [number, number, number] | null, datum: ORIGIN[2] as number | null,
    source: { crs: 'EPSG:26913 x', verticalDatum: null, scanName: 'survey' } as Record<string, unknown>,
    metres: 1 as number | null, cloud, clouds: ['v1'] as string[],
  };
  const ports = {
    measure: () => ({
      getMeasurements: () => state.measurements,
      getSummaries: () => state.summaries,
      unitFrameOf: () => state.frame,
      profileCorridorOf: () => state.corridor,
      sceneOrigin: state.origin,
      elevationDatum: state.datum,
      unitSystem: 'metric',
    }),
    source: () => state.source,
    layers: () => ({ clouds: () => state.clouds, cloud: () => state.cloud as unknown as PointCloud, stableIdFor: () => 'layer-1' }),
    classificationEpoch: () => state.epoch,
    returnReaders: () => seam.returnReaders(),
    crs: () => null,
    metresPerUnit: () => state.metres,
  } as unknown as ProfileReturnsPorts;

  const read = (during?: () => void) => {
    const before = beginReturnsSection(ports, 'p1');
    const raw = seam.section({ a: [0, 0, 0], b: [10, 0, 0], corridorWidth: 1 })!;
    during?.();
    const section = sectionOnDatum(raw, state.datum);
    const plotOf = (rawFilter?: Parameters<typeof prepareWorkbenchSection>[0]['rawFilter'], indices?: Uint32Array) =>
      prepareWorkbenchSection({
        section, ...(rawFilter ? { rawFilter } : {}), ...(indices ? { indices } : {}),
        canvas: { width: 0, height: 0, clientWidth: 0, clientHeight: 0, getContext: () => null },
      });
    return { section, plotOf, snapshot: finishReturnsSection(ports, 'p1', before, '2026-11-23T00:00:00.000Z') };
  };
  const run = async (over: Partial<ProfileReturnsRequest> = {}, got = read()) => {
    const files: { name: string; blob: Blob }[] = [];
    const saved = await exportProfileReturns(ports, {
      id: 'p1', plot: got.plotOf(), snapshot: got.snapshot,
      digestOf: async () => ({ sha256: 'ab'.repeat(32), note: null }),
      now: () => new Date('2026-11-23T01:00:00.000Z'),
      download: (blob, filename) => files.push({ name: filename, blob }),
      ...over,
    });
    return { saved, files };
  };
  return {
    state, ports, layer, read, run, setLayers: (l: unknown[]) => { layers = l; }, setNodes: (x: ProfileSeamResidentNode[]) => { nodes = x; },
  };
}

/** Entry names and texts of a store-only ZIP. */
async function unzip(blob: Blob): Promise<Map<string, string>> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const out = new Map<string, string>();
  let p = 0;
  while (view.getUint32(p, true) === 0x04034b50) {
    const size = view.getUint32(p + 18, true);
    const nameLen = view.getUint16(p + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nameLen));
    const data = bytes.subarray(p + 30 + nameLen, p + 30 + nameLen + size);
    expect(crc32(data), `${name} CRC`).toBe(view.getUint32(p + 14, true));
    out.set(name, new TextDecoder().decode(data));
    p += 30 + nameLen + size;
  }
  return out;
}

async function refusal(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(ProfileReturnsRefusal);
  return (e as Error).message;
}

const cells = (csv: string, name: string): string[] => {
  const [head, ...rows] = csv.trimEnd().split('\n').map((l) => l.split(','));
  const i = head!.indexOf(name);
  expect(i, `column ${name}`).toBeGreaterThanOrEqual(0);
  return rows.map((r) => r[i]!);
};

describe('profile returns export: the files', () => {
  it('saves the CSV and its receipt together, in source coordinates', async () => {
    const { saved, files } = await rig().run();
    expect(files.map((f) => f.name)).toEqual(['survey-profile-1-returns.zip']);
    const zip = await unzip(files[0]!.blob);
    expect([...zip.keys()]).toEqual(['survey-profile-1-returns.csv', 'survey-profile-1-returns.receipt.json']);
    const csv = zip.get('survey-profile-1-returns.csv')!;
    // Ten of eleven: the Withheld point is left out, and counted.
    expect(cells(csv, 'x')).toHaveLength(10);
    expect(cells(csv, 'x')[0]).toBe('500000.25');
    expect(cells(csv, 'z')[1]).toBe('101.25');
    expect(cells(csv, 'height')[1]).toBe('101.250');
    expect(cells(csv, 'layer_name')[0]).toBe('survey.las');
    const receipt = JSON.parse(zip.get('survey-profile-1-returns.receipt.json')!);
    expect(receipt.withheld).toEqual({ sourcePoints: 11, withheldExcluded: 1, analysedPoints: 10 });
    expect(receipt.endpoints.a).toEqual([...ORIGIN]);
    expect(receipt.sources[0]).toMatchObject({ classificationSource: 'source', basis: { sourceSha256: 'ab'.repeat(32) } });
    expect(receipt.record.provenance).toMatchObject({ software: 'OpenLiDARViewer', sourceSha256: 'ab'.repeat(32), crs: 'EPSG:26913 x' });
    expect(receipt.record.streamedPoints).toBeNull();
    expect(saved!.message).toContain('10 returns');
  });

  it('writes every return whatever the display filter and thinning draw, and states them', async () => {
    const r = rig();
    const got = r.read();
    const plot = got.plotOf({ filter: { kind: 'classes', classes: [6] } } as never, new Uint32Array([0, 1]));
    expect(plot.indices).toHaveLength(0);
    const { saved } = await r.run({ plot }, got);
    expect(saved!.receipt.acceptedCount).toBe(10);
    expect(saved!.receipt.displayedCount).toBe(0);
    expect(saved!.receipt.display).toMatchObject({ keptCount: 0 });
    expect(saved!.receipt.display!.filters.join()).toContain('6');
    const thin = await r.run({ plot: got.plotOf(undefined, new Uint32Array([0])) }, got);
    expect(thin.saved!.receipt).toMatchObject({ acceptedCount: 10, displayedCount: 1, visualLodInUse: true, display: { filters: [] } });
  });

  it('names a streamed source once, says resident points only, and blanks an evicted node', async () => {
    const nodes = [{ key: '1-0-0-0', positions: new Float32Array([5, 0, 2]), channels: null }];
    const r = rig({ nodes });
    const got = r.read();
    r.setNodes([]);
    const { saved, files } = await r.run({}, got);
    const csv = [...(await unzip(files[0]!.blob)).values()][0]!;
    expect(cells(csv, 'layer_id').at(-1)).toBe('streaming:big.copc.laz');
    expect(cells(csv, 'streaming_node_key').at(-1)).toBe('1-0-0-0');
    expect(cells(csv, 'x').at(-1)).toBe('');
    expect(saved!.receipt.coordinates).toMatchObject({ written: 10, blankEvicted: 1 });
    expect(saved!.receipt.record.streamedPoints).toMatch(/^resident points only/);
    expect(saved!.message).toContain('1 row has no coordinate');
    expect(saved!.message).toContain('resident points only');
  });

  it('blanks the coordinates of a layer closed or placed elsewhere since the section', async () => {
    const closed = rig();
    const a = closed.read();
    closed.setLayers([]);
    expect((await closed.run({}, a)).saved!.receipt.coordinates).toMatchObject({ written: 0, blankUnavailable: 10 });
    const moved = rig();
    const b = moved.read();
    moved.layer.positions = moved.layer.positions.map((v) => v + 0.5);
    expect((await moved.run({}, b)).saved!.receipt.coordinates).toMatchObject({ written: 0, blankUnmatched: 10 });
  });

  it('neutralises a layer name that would run as a formula', async () => {
    const { files } = await rig({ name: '=HYPERLINK("x")' }).run();
    const csv = [...(await unzip(files[0]!.blob)).values()][0]!;
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('makes plain file names out of hostile ones', async () => {
    const r = rig();
    r.state.source = { ...r.state.source, scanName: '../..\\evil‮' };
    r.state.summaries = [{ ...(r.state.summaries[0] as object), name: 'a/b:c'.repeat(200) }];
    const { files } = await r.run();
    const names = [files[0]!.name, ...(await unzip(files[0]!.blob)).keys()];
    for (const n of names) {
      expect(n).not.toMatch(/[\\/:‮]/);
      expect(n).toContain('-returns');
      expect(new TextEncoder().encode(n).length).toBeLessThanOrEqual(200);
    }
  });
});

describe('profile returns export: class provenance', () => {
  const sourceOf = async (set: (s: ReturnType<typeof rig>) => void, during?: (s: ReturnType<typeof rig>) => void) => {
    const r = rig();
    set(r);
    return (await r.run({}, r.read(() => during?.(r)))).saved!.receipt.sources[0]!.classificationSource;
  };
  it('follows the cloud, and names hand edits and cleared codes', async () => {
    expect(await sourceOf(() => {})).toBe('source');
    expect(await sourceOf((r) => { r.state.epoch = 2; })).toBe('edited');
    expect(await sourceOf((r) => { r.state.cloud.classificationProvenance = 'derived'; })).toBe('derived');
    expect(await sourceOf((r) => { r.state.cloud.classificationProvenance = 'cleared'; })).toBe('cleared');
  });
  it('is unknown when the codes changed while they were read, or two scans share the id', async () => {
    expect(await sourceOf(() => {}, (r) => { r.state.epoch = 1; })).toBe('unknown');
    expect(await sourceOf((r) => { r.state.clouds = ['v1', 'v2']; })).toBe('unknown');
  });
  it('keeps the provenance the section was read under when the classes are edited later', async () => {
    const r = rig();
    const got = r.read();
    r.state.epoch = 5;
    expect((await r.run({}, got)).saved!.receipt.sources[0]!.classificationSource).toBe('source');
  });
});

describe('profile returns export: refusals', () => {
  const refused = async (change: (s: ReturnType<typeof rig>) => void) => {
    const r = rig();
    const got = r.read();
    change(r);
    const download = vi.fn();
    const why = await refusal(r.run({ download }, got));
    expect(download).not.toHaveBeenCalled();
    return why;
  };
  it('refuses a geographic frame and a refused vertical with the CSV\'s own words', async () => {
    expect(await refused((r) => { r.state.frame = { ...r.state.frame, geographic: true }; })).toBe(GEOGRAPHIC_CRS_MEASURE_NOTICE);
    expect(await refused((r) => { r.state.frame = { ...r.state.frame, verticalRefused: true }; })).toMatch(/^Profile elevations/);
  });
  it('refuses a source that cannot be settled, with its reason', async () => {
    expect(await refused((r) => { r.state.source = { refused: 'Not exported: a scan is not open.' }; })).toBe('Not exported: a scan is not open.');
  });
  it('refuses when the line, the corridor, the origin, the up axis or the profile itself changed', async () => {
    const moved = /changed after this section was read/;
    expect(await refused((r) => { r.state.measurements[0]!.points[1] = [12, 0, 0]; })).toMatch(moved);
    expect(await refused((r) => { r.state.corridor = 2; })).toMatch(moved);
    expect(await refused((r) => { r.state.origin = [0, 0, 100]; })).toMatch(moved);
    expect(await refused((r) => { r.state.frame = { ...r.state.frame, up: [0, 1, 0] }; })).toMatch(/different up axis/);
    expect(await refused((r) => { r.state.summaries = []; })).toMatch(/no longer open/);
  });
  it('refuses a section the line moved under while it was read', async () => {
    const r = rig();
    const got = r.read(() => { r.state.corridor = 9; });
    expect(await refusal(r.run({}, got))).toMatch(/changed after this section was read/);
  });
  it('re-checks once the file is built, and saves nothing when the scan went meanwhile', async () => {
    const r = rig();
    const download = vi.fn();
    const why = await refusal(r.run({
      download,
      digestOf: async () => { r.state.source = { refused: 'Not exported: closed.' }; return { sha256: null, note: 'x' }; },
    }));
    expect(why).toBe('Not exported: closed.');
    expect(download).not.toHaveBeenCalled();
  });
  it('saves nothing for a dock that closed first', async () => {
    const { saved, files } = await rig().run({ cancelled: () => true });
    expect(saved).toBeNull();
    expect(files).toEqual([]);
  });
  it('refuses a section past the byte bound before building it whole', async () => {
    const r = rig({ points: 20_000 });
    const lookup = r.ports.returnReaders;
    let reads = 0;
    r.ports.returnReaders = () => (kind, id) => {
      const reader = lookup()(kind, id);
      return typeof reader === 'string' ? reader : (i, out) => { reads++; return reader(i, out); };
    };
    expect(await refusal(r.run({ maxBytes: 1_048_576 }))).toMatch(/19,999 returns would make a file over 1 MiB/);
    expect(reads).toBeLessThan(4000);
  });
  it('leaves the station column out and names no datum without a scale or a shared origin', async () => {
    const r = rig();
    r.state.metres = null;
    r.state.origin = null;
    r.state.datum = null;
    const { saved } = await r.run();
    expect(saved!.receipt.columns).not.toContain('station');
    expect(saved!.receipt.vertical).toMatchObject({ reference: 'local', column: 'height' });
    expect(saved!.receipt.coordinates.written).toBe(0);
    expect(saved!.receipt.units.metresPerUnit).toBeNull();
  });
});

describe('zipStoreParts', () => {
  it('joins to the bytes buildZip writes', () => {
    const bytes = new TextEncoder().encode('hello world');
    const whole = buildZip([{ name: 'a.txt', bytes }, { name: 'b.txt', bytes: bytes.subarray(0, 3) }]);
    const parts = zipStoreParts<Uint8Array>([
      { name: 'a.txt', size: 11, crc: () => crc32(bytes.subarray(4), crc32(bytes.subarray(0, 4))), parts: [bytes.subarray(0, 4), bytes.subarray(4)] },
      { name: 'b.txt', size: 3, crc: () => crc32(bytes.subarray(0, 3)), parts: [bytes.subarray(0, 3)] },
    ]);
    expect(Uint8Array.from(parts.flatMap((p) => [...p]))).toEqual(whole);
  });
  it('refuses an unsafe entry name', () => {
    expect(() => zipStoreParts([{ name: '../x', size: 0, crc: () => 0, parts: [] }])).toThrow(/segment/);
  });
});
