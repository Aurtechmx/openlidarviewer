/**
 * layerHealth.ts — the facts behind "why can (or can't) these layers interact".
 *
 * Pure builders, no DOM. The app already knows everything this module says —
 * the compatibility classification (`layerCompatibility.ts`), the mount
 * precision gate (`LayerService.mountPrecision`), the frame transform
 * (`projectFrame.transformFor`) — but each fact surfaces in a different corner
 * of the UI, so a user watching a layer sit out of combined results has to
 * reconstruct the reason from tooltips. This assembles the per-layer facts
 * into readable rows and the cross-layer facts into a pass/fail report.
 *
 * Two rules govern every string produced here:
 *
 *  - Fail closed. An absent fact reads "unknown" or "not established" —
 *    never a default, never a borrowed value. Specifically, the vertical
 *    unit does not inherit the horizontal one, and a missing origin is
 *    "not declared" rather than zero.
 *  - No unearned claims. The words "accurate", "precise", "certified",
 *    "survey-grade" and "professional" are quality assertions the geometry
 *    has not been measured against, so they never appear; the test suite
 *    asserts the ban over every producible string.
 */

/** Row severity: `ok` = established, `warn` = doubt gates something, `info` = neutral fact. */
export type LayerHealthStatus = 'ok' | 'warn' | 'info';

/** Mirrors `LayerCompatibility` in `src/model/layerCompatibility.ts`; `null` = unclassified. */
export type LayerHealthCompatibility =
  | 'verified'
  | 'horizontal-only'
  | 'unknown'
  | 'incompatible';

/**
 * The facts the caller supplies per layer. Everything is explicit — the
 * builder derives nothing, so a wrong row is always a wrong input, findable
 * at the call site.
 */
export interface LayerHealthInput {
  /** Display name (file name); used only as a heading by the card. */
  readonly name: string;
  /** Resolved CRS display name, or null when none was established. */
  readonly crsName: string | null;
  /** Where the CRS came from (`'las-vlr'`, `'user-override'`, …), or null. */
  readonly crsSource: string | null;
  /** Horizontal linear unit name ('metre', 'foot', …), or null = undeclared. */
  readonly horizontalUnit: string | null;
  /** Vertical unit name. Null = undeclared — it never borrows the horizontal. */
  readonly verticalUnit: string | null;
  /** Vertical datum label ('NAVD88', …), or null when none was declared. */
  readonly verticalDatum: string | null;
  /** The four-state classification, or null when not yet classified. */
  readonly compatibility: LayerHealthCompatibility | null;
  /** Whether the layer is genuinely IN the project frame (not merely eligible). */
  readonly mounted: boolean;
  /** The FILE's declared origin in source-CRS units, or null (no georeference). */
  readonly sourceOrigin: readonly [number, number, number] | null;
  /** source→project translation when the layer is in a frame, else null. */
  readonly frameOffset: readonly [number, number, number] | null;
  /** Mount-precision estimate in millimetres; null = not applicable/unknown. */
  readonly precisionMm: number | null;
  /** True when this is the only loaded layer — it anchors its own frame. */
  readonly soleLayer?: boolean;
  /** What the precision figure is grounded in, or null when none exists. */
  readonly precisionBasis: 'projected-linear-unit' | 'geographic' | 'unknown' | null;
  /** True while the layer streams (partial residency). */
  readonly streaming: boolean;
}

/** One rendered fact. `mono` marks numeric values (coordinates, offsets, mm). */
export interface LayerHealthRow {
  readonly label: string;
  readonly value: string;
  readonly status: LayerHealthStatus;
  readonly mono?: boolean;
}

/** Input to the cross-layer report — one entry per loaded layer. */
export interface CompatibilityReportLayer {
  readonly name: string;
  readonly compatibility: LayerHealthCompatibility | null;
  readonly verticalDatumKnown: boolean;
}

export interface CompatibilityReportLine {
  readonly text: string;
  readonly status: LayerHealthStatus;
}

export interface CompatibilityReport {
  readonly lines: CompatibilityReportLine[];
  /** One plain sentence stating what the layers can do together. */
  readonly verdict: string;
}

/** Human labels for the `CrsSource` union (`src/geo/CoordinateTypes.ts`). */
const CRS_SOURCE_LABELS: Readonly<Record<string, string>> = {
  'las-vlr': 'file header',
  'copc-meta': 'COPC metadata',
  'ept-srs': 'EPT metadata',
  'catalog-tile': 'catalog',
  'user-override': 'user override',
  override: 'user override',
  'default-assumption': 'assumed default',
};

/**
 * Compatibility, stated with its consequence. The state word alone tells a
 * user nothing about what the app will DO; the clause after the dash is the
 * behaviour they are watching, so the row explains rather than labels.
 */
function compatibilityRow(
  c: LayerHealthCompatibility | null,
  soleLayer: boolean,
): LayerHealthRow {
  const label = 'Compatibility';
  switch (c) {
    case 'verified':
      // A lone layer is verified by construction — it IS the frame, so it
      // shares nothing with a project it defines. Saying "shares the project
      // vertical reference" beside an undeclared datum reads as a claim it is
      // not making. Multi-layer verified genuinely shares a common frame.
      return {
        label,
        value: soleLayer
          ? 'verified — single layer, self-consistent on its own frame'
          : 'verified — shares the project horizontal and vertical reference',
        status: 'ok',
      };
    case 'horizontal-only':
      return {
        label,
        value: 'horizontal-only — placed in plan, keeps its own heights',
        status: 'warn',
      };
    case 'unknown':
      return {
        label,
        value: 'unknown — no declared CRS, a shared frame is not established',
        status: 'warn',
      };
    case 'incompatible':
      return {
        label,
        value: 'incompatible — a different frame, kept where its file put it',
        status: 'warn',
      };
    case null:
      return { label, value: 'not established', status: 'info' };
  }
}

/**
 * Millimetre formatting: two decimals below a millimetre (the budget lives
 * down there), one decimal at and above it. "0.02 mm" / "1.0 mm".
 */
function formatMm(mm: number): string {
  return mm < 1 ? `${mm.toFixed(2)} mm` : `${mm.toFixed(1)} mm`;
}

/**
 * The precision row never converts its way past a missing fact. A geographic
 * basis is not formatted in millimetres at all — a degree is not a length,
 * so the honest readout is that no linear budget exists (this is the same
 * refusal `mountPrecision` makes in LayerService).
 */
function precisionRow(
  mm: number | null,
  basis: LayerHealthInput['precisionBasis'],
  identityPlacement: boolean,
): LayerHealthRow {
  const label = 'Mount precision';
  // No offset applied, no precision spent — a self-anchored layer sits on its
  // own origin. This precedes the units check: "unknown — units not declared"
  // describes the cost of a mount that is not happening.
  if (identityPlacement) {
    return { label, value: 'not applicable — no offset applied', status: 'info' };
  }
  if (basis === 'geographic') {
    return { label, value: 'no linear budget (degrees)', status: 'warn' };
  }
  if (basis === 'unknown') {
    return { label, value: 'unknown — units not declared', status: 'warn' };
  }
  if (mm === null || !Number.isFinite(mm)) {
    return { label, value: 'not applicable', status: 'info' };
  }
  // The 1 mm ceiling is REBASE_QUANTUM_BUDGET_M (LayerService.ts) in mm:
  // inside it a mount preserves the measurement, past it the gate refuses.
  return { label, value: formatMm(mm), status: mm <= 1 ? 'ok' : 'warn', mono: true };
}

/** Plain coordinate formatting — at most two decimals, trailing zeros dropped. */
function coord(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, '').replace(/\.0$/, '');
}

/** Signed form for offsets, so a zero component still reads as a delta. */
function signedCoord(n: number): string {
  const s = coord(Math.abs(n));
  return n < 0 ? `-${s}` : `+${s}`;
}

/**
 * The per-layer fact rows, in reading order: identity of the frame first
 * (CRS, units, datum), then the relationship to the project (compatibility,
 * membership, geometry of the mount), then residency.
 */
export function buildLayerHealth(input: LayerHealthInput): LayerHealthRow[] {
  const rows: LayerHealthRow[] = [];

  if (input.crsName === null) {
    rows.push({ label: 'Coordinate system', value: 'not established', status: 'warn' });
  } else {
    const source = input.crsSource
      ? ` (${CRS_SOURCE_LABELS[input.crsSource] ?? input.crsSource})`
      : '';
    rows.push({ label: 'Coordinate system', value: `${input.crsName}${source}`, status: 'ok' });
  }

  rows.push(
    input.horizontalUnit === null
      ? { label: 'Horizontal unit', value: 'unknown', status: 'warn' }
      : { label: 'Horizontal unit', value: input.horizontalUnit, status: 'ok' },
  );
  // The vertical unit is its own declaration. Borrowing the horizontal one
  // here would repeat, in words, the unit bug the precision gate exists to
  // refuse in numbers.
  rows.push(
    input.verticalUnit === null
      ? { label: 'Vertical unit', value: 'unknown', status: 'warn' }
      : { label: 'Vertical unit', value: input.verticalUnit, status: 'ok' },
  );
  rows.push(
    input.verticalDatum === null
      ? { label: 'Vertical datum', value: 'not established', status: 'warn' }
      : { label: 'Vertical datum', value: input.verticalDatum, status: 'ok' },
  );

  rows.push(compatibilityRow(input.compatibility, input.soleLayer ?? false));

  rows.push(
    (input.soleLayer ?? false)
      // One layer has nothing to combine WITH, so "eligible for combined
      // results" overstates — the compatibility report says the same in its
      // "cross-layer comparison does not apply" line. Keep the two agreeing.
      ? {
          label: 'Project frame',
          value: 'single layer — analysed on its own frame, nothing to combine',
          status: 'info',
        }
      : input.mounted
        ? {
            label: 'Project frame',
            value: 'mounted — eligible for combined results',
            status: 'ok',
          }
        : {
            label: 'Project frame',
            value: 'not mounted — kept in its own frame, excluded from combined results',
            status: 'info',
          },
  );

  rows.push(
    input.sourceOrigin === null
      ? { label: 'Source origin', value: 'not declared', status: 'info' }
      : {
          label: 'Source origin',
          value: input.sourceOrigin.map(coord).join(', '),
          status: 'ok',
          mono: true,
        },
  );

  rows.push(
    input.frameOffset === null
      ? { label: 'Offset to project', value: 'none — not in a shared frame', status: 'info' }
      : {
          label: 'Offset to project',
          value: input.frameOffset.map(signedCoord).join(', '),
          status: 'ok',
          mono: true,
        },
  );

  const identityPlacement =
    input.frameOffset === null ||
    (input.frameOffset[0] === 0 && input.frameOffset[1] === 0 && input.frameOffset[2] === 0);
  rows.push(precisionRow(input.precisionMm, input.precisionBasis, identityPlacement));

  rows.push(
    input.streaming
      ? {
          label: 'Loading',
          value: 'streaming — resident detail refines as tiles load',
          status: 'info',
        }
      : { label: 'Loading', value: 'fully loaded', status: 'ok' },
  );

  return rows;
}

/**
 * The cross-layer pass/fail summary. Lines are per-axis (one horizontal, one
 * vertical) plus one named line per layer that breaks the horizontal frame,
 * so the report reads as a checklist rather than prose. The verdict is a
 * single sentence stating what the set can do together — never how well.
 */
export function buildCompatibilityReport(
  layers: readonly CompatibilityReportLayer[],
): CompatibilityReport {
  if (layers.length === 0) {
    return { lines: [], verdict: 'No layers loaded.' };
  }
  if (layers.length === 1) {
    return { lines: [], verdict: 'One layer loaded — cross-layer comparison does not apply.' };
  }

  const lines: CompatibilityReportLine[] = [];
  const horizontallyAligned = (c: LayerHealthCompatibility | null): boolean =>
    c === 'verified' || c === 'horizontal-only';
  const allHorizontal = layers.every((l) => horizontallyAligned(l.compatibility));
  const allVerified = layers.every((l) => l.compatibility === 'verified');
  const allDatumsKnown = layers.every((l) => l.verticalDatumKnown);

  if (allHorizontal) {
    lines.push({ text: '✓ Shared horizontal reference — layers overlay in plan', status: 'ok' });
  } else {
    // Name each layer that breaks the horizontal frame; a summary "some
    // layers differ" would put the user right back to guessing which.
    for (const l of layers) {
      if (horizontallyAligned(l.compatibility)) continue;
      lines.push(
        l.compatibility === 'incompatible'
          ? {
              text: `✗ ${l.name}: different coordinate frame — excluded from combined results`,
              status: 'warn',
            }
          : {
              text: `✗ ${l.name}: no declared CRS — compatibility not established`,
              status: 'warn',
            },
      );
    }
  }

  if (allVerified && allDatumsKnown) {
    lines.push({ text: '✓ Shared vertical reference — heights comparable', status: 'ok' });
  } else if (!allDatumsKnown) {
    lines.push({ text: '✗ Vertical datum unknown — vertical comparison disabled', status: 'warn' });
  } else {
    lines.push({
      text: '✗ Vertical references not proven to match — vertical comparison disabled',
      status: 'warn',
    });
  }

  const verdict =
    allVerified && allDatumsKnown
      ? 'These layers share one established reference, so plan and height results can be combined.'
      : allHorizontal
        ? 'These layers overlay in plan only; each keeps its own heights until a shared vertical reference is established.'
        : 'Not every layer has an established frame, so combined results exclude the unproven ones.';

  return { lines, verdict };
}
