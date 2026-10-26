/**
 * projGieCorpus.test.ts
 *
 * Three test files from PROJ's own suite (OSGeo/PROJ `test/gie/`, MIT/X,
 * vendored in `tests/fixtures/proj-gie/`), read by a parser for the part of
 * the `.gie` language these files use, and run against OLV's coordinate code.
 *
 * Every case in the three files ends up in exactly one of two places:
 *
 *   - RUN: OLV claims to perform this operation, so the case goes through
 *     OLV's own code (`reprojectGlobal`, which wraps proj4js, or the unit
 *     helpers in `src/units/units.ts`) and must land inside the file's
 *     tolerance, or fail where the file expects failure.
 *   - REFUSED: the operation is outside what OLV does. Each refusal names its
 *     reason, and where OLV's own API would be asked to do it, the test checks
 *     that OLV declines rather than returning a coordinate.
 *
 * A case that matches neither list fails the coverage test at the bottom, so a
 * case cannot be skipped by omission.
 *
 * The `.gie` semantics followed here are those of PROJ's `src/apps/gie.cpp`
 * at the same commit: `tolerance` is in metres unless a unit follows it and
 * resets to 0.5 mm on every `operation` or CRS pair; `expect` compares
 * against the most recent `accept`; distance is the Euclidean distance over
 * the dimensions given.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { reprojectGlobal } from '../src/convert/reproject';
import type { GlobalPoints } from '../src/convert/globalPoints';
import { sourceToMetres, sourceUnits, degToRad, radToDeg, degrees, knownUnit, raw } from '../src/units/units';

// ─────────────────────────────────────────────────────────────────────────────
// A parser for the .gie subset these files use
// ─────────────────────────────────────────────────────────────────────────────

interface GieCase {
  readonly file: string;
  /** Line of the `expect` that closes the case. */
  readonly line: number;
  /** The `operation` text, or `crs_src -> crs_dst` for a CRS pair. */
  readonly operation: string;
  readonly crsPair?: { readonly src: string; readonly dst: string };
  readonly accept: readonly number[] | null;
  /** Expected coordinate, or `failure` (with the error name gie checks, if any). */
  readonly expect: readonly number[] | { readonly failure: string | null };
  /** Tolerance in metres. */
  readonly tolerance: number;
  readonly roundtrip?: number;
}

const VERBS = new Set(['operation', 'crs_src', 'crs_dst', 'tolerance', 'accept', 'expect', 'roundtrip']);

/** gie's `strtod_scaled` for the linear units: metres unless a unit follows. */
function toleranceMetres(args: string): number {
  const [num, unit] = args.trim().split(/\s+/);
  const v = Number(num);
  const scale: Record<string, number> = { km: 1000, m: 1, dm: 0.1, cm: 0.01, mm: 0.001, um: 1e-6, nm: 1e-9 };
  if (unit === undefined) return v;
  const s = scale[unit];
  if (s === undefined) throw new Error(`unsupported tolerance unit "${unit}"`);
  return v * s;
}

function numbers(args: string): number[] {
  return args.trim().split(/\s+/).map(Number);
}

function parseGie(file: string, text: string): GieCase[] {
  // Commands: a verb at the start of a line; an indented line continues the
  // previous command; `#` comments run to the end of the line; a trailing
  // backslash is a continuation marker. Only text inside <gie-strict> counts.
  const commands: Array<{ verb: string; args: string; line: number }> = [];
  let inside = false;
  text.split('\n').forEach((rawLine, index) => {
    const line = rawLine.replace(/#.*$/, '').replace(/\\\s*$/, '');
    const trimmed = line.trim();
    if (trimmed === '<gie-strict>' || trimmed === '<gie>') { inside = true; return; }
    if (trimmed === '</gie-strict>' || trimmed === '</gie>') { inside = false; return; }
    if (!inside || trimmed === '') return;
    if (/^\s/.test(line)) {
      const last = commands[commands.length - 1];
      if (!last) throw new Error(`${file}:${index + 1}: continuation with no command`);
      last.args = `${last.args} ${trimmed}`;
      return;
    }
    const verb = trimmed.split(/\s+/)[0];
    if (!VERBS.has(verb)) throw new Error(`${file}:${index + 1}: unsupported gie command "${verb}"`);
    commands.push({ verb, args: trimmed.slice(verb.length).trim(), line: index + 1 });
  });

  const cases: GieCase[] = [];
  let operation = '';
  let crsSrc = '';
  let crsDst = '';
  let crsPair: { src: string; dst: string } | undefined;
  let tolerance = 0.0005;
  let accept: number[] | null = null;
  for (const c of commands) {
    switch (c.verb) {
      case 'operation':
        operation = c.args.replace(/\s+/g, ' ');
        crsPair = undefined;
        tolerance = 0.0005;
        break;
      case 'crs_src':
      case 'crs_dst':
        if (c.verb === 'crs_src') crsSrc = c.args; else crsDst = c.args;
        if (crsSrc !== '' && crsDst !== '') {
          crsPair = { src: crsSrc, dst: crsDst };
          operation = `${crsSrc} -> ${crsDst}`;
          tolerance = 0.0005;
          crsSrc = '';
          crsDst = '';
        }
        break;
      case 'tolerance':
        tolerance = toleranceMetres(c.args);
        break;
      case 'accept':
        accept = numbers(c.args);
        break;
      case 'expect': {
        const failure = /^failure\b/.test(c.args);
        cases.push({
          file,
          line: c.line,
          operation,
          ...(crsPair ? { crsPair } : {}),
          accept,
          expect: failure ? { failure: c.args.split(/\s+/)[1] ?? null } : numbers(c.args),
          tolerance,
        });
        break;
      }
      case 'roundtrip': {
        const last = cases[cases.length - 1];
        if (!last) throw new Error(`${file}:${c.line}: roundtrip before any expect`);
        cases[cases.length - 1] = { ...last, roundtrip: Number(c.args.split(/\s+/)[0]) };
        break;
      }
    }
  }
  return cases;
}

const FILES = ['axisswap.gie', 'unitconvert.gie', 'epsg_no_grid.gie'] as const;
const CASES: GieCase[] = FILES.flatMap((f) =>
  parseGie(f, readFileSync(new URL(`./fixtures/proj-gie/${f}`, import.meta.url), 'utf8')),
);

const key = (c: GieCase): string => `${c.file}:${c.line}`;
const distance = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(...a.map((v, i) => v - b[i]));

// ─────────────────────────────────────────────────────────────────────────────
// The cases OLV runs
// ─────────────────────────────────────────────────────────────────────────────

/** One point through `reprojectGlobal`, x = easting / longitude, y = northing / latitude. */
function reprojectOne(x: number, y: number, z: number, src: number, dst: number) {
  const g: GlobalPoints = { count: 1, x: Float64Array.of(x), y: Float64Array.of(y), z: Float64Array.of(z) };
  return reprojectGlobal(g, src, dst);
}

type Runner = (c: GieCase) => readonly number[] | { readonly threw: unknown };

/**
 * The cases OLV performs, by `file:line` of the closing `expect`. Each runner
 * returns OLV's output in the file's axis order, or what OLV threw.
 */
const RUN: Record<string, Runner> = {
  // ETRS89 -> ETRS89 / UTM 32N. gie feeds EPSG:4258 in its authority order,
  // latitude then longitude; reprojectGlobal takes x = longitude, so the
  // adapter swaps on the way in. EPSG:25832 is easting, northing either way.
  'epsg_no_grid.gie:16': (c) => {
    const [lat, lon] = c.accept!;
    const r = reprojectOne(lon, lat, 0, 4258, 25832);
    expect(r.transformed).toBe(true);
    return [r.points.x[0], r.points.y[0]];
  },
  // Identity in metres: OLV's source-to-metres conversion at a factor of 1.
  'unitconvert.gie:15': (c) =>
    c.accept!.map((v) => raw(sourceToMetres(sourceUnits(v), 1))),
  // Degrees to radians. gie converts angular output back to degrees before it
  // compares, which is why the file expects 1 1; OLV's radToDeg does that step.
  'unitconvert.gie:31': (c) => {
    const [x, y, z, t] = c.accept!;
    return [raw(radToDeg(degToRad(degrees(x)))), raw(radToDeg(degToRad(degrees(y)))), z, t];
  },
  // A unit factor of 0 or one that overflows to Infinity is not a unit. OLV's
  // knownUnit refuses both, which is the failure gie expects.
  'unitconvert.gie:47': () => attempt(() => knownUnit(0)),
  'unitconvert.gie:50': () => attempt(() => knownUnit(0)),
  'unitconvert.gie:53': () => attempt(() => knownUnit(Number('1e400'))),
  'unitconvert.gie:56': () => attempt(() => knownUnit(Number('1e400'))),
  'unitconvert.gie:59': () => attempt(() => knownUnit(0)),
  'unitconvert.gie:62': () => attempt(() => knownUnit(0)),
  'unitconvert.gie:65': () => attempt(() => knownUnit(Number('1e400'))),
  'unitconvert.gie:68': () => attempt(() => knownUnit(Number('1e400'))),
};

function attempt(fn: () => unknown): readonly number[] | { readonly threw: unknown } {
  try {
    fn();
  } catch (err) {
    return { threw: err };
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// The cases OLV refuses, each with its reason
// ─────────────────────────────────────────────────────────────────────────────

interface Refusal {
  readonly reason: string;
  /** Where OLV's API is asked to do it: check that it declines. */
  readonly olvDeclines?: (c: GieCase) => void;
}

const NO_AXISSWAP =
  'OLV has no axis-swap operation. reprojectGlobal fixes x as easting or longitude and y as northing or ' +
  'latitude, passes z through unchanged, and has no fourth (time) axis.';
const NO_PIPELINE = 'OLV does not run PROJ pipelines; it resolves an EPSG code to a single proj4 definition.';
const NO_NAMED_SUBUNITS =
  'OLV names three linear units (metre, international foot, US survey foot); decimetre, centimetre and ' +
  'millimetre are not among them.';
const NO_METRES_TO_FACTOR =
  'OLV converts a source unit to metres, and has no conversion from metres into an arbitrary factor unit.';
const NO_GRAD = 'OLV recognises a grad-based geographic CRS by its EPSG code but has no grad conversion.';
const TYPE_LEVEL =
  'Mixing a linear and an angular unit is prevented in OLV by its branded unit types at compile time, so there ' +
  'is no runtime call for this case to exercise.';

/** reprojectGlobal must leave the point where it was and say why. */
function declinesReprojection(src: number, dst: number, note: RegExp) {
  return (c: GieCase): void => {
    const [a, b, z = 0] = c.accept!;
    const r = reprojectOne(b, a, z, src, dst);
    expect(r.transformed).toBe(false);
    expect(r.points.x[0]).toBe(b);
    expect(r.points.y[0]).toBe(a);
    expect(r.note).toMatch(note);
  };
}

const REFUSED: Record<string, Refusal> = {
  ...Object.fromEntries(
    CASES.filter((c) => c.file === 'axisswap.gie').map((c) => [
      key(c),
      { reason: /pipeline/.test(c.operation) ? `${NO_PIPELINE} ${NO_AXISSWAP}` : NO_AXISSWAP },
    ]),
  ),
  'unitconvert.gie:10': { reason: NO_NAMED_SUBUNITS },
  'unitconvert.gie:20': { reason: NO_NAMED_SUBUNITS },
  'unitconvert.gie:26': { reason: NO_METRES_TO_FACTOR },
  'unitconvert.gie:36': { reason: NO_GRAD },
  'unitconvert.gie:40': { reason: TYPE_LEVEL },
  'unitconvert.gie:44': { reason: TYPE_LEVEL },
  // WGS 84 3D geographic to WGS 84 geocentric, both directions. The third case
  // in the file sets the same pair and, because `expect` precedes `accept`
  // there, gie compares it against the previous case's input.
  'epsg_no_grid.gie:23': {
    reason: 'Geocentric (ECEF) output needs a full 3-D transform; OLV maps horizontal x and y only and refuses it.',
    olvDeclines: declinesReprojection(4979, 4978, /cannot resolve source EPSG:4979|geocentric/),
  },
  'epsg_no_grid.gie:29': {
    reason: 'Geocentric (ECEF) output needs a full 3-D transform; OLV maps horizontal x and y only and refuses it.',
    olvDeclines: declinesReprojection(4979, 4978, /cannot resolve source EPSG:4979|geocentric/),
  },
  'epsg_no_grid.gie:41': {
    reason: 'GDA2020 to ITRF2014 is a time-dependent 15-parameter Helmert transformation; OLV has no definition for either CRS and no coordinate epoch.',
    olvDeclines: declinesReprojection(7843, 7912, /cannot resolve source EPSG:7843/),
  },
  'epsg_no_grid.gie:47': {
    reason: 'GDA2020 to ITRF2014 is a time-dependent 15-parameter Helmert transformation; OLV has no definition for either CRS and no coordinate epoch.',
    olvDeclines: declinesReprojection(7843, 7912, /cannot resolve source EPSG:7843/),
  },
  'epsg_no_grid.gie:59': {
    reason: 'The Finnish KKJ CRS (EPSG:4123) and its YKJ grid (EPSG:2393) are not in OLV\'s EPSG table.',
    olvDeclines: declinesReprojection(4123, 2393, /cannot resolve source EPSG:4123/),
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('PROJ gie corpus: the parser', () => {
  it('reads every case in the three files', () => {
    const per = Object.fromEntries(FILES.map((f) => [f, CASES.filter((c) => c.file === f).length]));
    expect(per).toEqual({ 'axisswap.gie': 19, 'unitconvert.gie': 16, 'epsg_no_grid.gie': 6 });
  });

  it('joins a continued operation and resets the tolerance per operation', () => {
    const pipeline = CASES.find((c) => c.file === 'axisswap.gie' && /order=-2,-1,3,4/.test(c.operation))!;
    expect(pipeline.operation).toBe('proj=pipeline step proj=latlong +ellps=WGS84 step proj=axisswap order=-2,-1,3,4');
    expect(pipeline.tolerance).toBeCloseTo(0.00001, 12);
    const noTolerance = CASES.find((c) => c.file === 'axisswap.gie' && c.operation === 'proj=axisswap');
    expect(noTolerance?.tolerance).toBe(0.0005);
    expect(noTolerance?.expect).toEqual({ failure: 'pjd_err_axis' });
  });

  it('reads a tolerance unit, and metres when none is given', () => {
    const utm = CASES.find((c) => c.operation === 'EPSG:4258 -> EPSG:25832')!;
    expect(utm.tolerance).toBeCloseTo(0.0001, 12);
    expect(utm.accept).toEqual([55, 12]);
    expect(utm.expect).toEqual([691875.6321, 6098907.825]);
    const plain = CASES.find((c) => c.file === 'unitconvert.gie' && c.line === 10)!;
    expect(plain.tolerance).toBe(0.1);
  });
});

describe('PROJ gie corpus: the cases OLV runs', () => {
  for (const c of CASES.filter((x) => key(x) in RUN)) {
    it(`${key(c)} ${c.operation}`, () => {
      const got = RUN[key(c)](c);
      if ('failure' in (c.expect as object)) {
        expect(got).toHaveProperty('threw');
        expect((got as { threw: unknown }).threw).toBeInstanceOf(RangeError);
        return;
      }
      const want = c.expect as readonly number[];
      expect(Array.isArray(got)).toBe(true);
      const d = distance(want, (got as readonly number[]).slice(0, want.length));
      expect(d).toBeLessThanOrEqual(c.tolerance);
    });
  }
});

describe('PROJ gie corpus: the cases OLV refuses', () => {
  for (const c of CASES.filter((x) => key(x) in REFUSED)) {
    const refusal = REFUSED[key(c)];
    it(`${key(c)} ${c.operation} is refused: ${refusal.reason}`, () => {
      expect(refusal.reason.length).toBeGreaterThan(20);
      refusal.olvDeclines?.(c);
    });
  }
});

describe('PROJ gie corpus: coverage', () => {
  it('every case is either run or refused with a reason, and none is both', () => {
    const unplaced = CASES.filter((c) => !(key(c) in RUN) && !(key(c) in REFUSED)).map(key);
    const both = CASES.filter((c) => key(c) in RUN && key(c) in REFUSED).map(key);
    const stale = [...Object.keys(RUN), ...Object.keys(REFUSED)].filter((k) => !CASES.some((c) => key(c) === k));
    expect({ unplaced, both, stale }).toEqual({ unplaced: [], both: [], stale: [] });
  });
});
