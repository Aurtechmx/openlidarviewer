/**
 * artifacts.test.ts — artifact hashing is stable across machines and runs.
 *
 * The hash is the claim "this is the same scientific artifact". Two things must
 * hold or the claim is worthless: it must NOT move when only the wall clock, the
 * checkout directory or the machine name differ (otherwise no reviewer can ever
 * reproduce it), and it MUST move when a real value changes (otherwise the strip
 * has quietly eaten the data the hash is supposed to cover).
 */
import { describe, test, expect } from 'vitest';
import {
  assertHashable,
  hashArtifact,
  stripVolatile,
  AMBIGUOUS_CLOCK_KEYS,
  MAX_ARTIFACT_DEPTH,
  VOLATILE_RULES,
  VOLATILE_PLACEHOLDER,
  RAW_BYTES_NO_STRIP_REASON,
} from '../../benchmarks/framework/artifacts';
import type { ArtifactRecord } from '../../benchmarks/framework/types';

const base = {
  suiteId: 'decode',
  datasetId: 'synthetic-grid-1m',
  points: 1_000_000,
  nested: { pointsPerSecond: 12345.5, classes: [1, 2, 6] },
};

describe('hash stability', () => {
  test('the same artifact hashed twice is identical', () => {
    const a = hashArtifact('metrics', base);
    const b = hashArtifact('metrics', base);
    expect(a.hash).toBe(b.hash);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('key order does not change the hash', () => {
    const reordered = {
      nested: { classes: [1, 2, 6], pointsPerSecond: 12345.5 },
      points: 1_000_000,
      datasetId: 'synthetic-grid-1m',
      suiteId: 'decode',
    };
    expect(hashArtifact('metrics', reordered).hash).toBe(hashArtifact('metrics', base).hash);
  });

  test('two artifacts differing only in a wall-clock timestamp hash the same', () => {
    const a = { ...base, generatedAt: '2026-07-25T10:00:00.000Z', startedAt: 1 };
    const b = { ...base, generatedAt: '1999-01-01T00:00:00.000Z', startedAt: 2 };
    expect(hashArtifact('metrics', a).hash).toBe(hashArtifact('metrics', b).hash);
  });

  /**
   * The names a suite author actually reaches for. The first version of this
   * suite only exercised `generatedAt`/`startedAt`, which is why `date`, `time`,
   * `now`, `startTime`, `endTime`, `buildDate`, `runDate` and `datestamp` all
   * survived into the hash unnoticed — every one of them defeats the whole
   * reproducibility check on its own.
   *
   * The values here are EPOCH NUMBERS on purpose: a number cannot be caught by
   * the value-side ISO detector, so this isolates the key rule.
   */
  // `time`, `now`, `when` and `utc` are absent on purpose: those four are
  // ambiguous enough that the framework refuses them outright rather than
  // deciding silently. See "ambiguous clock names are rejected" below.
  const TIMESTAMP_KEYS = [
    'timestamp',
    'generatedAt',
    'createdAt',
    'updatedAt',
    'startedAt',
    'finishedAt',
    'builtAt',
    'date',
    'startTime',
    'endTime',
    'buildDate',
    'runDate',
    'datestamp',
    'mtime',
    'epochMs',
    'epoch_ms',
    'epochSec',
    'unixTime',
  ];

  test.each(TIMESTAMP_KEYS)('an epoch number under `%s` does not change the hash', (key) => {
    const a = { ...base, [key]: 1_753_459_200_000 };
    const b = { ...base, [key]: 946_684_800_000 };
    expect(hashArtifact('metrics', a).hash).toBe(hashArtifact('metrics', b).hash);
  });

  test('an ISO-8601 datetime is stripped by VALUE, whatever the field is called', () => {
    // Symmetric with the absolute-path rule: a wall-clock reading is volatile
    // because of what it IS, not because of the name someone gave the field.
    const a = { ...base, label: '2026-07-25T10:00:00.000Z' };
    const b = { ...base, label: '1999-01-01T00:00:00.000Z' };
    expect(hashArtifact('metrics', a).hash).toBe(hashArtifact('metrics', b).hash);
  });

  test('ISO-8601 with an offset, a space separator or no milliseconds is still stripped', () => {
    const variants = [
      '2026-07-25T10:00:00+02:00',
      '2026-07-25T10:00:00',
      '2026-07-25 10:00:00',
      '2026-07-25T10:00Z',
    ];
    const hashes = new Set(variants.map((v) => hashArtifact('metrics', { ...base, label: v }).hash));
    expect(hashes.size).toBe(1);
  });

  test('two artifacts differing only in an absolute path hash the same', () => {
    const a = { ...base, source: '/Users/alice/checkout/data/scan.las' };
    const b = { ...base, source: '/home/bob/ci/workspace/data/scan.las' };
    const c = { ...base, source: 'C:\\Users\\carol\\data\\scan.las' };
    expect(hashArtifact('metrics', a).hash).toBe(hashArtifact('metrics', b).hash);
    expect(hashArtifact('metrics', a).hash).toBe(hashArtifact('metrics', c).hash);
  });

  test('an absolute path nested in an array is stripped too', () => {
    const a = { ...base, inputs: ['/Users/alice/a.las', '/Users/alice/b.las'] };
    const b = { ...base, inputs: ['/srv/ci/a.las', '/srv/ci/b.las'] };
    expect(hashArtifact('metrics', a).hash).toBe(hashArtifact('metrics', b).hash);
  });

  test('the redaction keeps the BASENAME, so two different files still differ', () => {
    // Machine-specificity lives in the directory prefix, never the filename.
    // Collapsing every absolute path to one placeholder made a run over tileA
    // and a run over tileB hash identically — two different artifacts, one
    // hash, reported by the reproducibility suite as agreement.
    const a = { ...base, input: '/data/tileA.laz' };
    const b = { ...base, input: '/data/tileB.laz' };
    expect(hashArtifact('metrics', a).hash).not.toBe(hashArtifact('metrics', b).hash);
  });

  test('the same basename under different roots still hashes the same', () => {
    const a = { ...base, input: '/Users/alice/checkout/data/scan.las' };
    const b = { ...base, input: 'C:\\Users\\carol\\data\\scan.las' };
    const c = { ...base, input: 'file:///srv/ci/workspace/data/scan.las' };
    expect(hashArtifact('metrics', a).hash).toBe(hashArtifact('metrics', b).hash);
    expect(hashArtifact('metrics', a).hash).toBe(hashArtifact('metrics', c).hash);
  });

  test('two artifacts differing only in machine identity hash the same', () => {
    const a = { ...base, hostname: 'alices-mbp.local', username: 'alice', pid: 4242 };
    const b = { ...base, hostname: 'ci-runner-7', username: 'runner', pid: 9 };
    expect(hashArtifact('metrics', a).hash).toBe(hashArtifact('metrics', b).hash);
  });

  test('volatile fields buried deep in the tree are still stripped', () => {
    const a = { ...base, run: { meta: { generatedAt: 'A', hostname: 'a' }, ok: true } };
    const b = { ...base, run: { meta: { generatedAt: 'B', hostname: 'b' }, ok: true } };
    expect(hashArtifact('metrics', a).hash).toBe(hashArtifact('metrics', b).hash);
  });
});

describe('hash sensitivity — the strip is not over-broad', () => {
  test('a changed measurement changes the hash', () => {
    const changed = { ...base, nested: { ...base.nested, pointsPerSecond: 12345.6 } };
    expect(hashArtifact('metrics', changed).hash).not.toBe(hashArtifact('metrics', base).hash);
  });

  test('a changed dataset id changes the hash', () => {
    const changed = { ...base, datasetId: 'synthetic-grid-2m' };
    expect(hashArtifact('metrics', changed).hash).not.toBe(hashArtifact('metrics', base).hash);
  });

  test('a RELATIVE path survives the strip and still discriminates', () => {
    // Only ABSOLUTE paths are machine-specific. A repo-relative dataset path is
    // part of the artifact's identity and must keep affecting the hash.
    const a = { ...base, source: 'tests/fixtures/tiny.las' };
    const b = { ...base, source: 'tests/fixtures/tiny.laz' };
    expect(hashArtifact('metrics', a).hash).not.toBe(hashArtifact('metrics', b).hash);
  });

  test('a duration is NOT stripped — timings are the measurement, not noise', () => {
    const a = { ...base, durationMs: 10 };
    const b = { ...base, durationMs: 11 };
    expect(hashArtifact('metrics', a).hash).not.toBe(hashArtifact('metrics', b).hash);
  });

  test('the timing field names the framework itself emits all survive the strip', () => {
    // The widened timestamp key list must not reach the fields a benchmark
    // exists to report: if one of these were swallowed, a real regression would
    // hash identically to a clean run.
    for (const key of ['duration', 'durationMs', 'elapsedMs', 'peakMemory', 'pointsPerSecond']) {
      const a = { ...base, [key]: 10 };
      const b = { ...base, [key]: 11 };
      expect(hashArtifact('metrics', a).hash, key).not.toBe(hashArtifact('metrics', b).hash);
    }
  });

  test('the domain vocabulary survives: `epoch`, `epochs` and `times` are not clocks here', () => {
    // An epoch in this codebase is a survey campaign (alignEpochs, EpochCloud),
    // and `times` is most often an array of durations. `epoch_?(ms|s)` used to
    // swallow the plural, so an array of survey epochs vanished from the hash
    // inside the very domain this carve-out exists to protect.
    const cases: ReadonlyArray<readonly [string, unknown, unknown]> = [
      ['epoch', 1, 2],
      ['epochs', ['2019', '2021'], ['2019', '2022']],
      ['times', [1, 2], [1, 3]],
    ];
    for (const [key, left, right] of cases) {
      const a = { ...base, [key]: left };
      const b = { ...base, [key]: right };
      expect(hashArtifact('metrics', a).hash, key).not.toBe(hashArtifact('metrics', b).hash);
    }
  });

  test('the unit-suffixed epoch forms ARE still stripped', () => {
    // The tightening must not cost the forms the rule was written for.
    for (const key of ['epochMs', 'epoch_ms', 'epochSec', 'epoch_seconds']) {
      const a = { ...base, [key]: 1_753_459_200_000 };
      const b = { ...base, [key]: 946_684_800_000 };
      expect(hashArtifact('metrics', a).hash, key).toBe(hashArtifact('metrics', b).hash);
    }
  });

  test('a bare calendar date under a neutral key is NOT stripped', () => {
    // '2026-07-25' with no time is as likely to be a dataset epoch label as a
    // run timestamp, so the value rule requires a time component. A field that
    // really is a wall-clock date should be NAMED one (`date`, `buildDate`).
    const a = { ...base, epochLabel: '2026-07-25' };
    const b = { ...base, epochLabel: '2026-07-26' };
    expect(hashArtifact('metrics', a).hash).not.toBe(hashArtifact('metrics', b).hash);
  });

  test('a __proto__ key is a real own property in the canonical form', () => {
    // `out['__proto__'] = v` on a `{}` literal hits Object.prototype's setter
    // and RE-PARENTS the object instead of creating an own property, so the key
    // vanished: two different payloads and an empty object all hashed the same,
    // while the record asserted `volatilityStripped: true` with an empty
    // exclusion list. Any artifact built by JSON.parse of a sidecar, an
    // ept.json or a GeoJSON can carry this key.
    // JSON.parse is the realistic entry point and the only one that makes
    // `__proto__` a genuine own key — an object LITERAL with that key sets the
    // prototype instead, which the type guard rejects separately.
    const a = hashArtifact('metrics', JSON.parse('{"__proto__":{"secret":1}}')).hash;
    const b = hashArtifact('metrics', JSON.parse('{"__proto__":{"secret":999}}')).hash;
    const empty = hashArtifact('metrics', JSON.parse('{}')).hash;
    expect(a).not.toBe(b);
    expect(a).not.toBe(empty);
    expect(b).not.toBe(empty);
  });

  test('a __proto__ key is reported in strippedFields terms, not silently absent', () => {
    // The record must not claim a clean strip over a key that never made it in.
    const rec = hashArtifact('metrics', JSON.parse('{"__proto__":{"secret":1},"n":1}'));
    expect(rec.volatilityStripped).toBe(true);
    expect(rec.strippedFields).toEqual([]);
    // ...and the key really is in the hashed form, which is the whole point.
    expect(rec.hash).not.toBe(hashArtifact('metrics', JSON.parse('{"n":1}')).hash);
  });

  test('a hole in a sparse array normalises to null, as JSON does', () => {
    // Array.prototype.map SKIPS holes, so the undefined-to-null normalisation
    // never ran: the canonical form was `{"arr":[,,1]}`, which JSON.parse
    // rejects, and it differed from the identical document [null,null,1].
    const sparse = { arr: [, , 1] };
    const dense = { arr: [undefined, undefined, 1] };
    const explicit = { arr: [null, null, 1] };
    expect(hashArtifact('m', sparse).hash).toBe(hashArtifact('m', dense).hash);
    expect(hashArtifact('m', sparse).hash).toBe(hashArtifact('m', explicit).hash);
  });

  test('the canonical form of a sparse array is parseable JSON', () => {
    const clean = stripVolatile({ arr: [, , 1] }).value;
    expect(() => JSON.parse(JSON.stringify(clean))).not.toThrow();
    expect(clean).toEqual({ arr: [null, null, 1] });
  });

  test('array order still matters', () => {
    const a = { ...base, nested: { ...base.nested, classes: [1, 2, 6] } };
    const b = { ...base, nested: { ...base.nested, classes: [6, 2, 1] } };
    expect(hashArtifact('metrics', a).hash).not.toBe(hashArtifact('metrics', b).hash);
  });
});

describe('the strip list is auditable', () => {
  test('every rule states which category it serves and why it is excluded', () => {
    expect(VOLATILE_RULES.length).toBeGreaterThan(0);
    for (const rule of VOLATILE_RULES) {
      expect(['timestamp', 'absolute-path', 'machine-id']).toContain(rule.kind);
      expect(['key', 'value']).toContain(rule.appliesTo);
      expect(rule.why.length).toBeGreaterThan(20);
    }
  });

  test('all three required categories are covered', () => {
    const kinds = new Set(VOLATILE_RULES.map((r) => r.kind));
    expect(kinds).toEqual(new Set(['timestamp', 'absolute-path', 'machine-id']));
  });

  test('the record names exactly the fields that were stripped, sorted and dotted', () => {
    const rec = hashArtifact('metrics', {
      ...base,
      generatedAt: 'now',
      run: { hostname: 'x', file: '/Users/alice/a.las' },
    });
    expect(rec.strippedFields).toEqual(['generatedAt', 'run.file', 'run.hostname']);
    expect(rec.name).toBe('metrics');
    expect(rec.algorithm).toBe('sha256');
    expect(rec.kind).toBe('json');
  });

  test('stripVolatile removes volatile keys and redacts absolute path values', () => {
    const out = stripVolatile({ keep: 1, generatedAt: 'x', p: '/var/tmp/a.bin' }).value as Record<
      string,
      unknown
    >;
    expect(out.keep).toBe(1);
    expect('generatedAt' in out).toBe(false);
    expect(out.p).toBe(`${VOLATILE_PLACEHOLDER}/a.bin`);
  });

  test('a directory-only path redacts to the placeholder with an empty basename', () => {
    const out = stripVolatile({ p: '/var/tmp/' }).value as Record<string, unknown>;
    expect(out.p).toBe(`${VOLATILE_PLACEHOLDER}/`);
  });

  test('stripVolatile does not mutate its input', () => {
    const input = { generatedAt: 'x', keep: 1 };
    stripVolatile(input);
    expect(input).toEqual({ generatedAt: 'x', keep: 1 });
  });
});

describe('byte artifacts', () => {
  test('raw bytes hash to the published SHA-256 of the same content', () => {
    // "abc" — FIPS 180-4 test vector, so the reuse of the project digest is pinned.
    const rec = hashArtifact('blob', new Uint8Array([0x61, 0x62, 0x63]));
    expect(rec.kind).toBe('bytes');
    expect(rec.hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(rec.byteLength).toBe(3);
    expect(rec.strippedFields).toEqual([]);
  });

  test('a changed byte changes the hash', () => {
    const a = hashArtifact('blob', new Uint8Array([1, 2, 3]));
    const b = hashArtifact('blob', new Uint8Array([1, 2, 4]));
    expect(a.hash).not.toBe(b.hash);
  });

  test('the record DISCLOSES that no strip was applied, and why', () => {
    // A PNG tEXt date, a GeoTIFF tag or a zip mtime rehashes on every run, and
    // an empty `strippedFields` alone reads as "nothing volatile in here" — the
    // opposite of the truth. The caveat has to be on the record, not in a
    // source comment a report reader never sees.
    const rec = hashArtifact('raster', new Uint8Array([1, 2, 3]));
    expect(rec.volatilityStripped).toBe(false);
    expect(rec.unstrippedReason).toBe(RAW_BYTES_NO_STRIP_REASON);
    expect(rec.unstrippedReason).toMatch(/timestamp/i);
  });

  test('an ArrayBuffer is treated as bytes and carries the same disclosure', () => {
    const rec = hashArtifact('raster', new Uint8Array([1, 2, 3]).buffer);
    expect(rec.kind).toBe('bytes');
    expect(rec.volatilityStripped).toBe(false);
  });

  test('an unnamed artifact is rejected, as an unnamed metric already is', () => {
    // A record with no name cannot be found again in a report, and the three
    // other constructors (measured, unavailable, capturedEnv) all refuse it.
    expect(() => hashArtifact('', { n: 1 })).toThrow(/name/i);
    expect(() => hashArtifact('   ', new Uint8Array([1]))).toThrow(/name/i);
  });

  test('a JSON artifact claims the strip, with no reason to give', () => {
    const rec = hashArtifact('metrics', base);
    expect(rec.volatilityStripped).toBe(true);
    expect(rec.unstrippedReason).toBeUndefined();
  });

  /**
   * The disclosure must not be able to be wrong-but-valid.
   *
   * `hashArtifact` is not the only constructor — the fixture hand-builds
   * records and the suites will too — so an unexplained gap has to be a
   * COMPILE error, exactly as an unavailable metric without a reason already
   * is. These assertions fail the typecheck if the union stops enforcing it:
   * an unused `@ts-expect-error` is itself an error.
   */
  test('an unexplained or contradictory disclosure does not typecheck', () => {
    const common = {
      name: 'raster',
      kind: 'bytes',
      algorithm: 'sha256',
      hash: 'c'.repeat(64),
      fingerprint: '0badcafe',
      byteLength: 8,
      strippedFields: [],
    } as const;

    // @ts-expect-error volatilityStripped:false REQUIRES a reason
    const unexplained: ArtifactRecord = { ...common, volatilityStripped: false };

    // @ts-expect-error volatilityStripped:true forbids a reason — nothing to explain
    const contradictory: ArtifactRecord = {
      ...common,
      kind: 'json',
      volatilityStripped: true,
      unstrippedReason: 'should not be sayable',
    };

    const valid: ArtifactRecord = {
      ...common,
      volatilityStripped: false,
      unstrippedReason: RAW_BYTES_NO_STRIP_REASON,
    };

    expect(unexplained.name).toBe('raster');
    expect(contradictory.name).toBe('raster');
    expect(valid.unstrippedReason).toBe(RAW_BYTES_NO_STRIP_REASON);
  });
});

describe('ambiguous clock names are rejected instead of decided silently', () => {
  // `time`, `now`, `when` and `utc` are the four names that could equally hold a
  // measurement or a clock reading. Stripping them silently loses a duration
  // from the hash; keeping them silently defeats reproducibility. Both are the
  // framework guessing, so it refuses and asks the author to say which it is.
  test.each(AMBIGUOUS_CLOCK_KEYS)('`%s` is rejected, naming both rename targets', (key) => {
    const value = { ...base, [key]: 1 };
    expect(() => hashArtifact('metrics', value)).toThrow(new RegExp(`\\b${key}\\b`));
    expect(() => hashArtifact('metrics', value)).toThrow(/durationMs/);
    expect(() => hashArtifact('metrics', value)).toThrow(/capturedAt/);
  });

  test('the rejection reaches nested objects and array elements', () => {
    expect(() => hashArtifact('metrics', { run: { time: 1 } })).toThrow(/run\.time/);
    expect(() => hashArtifact('metrics', { runs: [{ ok: true }, { now: 1 }] })).toThrow(
      /runs\[1\]\.now/,
    );
  });

  test('a rejected name is refused whatever its value type', () => {
    // The key rule alone could not do this: the ISO detector only tests
    // strings, so a numeric epoch under `time` is invisible to it.
    for (const v of [1_753_459_200_000, '2026-07-25T10:00:00.000Z', null, [1, 2]]) {
      expect(() => hashArtifact('metrics', { time: v })).toThrow(/rename/i);
    }
  });

  test('the unambiguous neighbours are still accepted', () => {
    expect(() =>
      hashArtifact('metrics', {
        ...base,
        startTime: 1,
        endTime: 2,
        timestamp: 3,
        generatedAt: '2026-07-25T10:00:00.000Z',
        durationMs: 12.5,
        capturedAt: 4,
      }),
    ).not.toThrow();
  });

  test('a rejected name still cannot reach the hash if the guard is bypassed', () => {
    // Defence in depth: the key rule keeps these names on the strip list, so
    // `stripVolatile` used on its own still removes them.
    expect(stripVolatile({ time: 1, keep: 2 }).stripped).toEqual(['time']);
  });
});

describe('values canonicalJson cannot represent are rejected, not silently collapsed', () => {
  // Each of these hashed IDENTICALLY before the guard existed: canonicalJson
  // walks own enumerable keys, so a Date and a Map both canonicalise to `{}`
  // and every non-finite number to `null`. A real value change that leaves the
  // digest untouched is the exact failure the sensitivity requirement forbids.
  // A neutral key name, so this exercises the VALUE guard rather than the
  // ambiguous-name rule that would reject `when` before the type is examined.
  test('a Date is rejected, naming its dotted path and its type', () => {
    expect(() => hashArtifact('metrics', { run: { stamp: new Date(0) } })).toThrow(/run\.stamp/);
    expect(() => hashArtifact('metrics', { run: { stamp: new Date(0) } })).toThrow(/Date/);
  });

  test('two Dates that differ would otherwise have collided', () => {
    expect(() => hashArtifact('metrics', { stamp: new Date(0) })).toThrow(/Date/);
    expect(() => hashArtifact('metrics', { stamp: new Date(999) })).toThrow(/Date/);
  });

  test('a Date under a name the strip would have removed anyway is still rejected', () => {
    // The guard runs BEFORE the strip, so the author is told to convert it
    // rather than having the field silently disappear.
    expect(() => hashArtifact('metrics', { capturedAt: new Date(0) })).toThrow(/Date/);
  });

  test('a Map and a Set are rejected', () => {
    expect(() => hashArtifact('metrics', { m: new Map([['a', 1]]) })).toThrow(/Map/);
    expect(() => hashArtifact('metrics', { s: new Set([1, 2]) })).toThrow(/Set/);
  });

  test('NaN and Infinity are rejected — both canonicalise to null', () => {
    expect(() => hashArtifact('metrics', { x: NaN })).toThrow(/\bx\b/);
    expect(() => hashArtifact('metrics', { x: NaN })).toThrow(/finite/i);
    expect(() => hashArtifact('metrics', { x: Infinity })).toThrow(/finite/i);
    expect(() => hashArtifact('metrics', { x: -Infinity })).toThrow(/finite/i);
  });

  test('a bigint, a function and a class instance are rejected', () => {
    class Cloud {
      readonly n = 1;
    }
    expect(() => hashArtifact('metrics', { n: 1n })).toThrow(/bigint/i);
    expect(() => hashArtifact('metrics', { f: () => 1 })).toThrow(/function/i);
    expect(() => hashArtifact('metrics', { c: new Cloud() })).toThrow(/Cloud/);
  });

  test('a typed array NESTED in a JSON artifact is rejected rather than hashed as an object', () => {
    expect(() => hashArtifact('metrics', { bytes: new Uint8Array([1, 2]) })).toThrow(/Uint8Array/);
  });

  test('a reference cycle fails with the path, not a bare stack overflow', () => {
    // `report.parent = report` is a realistic accident. It used to surface as
    // `RangeError: Maximum call stack size exceeded` — no artifact, no path, in
    // a module whose other errors name `runs[1].now`.
    const report: Record<string, unknown> = { suiteId: 'decode' };
    report.parent = report;
    expect(() => hashArtifact('metrics', report)).toThrow(/reference cycle/);
    expect(() => hashArtifact('metrics', report)).toThrow(/parent/);
    expect(() => hashArtifact('metrics', report)).not.toThrow(/call stack/);
  });

  test('a cycle through an array is caught too', () => {
    const runs: unknown[] = [{ ok: true }];
    runs.push({ runs });
    expect(() => hashArtifact('metrics', { runs })).toThrow(/reference cycle/);
  });

  test('the same object appearing twice WITHOUT a cycle is not a cycle', () => {
    // A shared sub-object is legal JSON input; only an ancestor repeat is a cycle.
    const shared = { a: 1 };
    expect(() => hashArtifact('metrics', { x: shared, y: shared })).not.toThrow();
  });

  test('nesting deeper than the stated limit fails with a message, not a crash', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < MAX_ARTIFACT_DEPTH + 5; i++) deep = { n: deep };
    expect(() => hashArtifact('metrics', deep)).toThrow(/nested deeper than/);
    expect(() => hashArtifact('metrics', deep)).toThrow(String(MAX_ARTIFACT_DEPTH));
  });

  test('stripVolatile used on its own is guarded the same way', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stripVolatile(cyclic)).toThrow(/reference cycle/);
  });

  test('the error names the artifact, so a suite with ten artifacts says which one', () => {
    expect(() => hashArtifact('tile-index', { when: new Date(0) })).toThrow(/tile-index/);
  });

  test('an element inside an array is named by index', () => {
    expect(() => hashArtifact('metrics', { runs: [{ ok: true }, { at: new Date(0) }] })).toThrow(
      /runs\[1\]\.at/,
    );
  });

  test('plain objects, arrays, strings, booleans and null are all accepted', () => {
    expect(() =>
      assertHashable('metrics', { a: [1, 'x', true, null, { b: Object.create(null) }] }),
    ).not.toThrow();
  });

  test('a root-level undefined is rejected by the guard, not left to crash the hasher', () => {
    // It used to reach fnv1a and die with "Cannot read properties of undefined
    // (reading 'length')" — a stack trace instead of the one message that tells
    // the author what to do.
    expect(() => hashArtifact('metrics', undefined)).toThrow(/artifact root/);
    expect(() => hashArtifact('metrics', undefined)).toThrow(/undefined/);
    expect(() => hashArtifact('metrics', undefined)).not.toThrow(/reading 'length'/);
  });

  test('an undefined property is omitted, exactly as JSON.stringify would treat it', () => {
    // Not an error: `{ error: undefined }` is what spreading an optional field
    // produces. Dropping it is what makes the canonical form valid JSON at all
    // — canonicalJson would otherwise emit the bare token `undefined`.
    expect(hashArtifact('metrics', { a: 1, b: undefined }).hash).toBe(
      hashArtifact('metrics', { a: 1 }).hash,
    );
  });
});
