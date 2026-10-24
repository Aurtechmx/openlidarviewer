/**
 * rationalDischarge.ts — a steady-state peak-flow estimate by the rational
 * method, applied to the contributing area the D8 routing already computed.
 *
 *   Q = C · i · A
 *
 * Q is the peak discharge in m³/s, C the dimensionless runoff coefficient,
 * i the rainfall intensity in m/s (an intensity in mm/h divided by 3.6e6) and
 * A the contributing area in m² (upstream cell count times the cell area).
 * In the SI form HEC-22 writes, Q = C·I·A / 360 with I in mm/h and A in
 * hectares; the two agree, and a test pins that.
 *
 * What the formula assumes, and what this module therefore says beside every
 * figure: rain falls uniformly over the whole catchment, at a constant
 * intensity, for at least the time of concentration, so the whole catchment
 * contributes at once (steady state); C lumps infiltration, depression
 * storage and every other loss into one number; nothing is stored or routed
 * in time. The routing underneath is D8, one receiver per cell, over the raw
 * or the Priority-Flood-conditioned surface the run declared. HEC-22 limits the
 * method to drainage areas below 80 ha (0.8 km²); above that the estimate is
 * flagged.
 *
 * It is an estimate on top of a routing graph, not a rainfall-runoff model:
 * no hydrograph, no timing, no infiltration model, no channel hydraulics.
 * Particle speed in the Lab is a display encoding of the upstream cell count;
 * no velocity is computed here or anywhere in Flow Pulse.
 *
 * The figure is withheld, not guessed, wherever the contributing area is: an
 * unresolved horizontal scale gives no square metres, so it gives no Q.
 *
 * Sources: Kuichling (1889), Transactions of the ASCE 20, 1-56, for the
 * method; FHWA HEC-22, Urban Drainage Design Manual, 3rd ed. (FHWA-NHI-10-009,
 * 2009, rev. 2013), Equation 3-1, Table 3-1 (after ASCE 1960, Design Manual
 * for Storm Drainage) and the 80 ha limit in section 3.2.2, for the runoff
 * coefficients and the area limit; Schwab, Fangmeier, Elliot & Frevert (1993),
 * Soil and Water Conservation Engineering, 4th ed., Wiley, for woodland.
 *
 * Pure: no DOM, no I/O.
 */

/** Rainfall intensity slider bounds, in mm/h. */
export const RAINFALL_MIN_MM_H = 1;
export const RAINFALL_MAX_MM_H = 200;
export const RAINFALL_STEP_MM_H = 1;
export const RAINFALL_DEFAULT_MM_H = 25;

/** Runoff coefficient slider bounds. */
export const RUNOFF_C_MIN = 0.05;
export const RUNOFF_C_MAX = 1;
/** Fine enough that every preset midpoint below sits exactly on a step. */
export const RUNOFF_C_STEP = 0.005;

/** mm/h per m/s: 1 m/s = 1e3 mm × 3600 s/h. */
export const MM_PER_H_PER_M_PER_S = 3.6e6;

/**
 * Peak flow at or above which the Lab draws a cell as a channel: 1 L/s. A
 * fixed threshold, so raising the rainfall makes more of the network reach it.
 */
export const DISPLAY_THRESHOLD_M3S = 0.001;
/** Top of the display ramp: 1,000 L/s (1 m³/s). Three decades above the threshold. */
export const DISPLAY_RAMP_TOP_M3S = 1;

/** HEC-22 section 3.2.2: the rational formula only for drainage areas below 80 ha. */
export const RATIONAL_MAX_AREA_M2 = 800_000;

/** One preset: a typical range from a published table, and the midpoint used. */
export interface RunoffPreset {
  readonly id: string;
  /** Short label for the picker. */
  readonly label: string;
  /** The published range [low, high] the midpoint comes from. */
  readonly range: readonly [number, number];
  /** The coefficient used: the midpoint of `range`. */
  readonly c: number;
  /** Where the range is printed. */
  readonly source: string;
}

const HEC22 = 'FHWA HEC-22 (2009) Table 3-1, after ASCE (1960)';

function preset(id: string, label: string, low: number, high: number, source: string): RunoffPreset {
  return { id, label, range: [low, high], c: Math.round(((low + high) / 2) * 1000) / 1000, source };
}

/**
 * Typical runoff coefficients, midpoints of published ranges. Ranges, not
 * measurements: the right C for a real site depends on soil, slope, cover,
 * antecedent wetness and the storm itself.
 */
export const RUNOFF_PRESETS: readonly RunoffPreset[] = Object.freeze([
  preset('woodland', 'Woodland (mature)', 0.02, 0.15,
    'Schwab et al. (1993): woodland, mature, good condition, soil group B, 0.02 at 25 mm/h to 0.15 at 200 mm/h'),
  preset('lawn-sandy', 'Grass on sandy soil', 0.10, 0.15, `${HEC22}: lawns, sandy soil, average slope 2-7 %`),
  preset('lawn-heavy', 'Grass on heavy soil', 0.18, 0.22, `${HEC22}: lawns, heavy soil, average slope 2-7 %`),
  preset('unimproved', 'Unimproved or bare ground', 0.10, 0.30, `${HEC22}: unimproved areas`),
  preset('asphalt', 'Paved (asphalt)', 0.70, 0.95, `${HEC22}: streets, asphaltic`),
]);

/** The preset the Lab opens with. */
export const RUNOFF_DEFAULT_PRESET = 'lawn-heavy';

/** The rainfall and coefficient a user set. */
export interface RainfallSetting {
  readonly intensityMmH: number;
  readonly runoffC: number;
  /** The preset `runoffC` came from, or null/absent when the user set it by hand. */
  readonly presetId?: string | null;
}

/** The preset a setting names, when its coefficient is still that preset's midpoint. */
export function presetOf(s: RainfallSetting): RunoffPreset | null {
  const p = s.presetId ? RUNOFF_PRESETS.find((x) => x.id === s.presetId) ?? null : null;
  return p && Math.abs(p.c - s.runoffC) < 1e-9 ? p : null;
}

/** Clamp a setting into the slider ranges; a non-finite value falls back to the default. */
export function clampRainfall(s: RainfallSetting): RainfallSetting {
  const i = Number.isFinite(s.intensityMmH) ? s.intensityMmH : RAINFALL_DEFAULT_MM_H;
  const c = Number.isFinite(s.runoffC) ? s.runoffC : presetById(RUNOFF_DEFAULT_PRESET).c;
  return {
    intensityMmH: Math.min(RAINFALL_MAX_MM_H, Math.max(RAINFALL_MIN_MM_H, i)),
    runoffC: Math.min(RUNOFF_C_MAX, Math.max(RUNOFF_C_MIN, c)),
    presetId: s.presetId ?? null,
  };
}

export function presetById(id: string): RunoffPreset {
  const p = RUNOFF_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown runoff preset: ${id}`);
  return p;
}

/** The default setting: 25 mm/h over grass on heavy soil. */
export const RAINFALL_DEFAULT: RainfallSetting = Object.freeze({
  intensityMmH: RAINFALL_DEFAULT_MM_H,
  runoffC: presetById(RUNOFF_DEFAULT_PRESET).c,
  presetId: RUNOFF_DEFAULT_PRESET,
});

/** Rainfall intensity in m/s from mm/h. */
export function intensityMetresPerSecond(mmPerHour: number): number {
  return mmPerHour / MM_PER_H_PER_M_PER_S;
}

/** Q = C · i · A, in m³/s, for i in mm/h and A in m². */
export function rationalPeakM3s(runoffC: number, intensityMmH: number, areaM2: number): number {
  return runoffC * intensityMetresPerSecond(intensityMmH) * areaM2;
}

/**
 * The smallest contributing area whose peak flow reaches `thresholdM3s` at
 * this setting. A cell is drawn as a channel when its area is at least this.
 */
export function minAreaForFlowM2(setting: RainfallSetting, thresholdM3s = DISPLAY_THRESHOLD_M3S): number {
  const perM2 = rationalPeakM3s(setting.runoffC, setting.intensityMmH, 1);
  return perM2 > 0 ? thresholdM3s / perM2 : Number.POSITIVE_INFINITY;
}

/**
 * Position of a peak flow on the display ramp: 0 at the 1 L/s threshold, 1 at
 * 1,000 L/s and above, linear in log10(Q). A fixed scale, so more rain moves
 * every channel up it.
 */
export function flowDisplayStrength(qM3s: number): number {
  if (!(qM3s > DISPLAY_THRESHOLD_M3S)) return 0;
  const t = Math.log10(qM3s / DISPLAY_THRESHOLD_M3S) / Math.log10(DISPLAY_RAMP_TOP_M3S / DISPLAY_THRESHOLD_M3S);
  return t > 1 ? 1 : t;
}

/** Per-cell display field at one setting: which cells reach the threshold, and how far up the ramp. */
export interface FlowDisplayField {
  /** 1 where the cell's peak flow reaches the display threshold. */
  readonly channel: Uint8Array;
  /** {@link flowDisplayStrength} per channel cell, 0 elsewhere. */
  readonly strength: Float32Array;
  /** Channel cells at this setting. */
  readonly channelCells: number;
}

/**
 * The display field over a per-cell contributing area (null entries never
 * occur: a caller with no metric area has no field). NoData cells carry area
 * 0 and never reach the threshold.
 */
export function flowDisplayField(areaM2: Float64Array, setting: RainfallSetting): FlowDisplayField {
  const n = areaM2.length;
  const channel = new Uint8Array(n);
  const strength = new Float32Array(n);
  const perM2 = rationalPeakM3s(setting.runoffC, setting.intensityMmH, 1);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const q = perM2 * areaM2[i]!;
    if (q < DISPLAY_THRESHOLD_M3S) continue;
    channel[i] = 1;
    strength[i] = flowDisplayStrength(q);
    count++;
  }
  return { channel, strength, channelCells: count };
}

/** A peak-flow estimate for one cell, or the reason it is withheld. */
export type PeakFlowEstimate =
  | {
    readonly ok: true;
    readonly qM3s: number;
    readonly setting: RainfallSetting;
    readonly areaM2: number;
    /** The area is a lower bound (edge-contaminated), so Q is too. */
    readonly lowerBound: boolean;
    /** The area is above the rational method's 0.8 km² limit. */
    readonly aboveAreaLimit: boolean;
  }
  | { readonly ok: false; readonly reason: string };

/** The withheld wording the Lab uses for every metric figure. */
export const PEAK_FLOW_WITHHELD = 'Withheld: the horizontal scale is not resolved';

/** Estimate Q for one contributing area, or withhold it when the area is not known in m². */
export function peakFlowEstimate(
  areaM2: number | null,
  setting: RainfallSetting,
  lowerBound = false,
): PeakFlowEstimate {
  if (areaM2 == null || !Number.isFinite(areaM2) || areaM2 < 0) return { ok: false, reason: PEAK_FLOW_WITHHELD };
  const s = clampRainfall(setting);
  return {
    ok: true,
    qM3s: rationalPeakM3s(s.runoffC, s.intensityMmH, areaM2),
    setting: s,
    areaM2,
    lowerBound,
    aboveAreaLimit: areaM2 > RATIONAL_MAX_AREA_M2,
  };
}

/** A peak flow for a reader: L/s below 1,000 L/s, m³/s from there up. */
export function formatPeakFlow(qM3s: number): string {
  const lps = qM3s * 1000;
  if (lps < 1000) {
    if (lps >= 100) return `${Math.round(lps).toLocaleString('en-US')} L/s`;
    if (lps >= 10) return `${lps.toFixed(1)} L/s`;
    return `${lps.toPrecision(2)} L/s`;
  }
  return `${qM3s.toFixed(qM3s >= 100 ? 0 : 2)} m³/s`;
}

/** A coefficient as written: up to three decimals, trailing zeros dropped. */
export function formatRunoffC(c: number): string {
  return String(Number(c.toFixed(3)));
}

/** The one-line statement of a setting: "25 mm/h, C 0.2". */
export function settingText(s: RainfallSetting): string {
  return `${Math.round(s.intensityMmH)} mm/h, C ${formatRunoffC(s.runoffC)}`;
}

/**
 * The estimate as one line for the selection panel and the exports, e.g.
 * "280 L/s at 25 mm/h, C 0.2", prefixed "at least" when the area is a lower
 * bound. A withheld estimate returns its reason.
 */
export function peakFlowText(e: PeakFlowEstimate): string {
  if (!e.ok) return e.reason;
  return `${e.lowerBound ? 'at least ' : ''}${formatPeakFlow(e.qM3s)} at ${settingText(e.setting)}`;
}

/** The area-limit warning, or null when the area is within it. */
export function areaLimitWarning(e: PeakFlowEstimate): string | null {
  if (!e.ok || !e.aboveAreaLimit) return null;
  return `The catchment is ${(e.areaM2 / 1e6).toFixed(2)} km², above the 0.8 km² (80 ha) the rational method is meant for; read this as indicative only.`;
}

/** The assumptions shown beside every estimate, in the Lab and in the exports. */
export function rationalAssumptions(conditioning: 'raw' | 'priority-flood'): readonly string[] {
  return [
    'Rational method, Q = C × i × A: steady-state peak flow from the contributing area A.',
    'Rain is uniform over the whole catchment and lasts at least its time of concentration, so all of it contributes at once.',
    'C lumps infiltration, storage and every other loss into one coefficient; presets are midpoints of published ranges, not site measurements.',
    conditioning === 'priority-flood'
      ? 'Area comes from D8 single-direction routing over the Priority-Flood-conditioned surface, so depressions are filled and drain through.'
      : 'Area comes from D8 single-direction routing over the raw surface, so flow stops in every depression.',
    'No storage, timing, infiltration model or channel hydraulics; not a flood or water-depth prediction.',
    'Meant for small catchments, roughly under 0.8 km² (80 ha); larger catchments are flagged.',
  ];
}
