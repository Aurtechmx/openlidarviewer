/**
 * tolerances.ts
 *
 * The pre-registered agreement thresholds for the GPU-vs-CPU comparison.
 *
 * THESE NUMBERS ARE FIXED BEFORE ANY COMPARISON RUNS. Every threshold below is
 * accompanied by the physical or numerical magnitude it is derived from, and
 * the derivation is carried in the file as a computed constant so a reader can
 * check the arithmetic instead of taking the rounded figure on trust. A
 * threshold widened after seeing a measurement would be a different document;
 * the comparator has no code path that adjusts one.
 *
 * THE REPRESENTATION DIFFERENCE IS EXPECTED, NOT A DEFECT. The CPU reference
 * (`hornSlopeAspect`, `shadeFromSlopeAspect`) computes in f64 and stores f32.
 * The WGSL kernels compute in f32 throughout, and WGSL permits fusing and
 * reassociating those operations and leaves `atan2`, `sqrt` and `inverseSqrt`
 * at implementation precision. Two implementations of the same formula in
 * those two representations do not agree bit-for-bit, and a suite that demanded
 * bit-equality would be measuring the representation rather than the science.
 * So each continuous quantity carries two numbers:
 *
 *   - a REPRESENTATION FLOOR — what f32 arithmetic alone can account for;
 *   - a GATE — the threshold that decides the verdict, which is the value the
 *     shipped engine already enforces (`EQUIVALENCE_*` in
 *     TerrainRasterEngine.ts).
 *
 * A measurement between the floor and the gate is reported as an observation
 * with its magnitude named. It is not silently absorbed, and it is not called a
 * failure either: it is a divergence larger than f32 alone explains and smaller
 * than the shipped contract forbids, and the report says exactly that.
 *
 * Pure. No I/O, no clock, no randomness.
 */

/** Machine epsilon for IEEE-754 binary32: 2⁻²³. */
export const F32_EPSILON = 2 ** -23;

/**
 * Floating-point operations charged to one Horn derivative cell.
 *
 * The 3×3 Horn operator forms two weighted neighbour sums (8 adds and 2
 * doublings each), subtracts them, divides by 8·cellSize, applies the vertical
 * unit factor, squares both components, adds and takes a square root — call it
 * two dozen dependent f32 operations. Charged at 32 so the budget covers the
 * validity-mask fallbacks and any reassociation the compiler performs, and so
 * the figure is a ceiling rather than a count that would need revisiting when
 * the kernel is edited.
 */
export const HORN_F32_OP_BUDGET = 32;

/**
 * Worst-case relative error attributed to f32 evaluation of the Horn operator:
 * 32 · 2⁻²³ ≈ 3.8 × 10⁻⁶.
 */
export const HORN_RELATIVE_F32_ERROR = HORN_F32_OP_BUDGET * F32_EPSILON;

/**
 * The slope magnitude the absolute floor is stated at.
 *
 * Slope here is rise over run, dimensionless. A 16:1 rise-over-run is 86°, past
 * the steepest natural terrain in a DTM and past anything the probe surface
 * reaches (its steepest cell is near 1.5). The floor is quoted at this cap so
 * it bounds the absolute error on any grid the engine could be handed, not just
 * on the probe.
 */
export const SLOPE_MAGNITUDE_CAP = 16;

/**
 * Absolute per-cell slope disagreement f32 evaluation alone accounts for:
 * 3.8 × 10⁻⁶ × 16 ≈ 6.1 × 10⁻⁵ rise/run.
 */
export const SLOPE_REPRESENTATION_FLOOR = HORN_RELATIVE_F32_ERROR * SLOPE_MAGNITUDE_CAP;

/**
 * The slope gate: 10⁻⁴ rise/run, about 1.6× the representation floor.
 *
 * Equal to `EQUIVALENCE_SLOPE_TOLERANCE` in the shipped engine, so this suite
 * never certifies a backend the product itself would refuse to activate. In
 * terrain terms 10⁻⁴ rise/run is 0.006° of surface inclination — below the
 * angular resolution of any slope class, hillshade level or contour the viewer
 * derives from it.
 */
export const SLOPE_GATE = 1e-4;

/**
 * Angular error attributed to f32: the relative gradient error carries into
 * `atan2` roughly one-for-one in radians, plus a few ulp for an
 * implementation-precision `atan2` evaluated near π. About 5.3 × 10⁻⁶ rad.
 */
export const ASPECT_REPRESENTATION_FLOOR = HORN_RELATIVE_F32_ERROR + 4 * F32_EPSILON * Math.PI;

/**
 * The aspect gate: 10⁻⁴ radians (0.0057°), about 19× the representation floor.
 * Equal to `EQUIVALENCE_ASPECT_TOLERANCE_RAD` in the shipped engine. Compared
 * as an angular distance with wraparound at 2π, so the 0/2π seam is not counted
 * as a full-circle disagreement.
 */
export const ASPECT_GATE_RAD = 1e-4;

/**
 * The reference slope below which aspect is not compared, inherited from the
 * engine probe (`EQUIVALENCE_ASPECT_SLOPE_FLOOR`).
 *
 * THIS FLOOR WEAKENS THE ASPECT CLAIM AND THE REPORT SAYS SO. Gradient
 * direction on a near-flat cell is the arctangent of two differences that have
 * cancelled away most of their significant bits, so its f32 error is not
 * bounded by the relative model above — at slope 10⁻⁶ the derived angular
 * floor is order 1 radian, far above the gate. The cells excluded by this floor
 * are therefore not certified by an aspect number at all. What covers them is
 * hillshade, which is the product aspect feeds: shading varies with aspect as
 * sin(slope), so on those same cells the shade is insensitive to the direction
 * and its ±1-level gate does bound the visible outcome.
 */
export const ASPECT_COMPARISON_SLOPE_FLOOR = 1e-6;

/**
 * Hillshade quantisation step: the shade is an 8-bit grey level, so one level
 * is 1/255 of full scale (0.39 %).
 */
export const SHADE_QUANTISATION_STEP = 1 / 255;

/**
 * The hillshade gate: 1 grey level.
 *
 * DERIVED FROM QUANTISATION, NOT FROM f32 EPSILON. The CPU reference rounds
 * half-up through `Math.round`; a GPU `round` at the same half-way point can
 * land on the other neighbour. Any cosine value within one f32 ulp of a
 * quantisation boundary can therefore differ by exactly one level while the
 * underlying illumination agrees to f32 precision. One level is the smallest
 * threshold that admits that seam, and it is also the largest that admits
 * nothing else: a two-level difference is a real difference in illumination.
 * Equal to `EQUIVALENCE_SHADE_TOLERANCE` in the shipped engine.
 */
export const SHADE_GATE_LEVELS = 1;

/**
 * The DTM scatter gate: exact.
 *
 * Per-cell minimum elevation and per-cell return count are order-independent
 * reductions over values that are already f32 — a minimum selects one of its
 * inputs rather than combining them, and a count is an integer. Neither has a
 * representation floor, so any difference at all is a defect and the threshold
 * is zero. Compared bit-for-bit so a NaN-vs-number or −0-vs-+0 cell is caught.
 */
export const SCATTER_GATE = 0;

/** One pre-registered threshold and the magnitude it was derived from. */
export interface PreRegisteredTolerance {
  readonly quantity: string;
  readonly unit: string;
  /** The threshold that decides the verdict. */
  readonly gate: number;
  /** What f32 evaluation alone accounts for; null when the gate is exact. */
  readonly representationFloor: number | null;
  readonly derivation: string;
}

/**
 * The registry, in the order the report prints it.
 *
 * A test asserts every quantity a leg record can carry appears here, so a
 * product added to the record without a pre-registered threshold fails rather
 * than being compared against an implicit one.
 */
export const PRE_REGISTERED_TOLERANCES: readonly PreRegisteredTolerance[] = [
  {
    quantity: 'slope',
    unit: 'rise/run',
    gate: SLOPE_GATE,
    representationFloor: SLOPE_REPRESENTATION_FLOOR,
    derivation:
      '32 f32 operations at 2^-23 relative error, quoted at a 16:1 rise/run cap (86 degrees, steeper than any terrain in a DTM)',
  },
  {
    quantity: 'aspect',
    unit: 'rad',
    gate: ASPECT_GATE_RAD,
    representationFloor: ASPECT_REPRESENTATION_FLOOR,
    derivation:
      'gradient relative error carried through atan2, plus 4 ulp for an implementation-precision atan2 near pi; compared only where the reference slope exceeds 1e-6',
  },
  {
    quantity: 'hillshade',
    unit: '8-bit grey level',
    gate: SHADE_GATE_LEVELS,
    representationFloor: null,
    derivation:
      'the 1/255 quantisation step: a cosine within one ulp of a level boundary rounds either way, which is one level and never two',
  },
  {
    quantity: 'scatterMinCount',
    unit: 'cells differing',
    gate: SCATTER_GATE,
    representationFloor: null,
    derivation:
      'per-cell minimum and count are order-independent integer-stable reductions with no representation floor, so the threshold is exact',
  },
] as const;
