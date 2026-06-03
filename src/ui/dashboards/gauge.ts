/**
 * gauge.ts
 *
 * Pure SVG geometry for a semi-circular gauge — the "X out of Y"
 * single-number visualisation the Inspector card uses to show point
 * count vs budget, density vs target, or any other quantity bounded
 * by a known range.
 *
 * Output is purely geometric: SVG arc path strings + the geometric
 * params the caller needs to render labels. No DOM, no styling — the
 * caller wraps the paths in `<path>` elements with whatever stroke
 * and fill the Inspector theme specifies.
 *
 * Math layout:
 *
 *   - The gauge sweeps from `startAngle` (default -π) to `endAngle`
 *     (default 0), i.e. a half-circle opening upward.
 *   - The "value arc" starts at `startAngle` and ends at the angle
 *     corresponding to `value` in the `[min, max]` range.
 *   - The "track arc" spans the full range.
 *
 * Both arcs share the same outer radius and inner radius (the gauge
 * is a thick ring). A degenerate range (`min == max`) yields a value
 * fraction of 0 — the gauge reads empty rather than NaN.
 */

/** A gauge build result. */
export interface GaugeResult {
  /** SVG path for the background "track" arc. */
  readonly trackPath: string;
  /** SVG path for the filled "value" arc. */
  readonly valuePath: string;
  /** Centre x-coordinate of the gauge in SVG units. */
  readonly cx: number;
  /** Centre y-coordinate of the gauge in SVG units. */
  readonly cy: number;
  /** Outer radius. */
  readonly rOuter: number;
  /** Inner radius. */
  readonly rInner: number;
  /** Fraction of the range the value occupies, clamped to `[0, 1]`. */
  readonly fraction: number;
  /** Viewport width (same as input). */
  readonly width: number;
  /** Viewport height (same as input). */
  readonly height: number;
}

/** Inputs to `buildGauge`. */
export interface GaugeInput {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  /** Viewport width in SVG units. */
  readonly width: number;
  /** Viewport height in SVG units. */
  readonly height: number;
  /** Outer radius. Defaults to half the viewport width minus padding. */
  readonly outerRadius?: number;
  /** Inner radius. Defaults to 70% of the outer radius. */
  readonly innerRadius?: number;
  /** Start angle in radians. Defaults to `-π` (left horizontal). */
  readonly startAngle?: number;
  /** End angle in radians. Defaults to `0` (right horizontal). */
  readonly endAngle?: number;
  /** Padding inside the viewport. Defaults to 2. */
  readonly padding?: number;
}

/**
 * Build a semi-circular gauge. Pure.
 */
export function buildGauge(input: GaugeInput): GaugeResult {
  const W = input.width;
  const H = input.height;
  const PAD = input.padding ?? 2;
  const startAngle = input.startAngle ?? -Math.PI;
  const endAngle = input.endAngle ?? 0;

  // Default outer radius — fits a half-circle inside the viewport.
  const outerRadius =
    input.outerRadius ?? Math.max(0, Math.min((W - PAD * 2) / 2, H - PAD * 2));
  const innerRadius = input.innerRadius ?? outerRadius * 0.7;

  const cx = W / 2;
  // Sit the gauge so the half-circle's bottom edge lands at H - padding.
  const cy = H - PAD;

  const range = input.max - input.min;
  let fraction = 0;
  if (range > 0 && Number.isFinite(input.value)) {
    fraction = Math.max(
      0,
      Math.min(1, (input.value - input.min) / range),
    );
  }
  const valueAngle = startAngle + (endAngle - startAngle) * fraction;

  return {
    trackPath: ringArc(cx, cy, outerRadius, innerRadius, startAngle, endAngle),
    valuePath:
      fraction > 0
        ? ringArc(cx, cy, outerRadius, innerRadius, startAngle, valueAngle)
        : '',
    cx,
    cy,
    rOuter: outerRadius,
    rInner: innerRadius,
    fraction,
    width: W,
    height: H,
  };
}

/**
 * Build a filled ring-arc path string. The shape walks the outer arc
 * from `a0` to `a1`, then the inner arc back to the start, closing
 * the ring slice.
 */
function ringArc(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  a0: number,
  a1: number,
): string {
  const x0Outer = cx + rOuter * Math.cos(a0);
  const y0Outer = cy + rOuter * Math.sin(a0);
  const x1Outer = cx + rOuter * Math.cos(a1);
  const y1Outer = cy + rOuter * Math.sin(a1);
  const x0Inner = cx + rInner * Math.cos(a1);
  const y0Inner = cy + rInner * Math.sin(a1);
  const x1Inner = cx + rInner * Math.cos(a0);
  const y1Inner = cy + rInner * Math.sin(a0);

  const sweep = a1 - a0;
  const large = Math.abs(sweep) > Math.PI ? 1 : 0;
  const dir = sweep >= 0 ? 1 : 0;
  const dirReverse = sweep >= 0 ? 0 : 1;

  return [
    `M${x0Outer.toFixed(2)} ${y0Outer.toFixed(2)}`,
    `A${rOuter.toFixed(2)} ${rOuter.toFixed(2)} 0 ${large} ${dir} ${x1Outer.toFixed(2)} ${y1Outer.toFixed(2)}`,
    `L${x0Inner.toFixed(2)} ${y0Inner.toFixed(2)}`,
    `A${rInner.toFixed(2)} ${rInner.toFixed(2)} 0 ${large} ${dirReverse} ${x1Inner.toFixed(2)} ${y1Inner.toFixed(2)}`,
    'Z',
  ].join(' ');
}
