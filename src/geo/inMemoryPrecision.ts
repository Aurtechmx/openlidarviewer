/**
 * inMemoryPrecision.ts — what the Float32 render buffer can still resolve.
 *
 * The viewer stores per-point positions as Float32 after subtracting a Float64
 * local origin (`io/coordinateBridge.ts`, `docs/coordinate-precision.md`). That
 * keeps a normal scan far inside Float32's sub-millimetre range, because the
 * residual is bounded by the cloud's own extent rather than by its absolute
 * coordinate. It does NOT make the residual free: Float32 carries a 24-bit
 * significand, so the gap between representable values grows with magnitude.
 * On a wide extent — or a layer placed far from a shared project origin — that
 * gap reaches centimetres while the source file is still millimetre-quantized.
 *
 * Before this module the figure existed nowhere. A measurement could carry more
 * error than the data does and nothing said so. This module computes it, grades
 * it against documented thresholds, and mints the permit a deliverable consults
 * before claiming a precision the representation cannot hold.
 *
 * It is a MEASUREMENT AND A POLICY, not a new precision architecture. Positions
 * stay Float32 and there is no high/low split here; the coordinate-integrity
 * roadmap asks for measured cases before adopting one, and this is how those
 * cases get measured.
 *
 * Pure — no DOM, no three.js, no proj4. Runs unchanged in Node tests.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Float32 spacing (the `Math.ulp` this language does not have)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scratch views over one 4-byte buffer. Typed arrays use the platform's byte
 * order for BOTH views, so reading `u32[0]` over the bytes `f32[0]` just wrote
 * yields that float's bit pattern on little- and big-endian alike.
 */
const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

/**
 * The distance from `magnitude` to the next representable Float32 above it —
 * the step the value will be snapped onto once it is stored in a position
 * buffer.
 *
 * Read from the IEEE-754 bit pattern rather than from `2 ** (floor(log2 m) - 23)`
 * so it is exact at every magnitude, including zero (where the answer is the
 * smallest subnormal, not a divide-by-zero) and the top of the range (where
 * incrementing the pattern overflows to infinity, so the step below is read
 * instead). The two agree on every normal magnitude, which is pinned by test
 * against the formula `PointCloud.rebaseQuantum` already uses.
 *
 * Sign is irrelevant: the exponent is set by magnitude, so −x and +x share a
 * step. A non-finite input returns NaN — there is no honest step to report for
 * a value the buffer cannot hold.
 */
export function float32Spacing(magnitude: number): number {
  const m = Math.abs(magnitude);
  if (!Number.isFinite(m)) return Number.NaN;
  F32[0] = m;
  const stored = F32[0];
  if (!Number.isFinite(stored)) return Number.NaN; // overflowed the Float32 range
  const bits = U32[0];
  U32[0] = bits + 1;
  const above = F32[0];
  if (Number.isFinite(above)) return above - stored;
  // `stored` is the largest finite Float32; report the step below it instead.
  U32[0] = bits - 1;
  return stored - F32[0];
}

/**
 * The MEAN Float32 step over coordinates spread uniformly across `[0, reach]` —
 * the "typical" figure, as opposed to the worst case at `reach` itself.
 *
 * Worth reporting because the worst case is a boundary value: the step halves
 * with every binade below `reach`, so most of a cloud sits on a finer grid than
 * its far corner does. Closed form, derived from the step function directly.
 * With `b = floor(log2 reach)` and `top = 2^(b-23)` the step at `reach`:
 *
 *   E[step] = (1/R)·[ Σ_{k<b} 2^(k-23)·2^k + top·(R − 2^b) ]
 *           = top·[ 1 − (2/3)·(2^b / R) ]
 *
 * so it runs from `top/3` when `reach` sits exactly on a power of two to
 * `2·top/3` at the far end of a binade. Verified against a direct numerical
 * integration of the real step function in the unit suite.
 *
 * `2^b` is recovered from the exact bit-read step (`top · 2^23`) rather than
 * from `Math.log2`, so the two figures can never disagree about which binade
 * `reach` is in. When that recovery does not hold — subnormal magnitudes, or a
 * `reach` that rounds up into the next binade — the worst case is returned
 * unreduced, which errs toward disclosing more error rather than less.
 */
export function meanFloat32Spacing(reach: number): number {
  const R = Math.abs(reach);
  const top = float32Spacing(R);
  if (!Number.isFinite(top) || !(R > 0)) return top;
  const binadeBase = top * 2 ** 23;
  if (!(binadeBase <= R)) return top;
  return top * (1 - (2 / 3) * (binadeBase / R));
}

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

type Vec3 = readonly [number, number, number];

/** An axis-aligned extent in SOURCE-CRS units, in absolute (file) coordinates. */
export interface SourceExtent {
  readonly min: Vec3;
  readonly max: Vec3;
}

/**
 * How the local origin subtracted from every coordinate is chosen. These are
 * the two the runtime actually uses, not a menu of possibilities:
 *
 *  - `per-cloud-floor-min` — `computeOrigin(min)` in `io/coordinateBridge.ts`,
 *    the origin every cloud is loaded on. The residual is the cloud's own
 *    extent, so a tile's absolute easting costs nothing.
 *  - `shared-origin` — an origin already chosen: a cloud's `sourceOrigin`, or
 *    the anchor a multi-scan project frame picked (`ProjectSpatialFrame`).
 *    The residual is the distance from that anchor, so a layer far from it
 *    pays for the separation as well as for its own extent.
 */
export type LocalOriginStrategy =
  | { readonly kind: 'per-cloud-floor-min' }
  | { readonly kind: 'shared-origin'; readonly origin: Vec3 };

/**
 * The source→metre factors, or the honest statement that none is established.
 *
 * Mirrors `SpatialContext`: `linearUnitKnown` is the canonical gate, and an
 * unknown-unit CRS carries the inert placeholder `linearUnitToMetres: 1`. The
 * vertical factor is separate and never borrows the horizontal one — a compound
 * CRS can be feet across and metres up, and putting a Z step through the
 * horizontal factor is how `LayerService.mountPrecision` once understated a
 * height error by 3×.
 */
export interface PrecisionUnitBasis {
  readonly linearUnitKnown: boolean;
  readonly linearUnitToMetres: number;
  readonly verticalUnitToMetres?: number;
}

export interface InMemoryPrecisionInput {
  readonly extent: SourceExtent;
  readonly strategy: LocalOriginStrategy;
  /** Omit when no CRS was established; metres are then withheld, not invented. */
  readonly unit?: PrecisionUnitBasis;
}

// ─────────────────────────────────────────────────────────────────────────────
// Outputs
// ─────────────────────────────────────────────────────────────────────────────

export type PrecisionAxis = 'x' | 'y' | 'z';

/** What one axis costs, in that axis's own source unit. */
export interface AxisPrecision {
  readonly axis: PrecisionAxis;
  /** Largest local coordinate magnitude this axis produces, source units. */
  readonly reach: number;
  /** Float32 step at `reach` — the worst case anywhere on the axis. */
  readonly worstCaseSpacing: number;
  /** Mean Float32 step over the axis, coordinates assumed uniform. */
  readonly typicalSpacing: number;
}

/** The same figures in metres. Present only when the unit is established. */
export interface PrecisionMetres {
  readonly worstCaseSpacing: number;
  readonly typicalSpacing: number;
  readonly worstCaseError: number;
  readonly typicalError: number;
}

/**
 * An ordinal grade over the worst-case step, in metres.
 *
 *  - `fine`     — at or under a millimetre. The step adds nothing to what the
 *                 source file already quantized away.
 *  - `coarse`   — over a millimetre, at or under a centimetre. The step is
 *                 above the file's own quantum and belongs on screen, but it
 *                 sits inside the accuracy class the data is specified at.
 *  - `unusable` — over a centimetre. See {@link PRECISION_GRADE_THRESHOLDS_M}.
 *  - `unknown`  — no linear unit, so the step has no length. Never a pass.
 */
export type PrecisionGrade = 'fine' | 'coarse' | 'unusable' | 'unknown';

export interface InMemoryPrecision {
  readonly strategy: LocalOriginStrategy['kind'];
  /** The local origin the strategy produced, source units. */
  readonly localOrigin: Vec3;
  readonly axes: readonly [AxisPrecision, AxisPrecision, AxisPrecision];
  /**
   * The axis that sets the reported figures. Chosen on the METRE step when the
   * unit is established, so a mixed feet/metres CRS cannot let a large number
   * in a small unit outrank a small number in a large one; on the source step
   * otherwise, which is all there is to compare.
   */
  readonly governingAxis: PrecisionAxis;
  /** The governing axis's reach — largest local magnitude, source units. */
  readonly reach: number;
  /** Governing axis, source units. */
  readonly worstCaseSpacing: number;
  readonly typicalSpacing: number;
  /** Half a step: the largest round-to-nearest error on one coordinate. */
  readonly worstCaseError: number;
  readonly typicalError: number;
  /** Metres, or `null` when the linear unit is not established. */
  readonly metres: PrecisionMetres | null;
  readonly grade: PrecisionGrade;
}

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The grade boundaries, in metres, and what each one is anchored to.
 *
 * `fine` — 1 mm. Two independent reasons land on the same number. LAS and LAZ
 * store scaled integers and the conventional scale factor is 0.001, so a source
 * file is itself millimetre-quantized: an in-memory step at or under a
 * millimetre adds no error the file did not already carry. And 1 mm is already
 * this project's stated boundary elsewhere — `REBASE_QUANTUM_BUDGET_M` in
 * `app/LayerService.ts` refuses a mount that cannot hold it, and
 * `docs/coordinate-precision.md` states the contract in the same terms.
 *
 * `coarse` — 10 mm. The tightest vertical accuracy class in the ASPRS
 * positional-accuracy standard is 1 cm RMSE. A step above that consumes the
 * entire error budget of the strictest class a dataset can be specified at,
 * before any analysis has run. It is also the resolution the measurement and
 * inspection surfaces print at (`formatLength` switches to centimetres below a
 * metre), so past it the final digit of a reported figure is quantization, not
 * data. Below it the honest response is disclosure; above it, refusal.
 *
 * Both are stated here so they can be argued with rather than hidden, the same
 * convention `terrain/quality/dtmQualityGate.ts` follows.
 */
export const PRECISION_GRADE_THRESHOLDS_M = {
  /** Worst-case step at or under this is `fine`. */
  fine: 0.001,
  /** Worst-case step at or under this is `coarse`; above it, `unusable`. */
  coarse: 0.01,
} as const;

/**
 * The default refusal budget, in metres: the largest worst-case step a
 * precision-sensitive deliverable may be minted under. Set to the `coarse`
 * ceiling, so the grade and the refusal cannot drift apart — `unusable` IS
 * "over budget". Overridable per call ({@link PrecisionPermitOptions}).
 */
export const PRECISION_BUDGET_M = PRECISION_GRADE_THRESHOLDS_M.coarse;

/**
 * Grade a worst-case step given in METRES. `null`, non-finite and negative
 * inputs are `unknown` — a grade is a statement about a length, and those are
 * not lengths.
 */
export function gradeInMemoryPrecision(worstCaseSpacingMetres: number | null): PrecisionGrade {
  if (worstCaseSpacingMetres === null) return 'unknown';
  if (!Number.isFinite(worstCaseSpacingMetres) || worstCaseSpacingMetres < 0) return 'unknown';
  if (worstCaseSpacingMetres <= PRECISION_GRADE_THRESHOLDS_M.fine) return 'fine';
  if (worstCaseSpacingMetres <= PRECISION_GRADE_THRESHOLDS_M.coarse) return 'coarse';
  return 'unusable';
}

/** Short label for a grade, for a report row or a refusal line. */
export function precisionGradeLabel(grade: PrecisionGrade): string {
  switch (grade) {
    case 'fine':
      return 'fine';
    case 'coarse':
      return 'coarse';
    case 'unusable':
      return 'unusable for precision work';
    case 'unknown':
      return 'not established';
  }
}

/**
 * Format a length in metres for a report row: sub-millimetre steps keep three
 * decimals of a millimetre, everything under a metre reads in millimetres.
 */
export function formatPrecisionMetres(metres: number): string {
  if (!Number.isFinite(metres)) return 'not established';
  if (metres < 0.001) return `${(metres * 1000).toFixed(3)} mm`;
  if (metres < 1) return `${(metres * 1000).toFixed(2)} mm`;
  return `${metres.toFixed(2)} m`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The estimate
// ─────────────────────────────────────────────────────────────────────────────

const AXIS_NAMES: readonly PrecisionAxis[] = ['x', 'y', 'z'];

/** The local origin a strategy produces for an extent. */
function originFor(extent: SourceExtent, strategy: LocalOriginStrategy): Vec3 {
  if (strategy.kind === 'shared-origin') return strategy.origin;
  return [Math.floor(extent.min[0]), Math.floor(extent.min[1]), Math.floor(extent.min[2])];
}

/**
 * Compute the in-memory quantization a cloud will carry once its coordinates
 * are recentred and narrowed to Float32.
 *
 * The reach on each axis is the largest local magnitude the strategy leaves —
 * `max(|min − origin|, |max − origin|)` — because the step is set by magnitude
 * and the far corner is where it is largest. The rest is Float32 spacing at
 * that magnitude, converted through the axis's own unit and only when that unit
 * is established.
 */
export function estimateInMemoryPrecision(input: InMemoryPrecisionInput): InMemoryPrecision {
  const { extent, strategy, unit } = input;
  const origin = originFor(extent, strategy);

  const unitKnown = unit?.linearUnitKnown === true;
  const mpu = unitKnown ? unit.linearUnitToMetres : 1;
  // The vertical factor never borrows the horizontal unit's value; it falls
  // back to it only when the CRS declared no separate vertical unit at all,
  // which is the same rule `scanReportUnitBasis` applies.
  const vmpu = unitKnown ? (unit.verticalUnitToMetres ?? mpu) : 1;
  const toMetres = [mpu, mpu, vmpu];

  const axes = AXIS_NAMES.map((axis, a): AxisPrecision => {
    const reach = Math.max(Math.abs(extent.min[a] - origin[a]), Math.abs(extent.max[a] - origin[a]));
    return {
      axis,
      reach,
      worstCaseSpacing: float32Spacing(reach),
      typicalSpacing: meanFloat32Spacing(reach),
    };
  }) as unknown as readonly [AxisPrecision, AxisPrecision, AxisPrecision];

  // Rank on the METRE step when there is one, so a large number in a small unit
  // cannot outrank a small number in a large one; on the raw step otherwise.
  let governing = 0;
  for (let a = 1; a < 3; a++) {
    const rank = unitKnown ? axes[a].worstCaseSpacing * toMetres[a] : axes[a].worstCaseSpacing;
    const best = unitKnown
      ? axes[governing].worstCaseSpacing * toMetres[governing]
      : axes[governing].worstCaseSpacing;
    if (rank > best) governing = a;
  }

  const worstCaseSpacing = axes[governing].worstCaseSpacing;
  const typicalSpacing = axes[governing].typicalSpacing;
  const scale = toMetres[governing];

  const metres: PrecisionMetres | null = unitKnown
    ? {
        worstCaseSpacing: worstCaseSpacing * scale,
        typicalSpacing: typicalSpacing * scale,
        worstCaseError: (worstCaseSpacing * scale) / 2,
        typicalError: (typicalSpacing * scale) / 2,
      }
    : null;

  return {
    strategy: strategy.kind,
    localOrigin: [origin[0], origin[1], origin[2]],
    axes,
    governingAxis: AXIS_NAMES[governing],
    reach: axes[governing].reach,
    worstCaseSpacing,
    typicalSpacing,
    worstCaseError: worstCaseSpacing / 2,
    typicalError: typicalSpacing / 2,
    metres,
    grade: gradeInMemoryPrecision(metres?.worstCaseSpacing ?? null),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The permit
// ─────────────────────────────────────────────────────────────────────────────

export interface PrecisionPermitOptions {
  /**
   * Largest worst-case step, in metres, a deliverable may be minted under.
   * Defaults to {@link PRECISION_BUDGET_M}. A value that is not a usable
   * length (non-finite, zero, negative) falls back to the default rather than
   * disabling the gate — a malformed budget must not read as "no budget".
   */
  readonly budgetMetres?: number;
}

/** A granted permit — the deliverable may be minted. */
export interface PrecisionPermitGranted {
  readonly ok: true;
  readonly precision: InMemoryPrecision;
}

/** A refused permit — the caller MUST write nothing and surface `reasons`. */
export interface PrecisionPermitRefused {
  readonly ok: false;
  readonly precision: InMemoryPrecision;
  readonly reasons: readonly string[];
}

export type PrecisionPermit = PrecisionPermitGranted | PrecisionPermitRefused;

/** The remedy every refusal carries, so the message is actionable. */
const REMEDY =
  'Tile the dataset into smaller extents, or load it as COPC so each region streams '
  + 'near its own local origin, and run the deliverable per tile.';

/**
 * Decide whether a precision-sensitive deliverable may be minted from a cloud
 * with this in-memory quantization.
 *
 * Refuses on ONE condition: a measured worst-case step, in metres, above the
 * budget. It deliberately does NOT refuse when the linear unit is unestablished
 * ({@link PrecisionGrade} `unknown`). There is no metre figure to compare in
 * that case, and the unit question already has an authority —
 * `SpatialContext.metricClaimsPermitted`, which blocks a metric claim on an
 * unknown-unit CRS before a deliverable is reached. Two gates answering one
 * question is how they drift apart; the source-unit figures stay on the
 * estimate so the disclosure surface can still show what it knows.
 */
export function resolvePrecisionPermit(
  precision: InMemoryPrecision,
  options: PrecisionPermitOptions = {},
): PrecisionPermit {
  const supplied = options.budgetMetres;
  const budget =
    supplied !== undefined && Number.isFinite(supplied) && supplied > 0
      ? supplied
      : PRECISION_BUDGET_M;

  const step = precision.metres?.worstCaseSpacing;
  if (step === undefined || !Number.isFinite(step) || step <= budget) {
    return { ok: true, precision };
  }

  return {
    ok: false,
    precision,
    reasons: [
      `In-memory positions are stored as Float32, which resolves this extent to `
      + `${formatPrecisionMetres(step)} on the ${precision.governingAxis} axis `
      + `(${precision.reach.toFixed(0)} source units from the local origin).`,
      `That is above the ${formatPrecisionMetres(budget)} budget this deliverable is minted under, `
      + `so the coordinates it would carry are quantization below that step, not measurement.`,
      REMEDY,
    ],
  };
}
