import { describe, it, expect } from 'vitest';
import {
  buildProfilePointDetail,
  profileDetailRow,
  type ProfileDetailRowId,
  type ProfilePointDetailOptions,
} from '../src/render/measure/profilePointDetail';
import {
  ProfileSectionBuilder,
  PROFILE_ATTRIBUTES,
  type ProfileSectionPoints,
  type ProfileSourceChannels,
} from '../src/render/measure/profileSectionBuilder';
import type { ProfileReturnsSource } from '../src/render/measure/profileReturnsCsv';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import { heightLabel, type VerticalReference } from '../src/geo/height';

// ─── fixtures ────────────────────────────────────────────────────────────────

/** A projected CRS in metres, with whatever vertical datum the case needs. */
function crsOf(vertical?: { verticalEpsg?: number; verticalDatum?: string }): ResolvedCrs {
  return {
    kind: 'projected',
    name: 'NAD83 / UTM zone 13N',
    epsg: 26913,
    linearUnit: 'metre',
    linearUnitToMetres: 1,
    source: 'las-vlr',
    confidence: 'high',
    userConfirmed: false,
    ...vertical,
  };
}

function sourceOf(over: Partial<ProfileReturnsSource> = {}): ProfileReturnsSource {
  return {
    slot: 0,
    layerId: 'layer-a',
    layerName: 'Corridor scan',
    ...over,
  };
}

const OPTS: ProfilePointDetailOptions = {
  sources: [sourceOf()],
  crs: crsOf({ verticalEpsg: 5703 }), // NAVD88 -> orthometric
  unitToMetres: 1,
};

/**
 * Build a one-source section. `channels` are the arrays the source carries;
 * anything omitted is a channel the source genuinely does not have.
 */
function sectionOf(
  channels: ProfileSourceChannels | null,
  pointCount: number,
  pushes: readonly { index: number; chainage: number; height: number; lateral: number }[],
): ProfileSectionPoints {
  const b = new ProfileSectionBuilder();
  b.beginSource(0, channels, pointCount);
  for (const p of pushes) b.push(p.index, p.chainage, p.height, p.lateral);
  return b.finish();
}

/** The single-return section used by most cases. */
function oneReturn(channels: ProfileSectionPoints | null = null): ProfileSectionPoints {
  void channels;
  return sectionOf(null, 1, [{ index: 7, chainage: 125.5, height: 1204.25, lateral: -1.5 }]);
}

const idsOf = (rows: readonly { id: ProfileDetailRowId }[]): ProfileDetailRowId[] =>
  rows.map((r) => r.id);

// ─── rule 1: absence is never zero ───────────────────────────────────────────

describe('absent channels never render as zero', () => {
  it('omits the row entirely when no source carried the channel', () => {
    const detail = buildProfilePointDetail(oneReturn(), 0, OPTS);
    expect(detail).not.toBeNull();
    const ids = idsOf(detail!.rows);
    // The section carries no attribute channel at all, so no attribute row
    // exists to be misread as a measurement of zero.
    for (const id of [
      'intensity',
      'classification',
      'classificationSource',
      'rgb',
      'returnNumber',
      'returnCount',
      'pointSourceId',
      'gpsTime',
      'normal',
    ] as const) {
      expect(ids).not.toContain(id);
    }
  });

  it('distinguishes a measured intensity of 0 from an absent intensity', () => {
    // Two sources: slot 0 carries intensity (value 0 at its point), slot 1
    // carries none. Both returns land in one section, so the section HAS an
    // intensity channel while one of its points does not.
    const b = new ProfileSectionBuilder();
    b.beginSource(0, { intensity: new Uint16Array([0]) }, 1);
    b.push(0, 10, 100, 0);
    b.beginSource(1, null, 1);
    b.push(0, 20, 101, 0);
    const points = b.finish();

    const opts: ProfilePointDetailOptions = {
      ...OPTS,
      sources: [sourceOf({ slot: 0 }), sourceOf({ slot: 1, layerId: 'layer-b', layerName: 'B' })],
    };

    const measured = profileDetailRow(buildProfilePointDetail(points, 0, opts)!, 'intensity');
    const missing = profileDetailRow(buildProfilePointDetail(points, 1, opts)!, 'intensity');

    expect(measured).toEqual({
      id: 'intensity',
      group: 'attributes',
      label: 'Intensity',
      value: '0',
      known: true,
    });
    expect(missing).toEqual({
      id: 'intensity',
      group: 'attributes',
      label: 'Intensity',
      value: null,
      known: false,
    });
    // The two must not collapse into the same rendering.
    expect(measured).not.toEqual(missing);
    expect(missing!.value).not.toBe('0');
  });

  it('marks every unbacked channel unknown rather than reading the zero-filled array', () => {
    // Slot 0 carries every channel; slot 1 carries none. The section therefore
    // emits every array, and slot 1's return sits on zeroed storage.
    const full: ProfileSourceChannels = {
      rgb: new Uint8Array([10, 20, 30]),
      intensity: new Uint16Array([1234]),
      classification: new Uint8Array([2]),
      returnNumber: new Uint8Array([1]),
      returnCount: new Uint8Array([3]),
      pointSourceId: new Uint16Array([77]),
      gpsTime: new Float64Array([123456.75]),
      normals: new Float32Array([0, 0, 1]),
    };
    const b = new ProfileSectionBuilder();
    b.beginSource(0, full, 1);
    b.push(0, 10, 100, 0);
    b.beginSource(1, null, 1);
    b.push(0, 20, 101, 0);
    const points = b.finish();

    const opts: ProfilePointDetailOptions = {
      ...OPTS,
      sources: [
        sourceOf({ slot: 0, classificationSource: 'source' }),
        sourceOf({ slot: 1, layerId: 'layer-b', layerName: 'B', classificationSource: 'source' }),
      ],
    };
    const bare = buildProfilePointDetail(points, 1, opts)!;

    const attrIds: ProfileDetailRowId[] = [
      'rgb',
      'intensity',
      'classification',
      'classificationSource',
      'returnNumber',
      'returnCount',
      'pointSourceId',
      'gpsTime',
      'normal',
    ];
    for (const id of attrIds) {
      const row = profileDetailRow(bare, id);
      expect(row, `${id} row should exist`).not.toBeNull();
      expect(row!.known, `${id} must be unknown`).toBe(false);
      expect(row!.value, `${id} must not render a value`).toBeNull();
    }

    // And the source that really carried them reads its real values.
    const rich = buildProfilePointDetail(points, 0, opts)!;
    expect(profileDetailRow(rich, 'intensity')!.value).toBe('1234');
    expect(profileDetailRow(rich, 'classification')!.value).toBe('2 (Ground)');
    expect(profileDetailRow(rich, 'classificationSource')!.value).toBe('Producer supplied');
    expect(profileDetailRow(rich, 'rgb')!.value).toBe('10, 20, 30');
    expect(profileDetailRow(rich, 'returnNumber')!.value).toBe('1');
    expect(profileDetailRow(rich, 'returnCount')!.value).toBe('3');
    expect(profileDetailRow(rich, 'pointSourceId')!.value).toBe('77');
    expect(profileDetailRow(rich, 'gpsTime')!.value).toBe('123456.750000');
    expect(profileDetailRow(rich, 'normal')!.value).toBe('0.0000, 0.0000, 1.0000');
  });

  it('never pairs a null value with a known row, or a value with an unknown row', () => {
    const b = new ProfileSectionBuilder();
    b.beginSource(0, { intensity: new Uint16Array([0]), classification: new Uint8Array([0]) }, 1);
    b.push(0, 10, 100, 0);
    b.beginSource(1, null, 1);
    b.push(0, 20, 101, 0);
    const points = b.finish();
    const opts: ProfilePointDetailOptions = {
      ...OPTS,
      sources: [sourceOf({ slot: 0 }), sourceOf({ slot: 1, layerId: 'b', layerName: 'B' })],
    };
    for (const i of [0, 1]) {
      for (const row of buildProfilePointDetail(points, i, opts)!.rows) {
        expect(row.known ? row.value !== null : row.value === null).toBe(true);
      }
    }
  });
});

// ─── rule 2: no invented LAS channels ────────────────────────────────────────

describe('only channels the source retains appear', () => {
  it('emits no scan angle, user data, scanner channel or waveform row', () => {
    const full: ProfileSourceChannels = {
      rgb: new Uint8Array([1, 2, 3]),
      intensity: new Uint16Array([9]),
      classification: new Uint8Array([5]),
      returnNumber: new Uint8Array([2]),
      returnCount: new Uint8Array([4]),
      pointSourceId: new Uint16Array([12]),
      gpsTime: new Float64Array([1.5]),
      normals: new Float32Array([1, 0, 0]),
    };
    const points = sectionOf(full, 1, [{ index: 0, chainage: 5, height: 50, lateral: 2 }]);
    const detail = buildProfilePointDetail(points, 0, {
      ...OPTS,
      sources: [sourceOf({ classificationSource: 'source', streamingNodeKey: '2-1-0-3' })],
    })!;

    const text = JSON.stringify(detail).toLowerCase();
    for (const forbidden of [
      'scanangle',
      'scan angle',
      'angle rank',
      'userdata',
      'user data',
      'scannerchannel',
      'scanner channel',
      'waveform',
      'wave packet',
      'edge of flight',
    ]) {
      expect(text, `must not mention ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('covers the section attribute set exactly, with nothing beyond it', () => {
    // Every attribute the builder can carry maps to at least one row id; no row
    // id claims an attribute the builder has no bit for.
    const attributeRowIds = new Set<string>([
      'rgb',
      'intensity',
      'classification',
      'returnNumber',
      'returnCount',
      'pointSourceId',
      'gpsTime',
      'normal',
    ]);
    expect(attributeRowIds.size).toBe(PROFILE_ATTRIBUTES.length);
    for (const a of PROFILE_ATTRIBUTES) {
      const rowId = a === 'normals' ? 'normal' : a;
      expect(attributeRowIds.has(rowId), `${a} needs a row id`).toBe(true);
    }

    const full: ProfileSourceChannels = {
      rgb: new Uint8Array([1, 2, 3]),
      intensity: new Uint16Array([9]),
      classification: new Uint8Array([5]),
      returnNumber: new Uint8Array([2]),
      returnCount: new Uint8Array([4]),
      pointSourceId: new Uint16Array([12]),
      gpsTime: new Float64Array([1.5]),
      normals: new Float32Array([1, 0, 0]),
    };
    const points = sectionOf(full, 1, [{ index: 0, chainage: 5, height: 50, lateral: 2 }]);
    const detail = buildProfilePointDetail(points, 0, {
      ...OPTS,
      sources: [sourceOf({ classificationSource: 'source' })],
    })!;
    // `classificationSource` is the one attribute-group row with no presence
    // bit: it describes the classification's origin, not a per-point channel.
    const attrRows = detail.rows.filter((r) => r.group === 'attributes');
    for (const r of attrRows) {
      expect(
        attributeRowIds.has(r.id) || r.id === 'classificationSource',
        `unexpected attribute row ${r.id}`,
      ).toBe(true);
    }
  });
});

// ─── rule 3: the height word follows the vertical reference ──────────────────

describe('height wording follows the vertical reference', () => {
  const cases: readonly { crs: ResolvedCrs | undefined; ref: VerticalReference }[] = [
    { crs: crsOf({ verticalEpsg: 5703 }), ref: 'orthometric' }, // NAVD88
    { crs: crsOf({ verticalDatum: 'EGM2008 height' }), ref: 'orthometric' },
    { crs: crsOf({ verticalEpsg: 4979 }), ref: 'ellipsoidal' },
    { crs: crsOf({ verticalEpsg: 5715 }), ref: 'depth' },
    { crs: crsOf(), ref: 'unknown' }, // projected, no vertical datum declared
    { crs: undefined, ref: 'unknown' },
  ];

  it('labels the height row from heightLabel, never re-spelled', () => {
    for (const c of cases) {
      const detail = buildProfilePointDetail(oneReturn(), 0, { ...OPTS, crs: c.crs })!;
      expect(detail.verticalReference).toBe(c.ref);
      const row = profileDetailRow(detail, 'height')!;
      expect(row.label).toBe(heightLabel(c.ref));
    }
  });

  it('says Elevation for an orthometric reference and for no other', () => {
    for (const c of cases) {
      const detail = buildProfilePointDetail(oneReturn(), 0, { ...OPTS, crs: c.crs })!;
      const label = profileDetailRow(detail, 'height')!.label;
      expect(label === 'Elevation').toBe(c.ref === 'orthometric');
    }
  });

  it('does not call an undeclared datum an elevation anywhere on the card', () => {
    // A projected CRS with no vertical datum: the world-group Z label would
    // read "Elevation"; the card must not.
    const points = sectionOf(null, 1, [{ index: 3, chainage: 1, height: 2, lateral: 0 }]);
    const detail = buildProfilePointDetail(points, 0, {
      ...OPTS,
      crs: crsOf(),
      sources: [
        sourceOf({
          readXYZ: (_i, out) => {
            out[0] = 500000;
            out[1] = 4000000;
            out[2] = 1204.25;
            return true;
          },
        }),
      ],
    })!;
    expect(detail.verticalReference).toBe('unknown');
    expect(profileDetailRow(detail, 'height')!.label).toBe('Height (datum unknown)');
    expect(profileDetailRow(detail, 'coordZ')!.label).toBe('Height (datum unknown)');
    for (const row of detail.rows) expect(row.label).not.toBe('Elevation');
  });

  it('keeps the neutral Z axis label on a local frame', () => {
    const localCrs: ResolvedCrs = {
      kind: 'local',
      name: 'Local coordinates (no CRS)',
      linearUnit: 'unknown',
      linearUnitToMetres: 1,
      source: 'default-assumption',
      confidence: 'none',
      userConfirmed: false,
    };
    const detail = buildProfilePointDetail(oneReturn(), 0, {
      ...OPTS,
      crs: localCrs,
      sources: [
        sourceOf({
          readXYZ: (_i, out) => {
            out[0] = 1;
            out[1] = 2;
            out[2] = 3;
            return true;
          },
        }),
      ],
    })!;
    expect(detail.verticalReference).toBe('local');
    expect(profileDetailRow(detail, 'height')!.label).toBe('Height (local frame)');
    expect(profileDetailRow(detail, 'coordZ')!.label).toBe('Z');
    // An unknown linear unit asserts no suffix rather than fabricating metres.
    expect(profileDetailRow(detail, 'coordX')!.value).toBe('1.000');
  });
});

// ─── classification provenance ───────────────────────────────────────────────

describe('classification provenance', () => {
  const classified = (): ProfileSectionPoints =>
    sectionOf({ classification: new Uint8Array([2]) }, 1, [
      { index: 0, chainage: 1, height: 2, lateral: 0 },
    ]);

  it('separates producer-supplied from OLV-derived', () => {
    const producer = buildProfilePointDetail(classified(), 0, {
      ...OPTS,
      sources: [sourceOf({ classificationSource: 'source' })],
    })!;
    const derived = buildProfilePointDetail(classified(), 0, {
      ...OPTS,
      sources: [sourceOf({ classificationSource: 'derived' })],
    })!;

    const p = profileDetailRow(producer, 'classificationSource')!;
    const d = profileDetailRow(derived, 'classificationSource')!;
    expect(p.value).toBe('Producer supplied');
    expect(d.value).toBe('Derived (heuristic)');
    expect(p.value).not.toBe(d.value);
    // Both classify class 2 identically; only the declared provenance differs.
    expect(profileDetailRow(producer, 'classification')!.value).toBe(
      profileDetailRow(derived, 'classification')!.value,
    );
  });

  it('emits the provenance row whenever a classification row exists', () => {
    for (const provenance of ['source', 'derived', 'none', undefined] as const) {
      const detail = buildProfilePointDetail(classified(), 0, {
        ...OPTS,
        sources: [
          provenance === undefined
            ? sourceOf()
            : sourceOf({ classificationSource: provenance }),
        ],
      })!;
      expect(profileDetailRow(detail, 'classification')).not.toBeNull();
      expect(
        profileDetailRow(detail, 'classificationSource'),
        `provenance row missing for ${String(provenance)}`,
      ).not.toBeNull();
    }
  });

  it('calls an unstated origin unknown rather than producer', () => {
    for (const provenance of ['none', undefined] as const) {
      const detail = buildProfilePointDetail(classified(), 0, {
        ...OPTS,
        sources: [
          provenance === undefined ? sourceOf() : sourceOf({ classificationSource: provenance }),
        ],
      })!;
      const row = profileDetailRow(detail, 'classificationSource')!;
      expect(row.known).toBe(false);
      expect(row.value).toBeNull();
    }
  });

  it('carries no provenance row when the section classifies nothing', () => {
    const detail = buildProfilePointDetail(oneReturn(), 0, {
      ...OPTS,
      sources: [sourceOf({ classificationSource: 'derived' })],
    })!;
    expect(profileDetailRow(detail, 'classificationSource')).toBeNull();
  });
});

// ─── placement, identity, coordinates ────────────────────────────────────────

describe('placement and identity rows', () => {
  it('orders the rows as placement, identity, coordinates, attributes', () => {
    const points = sectionOf({ intensity: new Uint16Array([5]) }, 1, [
      { index: 42, chainage: 125.5, height: 1204.25, lateral: -1.5 },
    ]);
    const detail = buildProfilePointDetail(points, 0, {
      ...OPTS,
      sources: [
        sourceOf({
          streamingNodeKey: '3-2-1-0',
          readXYZ: (_i, out) => {
            out[0] = 500000.123;
            out[1] = 4000000.456;
            out[2] = 1204.25;
            return true;
          },
        }),
      ],
    })!;
    expect(idsOf(detail.rows)).toEqual([
      'station',
      'chainage',
      'height',
      'lateralOffset',
      'layerName',
      'layerId',
      'sourcePointIndex',
      'streamingNodeKey',
      'coordX',
      'coordY',
      'coordZ',
      'intensity',
    ]);
    const groups = detail.rows.map((r) => r.group);
    expect(groups.indexOf('identity')).toBeGreaterThan(groups.lastIndexOf('section'));
    expect(groups.indexOf('coordinates')).toBeGreaterThan(groups.lastIndexOf('identity'));
    expect(groups.indexOf('attributes')).toBeGreaterThan(groups.lastIndexOf('coordinates'));
  });

  it('carries chainage, civil station, identity and CRS-aware coordinates', () => {
    const points = sectionOf(null, 1, [
      { index: 42, chainage: 125.5, height: 1204.25, lateral: -1.5 },
    ]);
    const detail = buildProfilePointDetail(points, 0, {
      ...OPTS,
      sources: [
        sourceOf({
          readXYZ: (_i, out) => {
            out[0] = 500000.123;
            out[1] = 4000000.456;
            out[2] = 1204.25;
            return true;
          },
        }),
      ],
    })!;
    expect(profileDetailRow(detail, 'station')!.value).toBe('0+125.50');
    expect(profileDetailRow(detail, 'chainage')!.value).toBe('125.500');
    expect(profileDetailRow(detail, 'layerName')!.value).toBe('Corridor scan');
    expect(profileDetailRow(detail, 'layerId')!.value).toBe('layer-a');
    expect(profileDetailRow(detail, 'sourcePointIndex')!.value).toBe('42');
    expect(detail.coordinateHeading).toBe('World (NAD83 / UTM zone 13N)');
    expect(profileDetailRow(detail, 'coordX')!.label).toBe('Easting');
    expect(profileDetailRow(detail, 'coordX')!.value).toBe('500000.123 m');
    expect(profileDetailRow(detail, 'coordY')!.label).toBe('Northing');
    expect(profileDetailRow(detail, 'coordY')!.value).toBe('4000000.456 m');
    expect(profileDetailRow(detail, 'coordZ')!.label).toBe('Elevation');
  });

  it('signs the lateral offset on both sides of the alignment', () => {
    const points = sectionOf(null, 3, [
      { index: 0, chainage: 1, height: 2, lateral: -1.5 },
      { index: 1, chainage: 1, height: 2, lateral: 2.25 },
      { index: 2, chainage: 1, height: 2, lateral: 0 },
    ]);
    const at = (i: number): string =>
      profileDetailRow(buildProfilePointDetail(points, i, OPTS)!, 'lateralOffset')!.value!;
    expect(at(0)).toBe('-1.500');
    expect(at(1)).toBe('+2.250');
    expect(at(2)).toBe('0.000');
  });

  it('omits the station row when the section unit has no known metre scale', () => {
    const detail = buildProfilePointDetail(oneReturn(), 0, {
      ...OPTS,
      unitToMetres: undefined,
    })!;
    expect(profileDetailRow(detail, 'station')).toBeNull();
    expect(profileDetailRow(detail, 'chainage')!.value).toBe('125.500');
  });

  it('shows the streaming node key only for a streaming source', () => {
    const streamed = buildProfilePointDetail(oneReturn(), 0, {
      ...OPTS,
      sources: [sourceOf({ streamingNodeKey: '4-3-2-1' })],
    })!;
    expect(profileDetailRow(streamed, 'streamingNodeKey')!.value).toBe('4-3-2-1');
    const staticLayer = buildProfilePointDetail(oneReturn(), 0, OPTS)!;
    expect(profileDetailRow(staticLayer, 'streamingNodeKey')).toBeNull();
  });

  it('omits the coordinate rows with no reader, and marks them unknown when the reader declines', () => {
    const none = buildProfilePointDetail(oneReturn(), 0, OPTS)!;
    expect(profileDetailRow(none, 'coordX')).toBeNull();

    const declined = buildProfilePointDetail(oneReturn(), 0, {
      ...OPTS,
      sources: [sourceOf({ readXYZ: () => false })],
    })!;
    for (const id of ['coordX', 'coordY', 'coordZ'] as const) {
      const row = profileDetailRow(declined, id)!;
      expect(row.known).toBe(false);
      expect(row.value).toBeNull();
    }
  });

  it('calls an unregistered slot unknown rather than inventing a layer', () => {
    const detail = buildProfilePointDetail(oneReturn(), 0, { ...OPTS, sources: [] })!;
    expect(profileDetailRow(detail, 'layerName')!.known).toBe(false);
    expect(profileDetailRow(detail, 'layerId')!.value).toBeNull();
    expect(profileDetailRow(detail, 'sourcePointIndex')!.value).toBe('7');
  });

  it('rejects an index that is not a return of this section', () => {
    const points = oneReturn();
    for (const i of [-1, 1, 1.5, Number.NaN]) {
      expect(buildProfilePointDetail(points, i, OPTS)).toBeNull();
    }
    expect(buildProfilePointDetail(points, 0, OPTS)).not.toBeNull();
  });

  it('states the vertical reference note alongside the height row', () => {
    const detail = buildProfilePointDetail(oneReturn(), 0, OPTS)!;
    expect(detail.verticalReference).toBe('orthometric');
    expect(detail.verticalNote).toContain('mean sea level');
  });
});
