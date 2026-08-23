/**
 * profile-fixture-params.mjs — frozen parameters for the MEAS-PROFILE
 * cross-implementation fixtures. Pure (no runtime imports) so the cross-check
 * test can import the constants without pulling in the generator's node
 * dependencies. See scripts/make-profile-fixture.mjs for the surfaces and
 * scripts/run-profile-reference.mjs for the reference pipeline.
 *
 * ─── WHY THESE NUMBERS ──────────────────────────────────────────────────────
 *
 * RAMP is the fixture that carries the closed form. `sampleProfile` reduces each
 * corridor bin with the type-7 quantile, which needs a sort and a linear
 * interpolation between two order statistics; writing that reduction a second
 * time to predict the answer would compare the code to a copy of itself. The
 * ramp removes the need. Every bin holds RAMP_T_COUNT points whose elevations
 * are an exact arithmetic progression across the corridor (the surface has a
 * constant cross-line gradient RAMP_CROSS), and the type-7 quantile of an
 * arithmetic progression collapses to a closed form with no sort and no
 * interpolation in it:
 *
 *     q(p) = first + step · (p/100) · (n − 1)
 *
 * so the expected series is read off the surface equation. RAMP_T_START and
 * RAMP_T_STEP are chosen so the p=25 rank is 2.25 — a FRACTIONAL rank, which is
 * the case that exercises the interpolation rather than landing on an order
 * statistic.
 *
 * Every coordinate is a multiple of 1/2048 with |value| < 32, so the fixture is
 * exactly representable in the Float32Array the sampler reads AND in the double
 * the reference tools use. The two sides therefore see identical numbers and the
 * comparison measures the algorithm, not a transcode.
 *
 * SCATTER is the fixture the closed form cannot reach: an oblique line,
 * irregular corridor populations, empty bins, off-corridor returns and a
 * classification channel. It is compared against the external reference only.
 * Its 192/144/240 triangle makes the line length exact, and every point is kept
 * at least SCATTER_EDGE_MARGIN from a bin boundary and from the corridor edge so
 * that a difference of one part in 1e15 between two projection implementations
 * cannot flip a point into a different bin.
 */

// ── RAMP: analytic corridor, closed form available ──────────────────────────

/** Section line, local render space. Axis-aligned so chainage is x. */
export const RAMP_A = [0, 0, 0];
export const RAMP_B = [256, 0, 0];
/** 257 stations over 256 m = a 1 m bin step. */
export const RAMP_SAMPLES = 257;
/** Corridor half-width, metres. Wider than the outermost corridor offset. */
export const RAMP_BAND = 2.5;
/** Cross-line offsets: RAMP_T_START + k·RAMP_T_STEP, k = 0 … RAMP_T_COUNT−1. */
export const RAMP_T_START = -2.25;
export const RAMP_T_STEP = 0.5;
export const RAMP_T_COUNT = 10;
/** Cross-line gradient, metres of elevation per metre of offset. */
export const RAMP_CROSS = 0.25;
/** Off-corridor decoy offset (outside RAMP_BAND) and its elevation lift. */
export const RAMP_DECOY_T = 4;
export const RAMP_DECOY_LIFT = 40;
/** Chainages of the beyond-the-end decoys, which the along-line gate must drop. */
export const RAMP_END_DECOYS = [-10, 266];

/**
 * Ground elevation along the section: 8 + s/16 − s²/2048, a metre-scale crest
 * peaking at s = 64. Dyadic by construction, so g(s) is exact for integer s.
 */
export const rampGround = (s) => 8 + s / 16 - (s * s) / 2048;

/** Bin step, metres. Exact: 256 / 256. */
export const RAMP_BIN_STEP = (RAMP_B[0] - RAMP_A[0]) / (RAMP_SAMPLES - 1);

/**
 * Closed-form profile height at station index `i` for percentile `p`, derived
 * from the surface equation and the type-7 definition, with no sort and no
 * order statistics of any implementation involved.
 */
export const rampExpected = (i, p) =>
  rampGround(i * RAMP_BIN_STEP)
  + RAMP_CROSS * (RAMP_T_START + RAMP_T_STEP * (p / 100) * (RAMP_T_COUNT - 1));

// ── SCATTER: oblique line, irregular corridor, classification ───────────────

/** Section line: a 192 / 144 / 240 triangle, so the length is exactly 240 m. */
export const SCATTER_A = [10, 5, 0];
export const SCATTER_B = [202, 149, 0];
/** 241 stations over 240 m = a 1 m bin step. */
export const SCATTER_SAMPLES = 241;
/** Corridor half-width, metres. */
export const SCATTER_BAND = 1.75;
/** Bin step, metres. Exact: 240 / 240. */
export const SCATTER_BIN_STEP = 1;
/**
 * How far every point is kept from a bin boundary and from the corridor edge.
 * Two projection implementations agree to about 1e-15 relative; this margin is
 * twelve orders of magnitude above that, so bin membership is not in question.
 */
export const SCATTER_EDGE_MARGIN = 0.05;
/** Stations deliberately left with no corridor points, to exercise the gaps. */
export const SCATTER_EMPTY_BINS = [37, 38, 100, 199];
/** Seed for the fixture's own generator, so the bytes are reproducible. */
export const SCATTER_SEED = 20260819;

/** The percentile both fixtures are compared at, and the RAMP-only second one. */
export const PERCENTILE_PRIMARY = 25;
export const PERCENTILE_SECONDARY = 50;

/** ASPRS classes the sampler drops when a classification channel is supplied. */
export const EXCLUDED_CLASSES = [3, 4, 5, 6, 7, 18];

/** World up. Both fixtures are Z-up, so the sampled height is the point's z. */
export const UP = [0, 0, 1];

// ── CAPS: the corridor ends, where the segment rule and a rectangle differ ───
//
// The band is a distance from the SEGMENT a to b, so the corridor closes with a
// half-disc of radius `band` at each end. A rectangle with square ends admits a
// corner point sitting sqrt(2)·band from the line. RAMP and SCATTER cannot tell
// the two apart: their beyond-the-end returns are 10 m and 8 m out against bands
// of 2.5 m and 1.75 m, so both rules reject them. This fixture puts points in
// the region where the two rules differ and lets the reference decide.
//
// Every coordinate is a multiple of 1/8 and under 40 in magnitude, so it is
// exact in Float32 and in double, as with the other two fixtures.

/** Section line, local render space. Axis-aligned, so chainage is x. */
export const CAPS_A = [0, 0, 0];
export const CAPS_B = [32, 0, 0];
/** 33 stations over 32 m = a 1 m bin step. */
export const CAPS_SAMPLES = 33;
/** Corridor half-width, metres. */
export const CAPS_BAND = 2;
/** Bin step, metres. Exact: 32 / 32. */
export const CAPS_BIN_STEP = (CAPS_B[0] - CAPS_A[0]) / (CAPS_SAMPLES - 1);
/** Cross-line offsets of the interior corridor: CAPS_T_START + k·CAPS_T_STEP. */
export const CAPS_T_START = -1.75;
export const CAPS_T_STEP = 0.5;
export const CAPS_T_COUNT = 8;
/** Cross-line gradient, metres of elevation per metre of offset. */
export const CAPS_CROSS = 0.25;
/** Off-corridor decoy offset (outside CAPS_BAND) and its elevation lift. */
export const CAPS_DECOY_T = 3.5;
export const CAPS_DECOY_LIFT = 40;
/**
 * Elevation offset carried by every cap point the segment rule rejects. It is
 * NEGATIVE because the comparison runs at low percentiles: a rejected point
 * that leaked in would pull p25 down by tens of metres, which no rounding
 * difference can imitate.
 */
export const CAPS_REJECT_LIFT = -40;

/** Ground along the section: dyadic, so g(s) is exact for integer s. */
export const capsGround = (s) => 10 + s / 8 - (s * s) / 4096;

/**
 * Cap probes, as [distance PAST the end, cross-line offset, admitted]. Each is
 * placed at both ends, mirrored through the section's midpoint. `admitted` is
 * declared here rather than derived, and scripts/make-profile-fixture.mjs
 * asserts it against the distance to the endpoint before writing a byte.
 *
 * The first five sit inside the cap. The next six are the disputed region: a
 * cross-line offset no greater than the band and a chainage no further past the
 * end than the band, which a rectangle admits, but more than `band` from the
 * segment. Two of them are the rectangle's own corners at exactly (band, band).
 * The last two are outside on either rule.
 *
 * No probe is closer than 0.125 m to the cap boundary. Two projection
 * implementations agree to about 1e-15 relative, so nothing here is decided by
 * which one ran.
 */
export const CAPS_PROBES = [
  [0.5, 0.25, true],
  [1, 0.75, true],
  [1.5, 0.5, true],
  [0.25, -1.5, true],
  [1.25, -1, true],
  [1.5, 1.75, false],
  [2, 2, false],
  [2, -2, false],
  [1.75, -1.5, false],
  [0.75, 2, false],
  [1, -1.875, false],
  [3, 0.5, false],
  [2.5, -1, false],
];

/**
 * Closed-form profile height at an INTERIOR station of the caps fixture, from
 * the surface equation and the type-7 definition. Stations 0 and CAPS_SAMPLES−1
 * are outside its reach: the admitted cap points join their corridors, so those
 * two are no longer an arithmetic progression.
 */
export const capsExpected = (i, p) =>
  capsGround(i * CAPS_BIN_STEP)
  + CAPS_CROSS * (CAPS_T_START + CAPS_T_STEP * (p / 100) * (CAPS_T_COUNT - 1));

// ── ENDCAP: one probe per decisive case, membership only ────────────────────
//
// CAPS answers "does the corridor close with a half-disc" through the p25 of
// two stations. It cannot answer what happens ON the threshold: every one of
// its probes is held at least 0.125 m clear of the cap boundary, and the
// MEAS-PROFILE-OGR-R-CORRIDOR study lists the exact-boundary tie-break in its
// own scope.unsupported. This fixture is the membership-level reference for
// that gap: eight probes, each decisive for one case, compared point by point
// rather than through a percentile.
//
// The band is 2.5 m so a 3-4-5 triangle scaled by 1/2 lands a probe EXACTLY on
// the cap boundary: 1.5² + 2² = 6.25 = 2.5². All three legs are dyadic and the
// squares and their sum are exact in Float32 and in double, so the boundary
// case is a true tie and not a value that happens to round onto one side. The
// sampler compares squared distance against squared band, SpatiaLite compares
// the distance itself against the band; on this probe both comparisons see
// equality, which is what makes the tie-break observable at all.

/** Section line, local render space. Axis-aligned, so chainage is x. */
export const ENDCAP_A = [0, 0, 0];
export const ENDCAP_B = [32, 0, 0];
/** 33 stations over 32 m = a 1 m bin step. */
export const ENDCAP_SAMPLES = 33;
/** Corridor half-width, metres. 2.5 makes the 1.5/2/2.5 boundary probe exact. */
export const ENDCAP_BAND = 2.5;
/** Bin step, metres. Exact: 32 / 32. */
export const ENDCAP_BIN_STEP = (ENDCAP_B[0] - ENDCAP_A[0]) / (ENDCAP_SAMPLES - 1);
/** Elevation every probe carries. Membership is the measurement, not height. */
export const ENDCAP_Z = 10;

/**
 * The eight probes, one per decisive case. `x` and `y` are absolute, in the
 * same local frame as the section line, so nothing has to be reconstructed from
 * a chainage convention. `admitted` is the HAND-DERIVED verdict for a corridor
 * whose membership is "distance to the finite segment <= band". It is written
 * here and asserted against exact arithmetic by scripts/make-profile-fixture.mjs
 * before a byte is written.
 *
 * `caseNo` is the case number in the end-cap reference. `rectangle` is what a
 * corridor with square ends would say about the same probe, which is what makes
 * case 3 the discriminating one: it is the only probe the two rules disagree
 * about while sitting nowhere near either threshold, so its verdict reports
 * which shape the implementation has rather than how it rounds.
 *
 * Every coordinate is a multiple of 1/32 and under 40 in magnitude, so it is
 * exact in the Float32Array the sampler reads and in the double the reference
 * tools work in.
 */
export const ENDCAP_PROBES = [
  { id: 'c1-start-cap-inside', caseNo: 1, x: -1, y: 0.5, admitted: true },
  { id: 'c2-start-cap-boundary', caseNo: 2, x: -1.5, y: 2, admitted: true },
  { id: 'c3-square-corner', caseNo: 3, x: -2.5, y: 2.5, admitted: false },
  { id: 'c4-start-cap-outside', caseNo: 4, x: -1.5, y: 2.03125, admitted: false },
  { id: 'c5a-end-cap-inside', caseNo: 5, x: 33, y: -0.5, admitted: true },
  { id: 'c5b-end-cap-outside', caseNo: 5, x: 33.5, y: -2.03125, admitted: false },
  { id: 'c6-body-inside', caseNo: 6, x: 16, y: 2.46875, admitted: true },
  { id: 'c7-body-boundary', caseNo: 7, x: 16, y: 2.5, admitted: true },
];

/**
 * Horizontal distance from a probe to the nearest point ON the segment: the
 * perpendicular offset between the endpoints, the radius to the endpoint past
 * either end. This is the definition the `admitted` flags are checked against,
 * and it is deliberately not the sampler's expression.
 */
export const endcapDistance = ({ x, y }) => {
  const len = ENDCAP_B[0] - ENDCAP_A[0];
  const s = x < 0 ? 0 : x > len ? len : x;
  return Math.hypot(x - s, y);
};

/** The rectangle rule, for the same probe: square ends, band past either end. */
export const endcapRectangle = ({ x, y }) =>
  Math.abs(y) <= ENDCAP_BAND
  && x >= -ENDCAP_BAND
  && x <= ENDCAP_B[0] - ENDCAP_A[0] + ENDCAP_BAND;
