/**
 * profileProvenance.test.ts
 *
 * The four rules the provenance record exists to hold, and the mutations each
 * one is there to catch:
 *
 *   1. counts, never points   — the record's size does not grow with the cloud;
 *   2. ids, never names       — identity survives a rename;
 *   3. no clock               — the same input serialises to the same bytes;
 *   4. additive on the schema — a session that predates the record still loads.
 *
 * Plus the two claims a provenance record is most tempting to overstate:
 * that classification was available everywhere, and that a resident-only read
 * saw the whole source.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  buildProfileProvenance,
  serializeProfileProvenance,
  profileProvenanceIdentity,
  describeProfileProvenance,
  PROFILE_PROVENANCE_VERSION,
  PROFILE_METHOD_CORRIDOR_PERCENTILE,
  PROFILE_CORRIDOR_VERSION,
  type ProfileProvenanceInput,
  type ProfileProvenanceSourceInput,
  type ProfileUnitContext,
} from '../src/render/measure/profileProvenance';
import { buildProfileFrame } from '../src/render/measure/profileGeometry';
import {
  serializeSession,
  parseSession,
  SESSION_VERSION,
  MAX_PROVENANCE_SOURCES,
} from '../src/io/session';
import type { Measurement } from '../src/render/measure/types';

const AT = '2026-08-23T09:15:00.000Z';

const UNITS: ProfileUnitContext = {
  linearUnit: 'metre',
  verticalReference: 'orthometric',
  verticalMetresPerUnit: 1,
};

function source(over: Partial<ProfileProvenanceSourceInput> = {}): ProfileProvenanceSourceInput {
  return {
    slot: 0,
    layerId: 'layer-alpha-9f2c',
    displayName: 'North scarp 2019',
    classification: 'producer',
    streaming: false,
    ...over,
  };
}

/** `n` accepted returns, spread across `slots` round-robin. */
function accepted(n: number, slots: readonly number[] = [0]): {
  count: number;
  sourceSlot: Uint16Array;
} {
  const sourceSlot = new Uint16Array(n);
  for (let i = 0; i < n; i++) sourceSlot[i] = slots[i % slots.length]!;
  return { count: n, sourceSlot };
}

function input(over: Partial<ProfileProvenanceInput> = {}): ProfileProvenanceInput {
  return {
    capturedAt: AT,
    up: [0, 0, 1],
    sources: [source()],
    accepted: accepted(10),
    excludedClasses: [3, 4, 5, 6, 7, 18],
    units: UNITS,
    ...over,
  };
}

describe('the record answers what shaped the sample', () => {
  it('names the method, the corridor version and the normalised up', () => {
    const rec = buildProfileProvenance(input({ up: [0, 0, 7] }));
    expect(rec.recordVersion).toBe(PROFILE_PROVENANCE_VERSION);
    expect(rec.method).toBe(PROFILE_METHOD_CORRIDOR_PERCENTILE);
    expect(rec.corridorVersion).toBe(PROFILE_CORRIDOR_VERSION);
    expect(rec.up).toEqual([0, 0, 1]);
    expect(rec.upDegenerate).toBe(false);
  });

  it('normalises up exactly as the section frame does', () => {
    // The heights in the record and the heights in the sample must be measured
    // along the same axis; two normalisations would be two axes.
    for (const up of [
      [0, 0, 7],
      [1, 1, 0],
      [-3, 4, 12],
      [0, 0, 0],
    ] as const) {
      const frame = buildProfileFrame([0, 0, 0], [10, 0, 0], [up[0], up[1], up[2]]);
      const rec = buildProfileProvenance(input({ up: [up[0], up[1], up[2]] }));
      expect(rec.up).toEqual(frame.up);
    }
  });

  it('records a degenerate up as the zero vector, not as NaN', () => {
    // JSON has no NaN literal: a NaN component would persist as null and read
    // back as a different vector.
    const rec = buildProfileProvenance(input({ up: [Number.NaN, 0, 1] }));
    expect(rec.up).toEqual([0, 0, 0]);
    expect(rec.upDegenerate).toBe(true);
    expect(JSON.parse(serializeProfileProvenance(rec)).up).toEqual([0, 0, 0]);
  });

  it('carries each source with its classification kind, streaming state and share', () => {
    const rec = buildProfileProvenance(
      input({
        sources: [
          source({ slot: 0, layerId: 'a', displayName: 'A', classification: 'producer' }),
          source({ slot: 1, layerId: 'b', displayName: 'B', classification: 'derived', streaming: true }),
        ],
        accepted: accepted(9, [0, 0, 1]),
      }),
    );
    expect(rec.sources.map((s) => [s.layerId, s.classification, s.streaming, s.acceptedCount])).toEqual([
      ['a', 'producer', false, 6],
      ['b', 'derived', true, 3],
    ]);
    expect(rec.acceptedCount).toBe(9);
    expect(rec.scope).toBe('mixed-full-and-resident');
  });

  it('keeps a source that was read and contributed nothing', () => {
    const rec = buildProfileProvenance(
      input({
        sources: [source({ slot: 0, layerId: 'a' }), source({ slot: 5, layerId: 'z' })],
        accepted: accepted(4, [0]),
      }),
    );
    expect(rec.sources.map((s) => [s.layerId, s.contributed])).toEqual([
      ['a', true],
      ['z', false],
    ]);
  });

  it('refuses a source with no stable layer id', () => {
    expect(() => buildProfileProvenance(input({ sources: [source({ layerId: '' })] }))).toThrow(
      /stable layer id/,
    );
  });

  it('carries the unit and vertical-reference context, and refuses to invent a vertical scale', () => {
    const rec = buildProfileProvenance(
      input({
        units: { linearUnit: 'us-survey-foot', verticalReference: 'unknown', verticalMetresPerUnit: null },
      }),
    );
    expect(rec.units).toEqual({
      linearUnit: 'us-survey-foot',
      verticalReference: 'unknown',
      verticalMetresPerUnit: null,
    });
  });
});

// ── Rule 1: raw return arrays are never persisted ───────────────────────────

describe('rule 1 — the record holds counts and identity, never the returns', () => {
  it('serialises to the same bounded size whether ten returns were accepted or two million', () => {
    const small = buildProfileProvenance(input({ accepted: accepted(10) }));
    const huge = buildProfileProvenance(input({ accepted: accepted(2_000_000) }));

    const smallBytes = serializeProfileProvenance(small).length;
    const hugeBytes = serializeProfileProvenance(huge).length;

    expect(small.acceptedCount).toBe(10);
    expect(huge.acceptedCount).toBe(2_000_000);
    // 2e5x the returns. The record grows only by the extra digits in two counts.
    expect(hugeBytes - smallBytes).toBeLessThanOrEqual(16);
    expect(hugeBytes).toBeLessThan(1024);
  });

  it('holds no typed array and no reference to the accepted set anywhere in it', () => {
    const set = accepted(5_000);
    const rec = buildProfileProvenance(input({ accepted: set }));
    const seen: unknown[] = [];
    const walk = (v: unknown): void => {
      if (v === null || typeof v !== 'object') return;
      seen.push(v);
      for (const child of Object.values(v as Record<string, unknown>)) walk(child);
    };
    walk(rec);
    expect(seen.some((v) => ArrayBuffer.isView(v))).toBe(false);
    expect(seen.includes(set.sourceSlot)).toBe(false);
    expect(seen.includes(set)).toBe(false);
  });

  it('bounds the walk by the declared count, not by the buffer length', () => {
    // An over-allocated builder buffer must not inflate the tally.
    const over = { count: 3, sourceSlot: new Uint16Array(4096) };
    expect(buildProfileProvenance(input({ accepted: over })).acceptedCount).toBe(3);
  });
});

// ── Rule 2: stable layer ids over display names ─────────────────────────────

describe('rule 2 — identity is the stable layer id, the display name is context', () => {
  const before = buildProfileProvenance(
    input({
      sources: [
        source({ slot: 0, layerId: 'layer-alpha-9f2c', displayName: 'North scarp 2019' }),
        source({ slot: 1, layerId: 'layer-beta-41ab', displayName: 'Haul road' }),
      ],
      accepted: accepted(8, [0, 1]),
    }),
  );

  it('records both, and keys on the id', () => {
    expect(before.sources.map((s) => s.layerId)).toEqual(['layer-alpha-9f2c', 'layer-beta-41ab']);
    expect(before.sources.map((s) => s.displayName)).toEqual(['North scarp 2019', 'Haul road']);
  });

  it('survives a rename: same ids, same identity, only the name moves', () => {
    const after = buildProfileProvenance(
      input({
        sources: [
          source({ slot: 0, layerId: 'layer-alpha-9f2c', displayName: 'RENAMED by the analyst' }),
          source({ slot: 1, layerId: 'layer-beta-41ab', displayName: 'also renamed' }),
        ],
        accepted: accepted(8, [0, 1]),
      }),
    );
    expect(after.sources.map((s) => s.layerId)).toEqual(before.sources.map((s) => s.layerId));
    expect(profileProvenanceIdentity(after)).toBe(profileProvenanceIdentity(before));
    expect(after.sources[0]!.displayName).toBe('RENAMED by the analyst');
  });

  it('keeps two layers that share a display name apart', () => {
    const rec = buildProfileProvenance(
      input({
        sources: [
          source({ slot: 0, layerId: 'id-one', displayName: 'scan.laz' }),
          source({ slot: 1, layerId: 'id-two', displayName: 'scan.laz' }),
        ],
        accepted: accepted(6, [0, 1]),
      }),
    );
    expect(rec.sources).toHaveLength(2);
    expect(profileProvenanceIdentity(rec)).toBe('["id-one","id-two"]');
  });

  it('orders sources by id, so the listing order the host used never changes the bytes', () => {
    const forwards = buildProfileProvenance(
      input({
        sources: [source({ slot: 0, layerId: 'aaa' }), source({ slot: 1, layerId: 'bbb' })],
        accepted: accepted(4, [0, 1]),
      }),
    );
    const backwards = buildProfileProvenance(
      input({
        sources: [source({ slot: 1, layerId: 'bbb' }), source({ slot: 0, layerId: 'aaa' })],
        accepted: accepted(4, [0, 1]),
      }),
    );
    expect(serializeProfileProvenance(backwards)).toBe(serializeProfileProvenance(forwards));
  });
});

// ── Rule 3: byte-identical serialisation, no clock ──────────────────────────

describe('rule 3 — the same input serialises to the same bytes', () => {
  it('stamps the timestamp the caller supplied, verbatim', () => {
    const rec = buildProfileProvenance(input({ capturedAt: AT }));
    expect(rec.capturedAt).toBe(AT);
  });

  it('is byte-identical across builds separated in time', () => {
    const first = serializeProfileProvenance(buildProfileProvenance(input()));
    // Burn real wall-clock time between the two builds.
    const until = Date.now() + 5;
    while (Date.now() < until) {
      /* spin */
    }
    const second = serializeProfileProvenance(buildProfileProvenance(input()));
    expect(second).toBe(first);
  });

  it('never reads the clock or a random source inside the module', () => {
    const src = readFileSync(
      new URL('../src/render/measure/profileProvenance.ts', import.meta.url),
      'utf8',
    );
    expect(src).not.toMatch(/new Date\(/);
    expect(src).not.toMatch(/Date\.now\(/);
    expect(src).not.toMatch(/Math\.random\(/);
    expect(src).not.toMatch(/performance\.now\(/);
  });

  it('refuses to build without a caller-supplied timestamp', () => {
    expect(() =>
      buildProfileProvenance({ ...input(), capturedAt: undefined as unknown as string }),
    ).toThrow(/capturedAt/);
  });

  it('sorts and deduplicates the excluded class codes', () => {
    const a = buildProfileProvenance(input({ excludedClasses: [7, 3, 5, 3, 4, 6, 18] }));
    const b = buildProfileProvenance(input({ excludedClasses: [18, 6, 5, 4, 3, 7] }));
    expect(a.classPolicy.excludedClasses).toEqual([3, 4, 5, 6, 7, 18]);
    expect(serializeProfileProvenance(a)).toBe(serializeProfileProvenance(b));
  });
});

// ── The two claims most tempting to overstate ───────────────────────────────

describe('classification availability is stated, not assumed', () => {
  it('is true only when every contributing source carried a class channel', () => {
    const rec = buildProfileProvenance(
      input({
        sources: [
          source({ slot: 0, layerId: 'a', classification: 'producer' }),
          source({ slot: 1, layerId: 'b', classification: 'derived' }),
        ],
        accepted: accepted(6, [0, 1]),
      }),
    );
    expect(rec.classPolicy.availableOnEverySource).toBe(true);
  });

  it('is false when a contributing source carried none, policy notwithstanding', () => {
    const rec = buildProfileProvenance(
      input({
        sources: [
          source({ slot: 0, layerId: 'a', classification: 'producer' }),
          source({ slot: 1, layerId: 'b', classification: 'absent' }),
        ],
        accepted: accepted(6, [0, 1]),
        excludedClasses: [3, 4, 5],
      }),
    );
    // The policy is still recorded; what changes is the claim that it reached
    // every return.
    expect(rec.classPolicy.excludedClasses).toEqual([3, 4, 5]);
    expect(rec.classPolicy.availableOnEverySource).toBe(false);
    expect(describeProfileProvenance(rec)).toMatch(/classification missing on a source/);
  });

  it('is false over an empty read rather than vacuously true', () => {
    const rec = buildProfileProvenance(input({ accepted: accepted(0) }));
    expect(rec.scope).toBe('empty');
    expect(rec.classPolicy.availableOnEverySource).toBe(false);
  });
});

describe('a resident-only read is not a complete one', () => {
  const streamingSource = (coverage: ProfileProvenanceSourceInput['coverage']) =>
    input({
      sources: [source({ slot: 0, layerId: 'stream-a', streaming: true, coverage })],
      accepted: accepted(1_000),
    });

  it('reports resident-only with unknown coverage as unknown, never as complete', () => {
    const rec = buildProfileProvenance(
      streamingSource({ knownNodeCount: null, residentNodeCount: 40 }),
    );
    expect(rec.residentOnly).toBe(true);
    expect(rec.complete).toBe(null);
    expect(rec.complete).not.toBe(true);
    expect(describeProfileProvenance(rec)).toMatch(/Resident snapshot, coverage unknown/);
  });

  it('reports a provable gap as incomplete', () => {
    const rec = buildProfileProvenance(
      streamingSource({ knownNodeCount: 120, residentNodeCount: 40 }),
    );
    expect(rec.residentOnly).toBe(true);
    expect(rec.complete).toBe(false);
  });

  it('allows complete only when residency is actually established', () => {
    const rec = buildProfileProvenance(
      streamingSource({ knownNodeCount: 120, residentNodeCount: 120 }),
    );
    expect(rec.residentOnly).toBe(true);
    expect(rec.complete).toBe(true);
  });

  it('lets one unknown streaming source withhold the claim from a mixed read', () => {
    const rec = buildProfileProvenance(
      input({
        sources: [
          source({ slot: 0, layerId: 'static-a' }),
          source({
            slot: 1,
            layerId: 'stream-b',
            streaming: true,
            coverage: { knownNodeCount: null, residentNodeCount: 3 },
          }),
        ],
        accepted: accepted(8, [0, 1]),
      }),
    );
    expect(rec.residentOnly).toBe(false);
    expect(rec.scope).toBe('mixed-full-and-resident');
    expect(rec.complete).toBe(null);
  });

  it('calls an all-static read complete', () => {
    const rec = buildProfileProvenance(input());
    expect(rec.residentOnly).toBe(false);
    expect(rec.complete).toBe(true);
  });
});

// ── Rule 4: additive on the session schema ──────────────────────────────────

const OLD_V8_PROFILE_SESSION = JSON.stringify({
  app: 'OpenLiDARViewer',
  kind: 'measurement-session',
  version: 8,
  upAxis: 'z',
  origin: [0, 0, 0],
  unitSystem: 'metric',
  views: [],
  annotations: [],
  measurements: [
    {
      id: 'm-1',
      kind: 'profile',
      name: 'Section A',
      points: [
        [0, 0, 0],
        [10, 0, 0],
      ],
      profileChart: [
        { distance: 0, height: 1 },
        { distance: 10, height: 2 },
      ],
      profileCorridorWidth: 0.5,
      profileGroundPercentile: 25,
    },
  ],
});

/** A pre-v8 file, to show the tolerance is not specific to the current version. */
const OLD_V3_PROFILE_SESSION = JSON.stringify({
  app: 'OpenLiDARViewer',
  kind: 'measurement-session',
  version: 3,
  upAxis: 'z',
  origin: [0, 0, 0],
  unitSystem: 'metric',
  views: [],
  annotations: [],
  measurements: [
    {
      id: 'm-legacy',
      kind: 'profile',
      name: 'Legacy section',
      points: [
        [0, 0, 0],
        [4, 0, 0],
      ],
    },
  ],
});

/** Put a candidate record into a session file and read it back out. */
function sessionWith(provenance: unknown): string {
  const doc = JSON.parse(OLD_V8_PROFILE_SESSION);
  doc.measurements[0].profileProvenance = provenance;
  return JSON.stringify(doc);
}

function loadProvenance(provenance: unknown) {
  return parseSession(sessionWith(provenance)).measurements[0]!.profileProvenance;
}

describe('rule 4 — the field is additive, so an older session still loads', () => {
  it('loads a v8 profile session that carries no provenance record', () => {
    const session = parseSession(OLD_V8_PROFILE_SESSION);
    expect(session.measurements).toHaveLength(1);
    const m = session.measurements[0]!;
    expect(m.kind).toBe('profile');
    expect(m.profileChart).toHaveLength(2);
    expect(m.profileCorridorWidth).toBe(0.5);
    expect(m.profileGroundPercentile).toBe(25);
    expect(m.profileProvenance).toBeUndefined();
  });

  it('loads a pre-v8 profile session the same way', () => {
    const session = parseSession(OLD_V3_PROFILE_SESSION);
    expect(session.measurements).toHaveLength(1);
    expect(session.measurements[0]!.profileProvenance).toBeUndefined();
  });

  it('did not bump the session version to add the field', () => {
    expect(SESSION_VERSION).toBe(8);
  });

  it('leaves the byte-shape of a provenance-free session untouched', () => {
    const base = {
      upAxis: 'z' as const,
      origin: [0, 0, 0] as [number, number, number],
      unitSystem: 'metric' as const,
      views: [],
      annotations: [],
      measurements: parseSession(OLD_V8_PROFILE_SESSION).measurements,
    };
    const written = serializeSession(base);
    expect(written).not.toMatch(/profileProvenance/);
    // And it round-trips into the same document.
    expect(serializeSession({ ...base, measurements: parseSession(written).measurements })).toBe(
      written,
    );
  });

  it('round-trips a record through a session file', () => {
    const rec = buildProfileProvenance(
      input({
        sources: [
          source({ slot: 0, layerId: 'layer-alpha-9f2c', displayName: 'North scarp 2019' }),
          source({
            slot: 1,
            layerId: 'layer-beta-41ab',
            displayName: 'Haul road',
            streaming: true,
            coverage: { knownNodeCount: 40, residentNodeCount: 12 },
          }),
        ],
        accepted: accepted(30, [0, 1]),
      }),
    );
    const measurement: Measurement = {
      id: 'm-1',
      kind: 'profile',
      name: 'Section A',
      points: [
        [0, 0, 0],
        [10, 0, 0],
      ],
      profileProvenance: rec,
    };
    const text = serializeSession({
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      annotations: [],
      measurements: [measurement],
    });
    const back = parseSession(text).measurements[0]!.profileProvenance;
    expect(back).toBeDefined();
    expect(serializeProfileProvenance(back!)).toBe(serializeProfileProvenance(rec));
    expect(back!.complete).toBe(false);
    expect(back!.sources.map((s) => s.layerId)).toEqual(['layer-alpha-9f2c', 'layer-beta-41ab']);
  });

  it('reads a record only at the version the record module is on', () => {
    // The io reader mirrors PROFILE_PROVENANCE_VERSION rather than importing
    // it, so this is what pins the two together.
    const rec = JSON.parse(serializeProfileProvenance(buildProfileProvenance(input())));
    expect(rec.recordVersion).toBe(PROFILE_PROVENANCE_VERSION);
    expect(loadProvenance(rec)).toBeDefined();
    expect(loadProvenance({ ...rec, recordVersion: PROFILE_PROVENANCE_VERSION + 1 })).toBeUndefined();
  });

  it('drops a malformed record and keeps the measurement', () => {
    const good = JSON.parse(serializeProfileProvenance(buildProfileProvenance(input())));
    for (const bad of [
      null,
      42,
      'record',
      {},
      { recordVersion: PROFILE_PROVENANCE_VERSION, capturedAt: AT },
      { ...good, units: 7 },
      { ...good, up: [1, 0] },
      { ...good, capturedAt: 1234 },
      // The availability flag is the claim the record exists to bound: a file
      // that omits it must not read as "classification everywhere".
      { ...good, classPolicy: { excludedClasses: [3] } },
    ]) {
      expect(loadProvenance(bad)).toBeUndefined();
    }
    // ...and the measurement itself survives every one of them.
    expect(parseSession(sessionWith({ recordVersion: 99 })).measurements).toHaveLength(1);
  });

  it('drops a source row with no stable layer id, keeping the rest', () => {
    const good = JSON.parse(serializeProfileProvenance(buildProfileProvenance(input())));
    good.sources = [
      { ...good.sources[0], layerId: '', displayName: 'looks like a layer' },
      { ...good.sources[0], layerId: 'real-id' },
    ];
    expect(loadProvenance(good)!.sources.map((s) => s.layerId)).toEqual(['real-id']);
  });

  it('caps the sources a hostile file can carry', () => {
    const rec = JSON.parse(serializeProfileProvenance(buildProfileProvenance(input())));
    rec.sources = Array.from({ length: MAX_PROVENANCE_SOURCES * 3 }, (_, i) => ({
      layerId: `l${i}`,
      displayName: '',
      classification: 'producer',
      streaming: false,
      acceptedCount: 1,
      contributed: true,
      residency: null,
    }));
    expect(loadProvenance(rec)!.sources.length).toBe(MAX_PROVENANCE_SOURCES);
  });
});
