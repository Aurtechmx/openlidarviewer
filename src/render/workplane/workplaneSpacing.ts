/**
 * workplaneSpacing.ts
 *
 * The reference grid's line spacing: a 1-2-5 progression chosen from how many
 * CSS pixels one source unit covers on screen, held steady by hysteresis so the
 * grid does not flicker between two steps while the camera moves.
 *
 * SELECTION. The automatic major step is the 1-2-5 value whose on-screen
 * spacing is closest, on a log scale, to {@link TARGET_PX} (the geometric
 * centre of 50 and 100 px). Consecutive steps differ by a factor of 2 or 2.5,
 * so the chosen spacing always lands between TARGET_PX / sqrt(2.5) and
 * TARGET_PX * sqrt(2.5), about 45 to 112 px.
 *
 * HYSTERESIS. A step already on screen is kept while its spacing stays inside
 * [{@link HOLD_MIN_PX}, {@link HOLD_MAX_PX}]. That band contains the whole
 * selection band, so a step that has just been chosen is always held on the
 * next frame: a change of step needs the zoom to move the spacing out of the
 * hold band, and it cannot flip back until the zoom moves it out again in the
 * other direction.
 *
 * Pure: no DOM, no three.js.
 */

/** Geometric centre of the 50 to 100 px target band. */
export const TARGET_PX = Math.sqrt(50 * 100);
/** Keep the current step while its on-screen spacing is at least this. */
export const HOLD_MIN_PX = 35;
/** Keep the current step while its on-screen spacing is at most this. */
export const HOLD_MAX_PX = 140;
/** Minor lines are drawn only when they sit at least this far apart on screen. */
export const MINOR_MIN_PX = 8;

/** A grid spacing in source units. */
export interface GridSpacing {
  readonly major: number;
  readonly minor: number;
}

const MANTISSAS = [1, 2, 5] as const;

/** `m × 10^e` written through the decimal parser, so 2e-1 is 0.2 exactly as printed. */
function step(m: number, e: number): number {
  return Number(`${m}e${e}`);
}

/** The 1-2-5 values bracketing `x`, from one decade below to one above. */
function candidatesAround(x: number): number[] {
  const e = Math.floor(Math.log10(x));
  const out: number[] = [];
  for (let d = e - 1; d <= e + 1; d++) for (const m of MANTISSAS) out.push(step(m, d));
  return out;
}

/** The leading digit of a positive number (1 to 9). */
function mantissaOf(x: number): number {
  const e = Math.floor(Math.log10(x));
  return Math.round(x / Math.pow(10, e));
}

/**
 * Minor spacing for a major step: a fifth for a 1 or 5 step, a quarter for a 2
 * step, so every minor line sits on a round value (2 m -> 0.5 m, not 0.4 m).
 * Any other typed major is split in five.
 */
export function minorStepFor(major: number): number {
  const m = mantissaOf(major);
  const minor = m === 2 ? major / 4 : major / 5;
  return Number(minor.toPrecision(12));
}

/** Whether `px` lies in the band a held step may occupy. */
export function withinHoldBand(px: number): boolean {
  return px >= HOLD_MIN_PX && px <= HOLD_MAX_PX;
}

/**
 * The automatic spacing for `pxPerUnit` CSS pixels per source unit. `previous`
 * is the major step currently drawn, or null. Returns null when the scale is
 * not a finite positive number (camera not ready), so the caller keeps what it
 * has rather than drawing a guess.
 */
export function chooseAutoSpacing(pxPerUnit: number, previous: number | null): GridSpacing | null {
  if (!Number.isFinite(pxPerUnit) || pxPerUnit <= 0) return null;
  if (previous !== null && Number.isFinite(previous) && previous > 0 && withinHoldBand(previous * pxPerUnit)) {
    return { major: previous, minor: minorStepFor(previous) };
  }
  const ideal = TARGET_PX / pxPerUnit;
  let best = ideal;
  let bestDist = Infinity;
  for (const c of candidatesAround(ideal)) {
    const dist = Math.abs(Math.log(c / ideal));
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return { major: best, minor: minorStepFor(best) };
}

/**
 * A typed fixed spacing, or null when the text is not a finite positive number.
 * The minor step follows {@link minorStepFor}.
 */
export function fixedSpacing(major: number): GridSpacing | null {
  if (!Number.isFinite(major) || major <= 0) return null;
  return { major, minor: minorStepFor(major) };
}
