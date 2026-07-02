/**
 * declaredCapture.ts
 *
 * Scans a cloud's declared source metadata for a capture statement the
 * capture-type classifier must honour. Runs at LOAD time inside the (lazy)
 * loader chunk — never in the startup shell — and stores its result on
 * `CloudMetadata.declaredCapture`, which the eager classifier wiring reads
 * as a plain field. Keeping the keyword scan here (rather than in
 * `provenanceSignals.ts`) keeps the index bundle flat.
 */

/** The declared metadata shape this helper consumes (see `SourceMetadata`). */
export interface DeclaredFieldsLike {
  readonly standard: readonly { readonly name: string; readonly value: string }[];
  readonly extensions: readonly { readonly name: string; readonly value: string }[];
}

/**
 * The file's own capture statement plus its PRE-BUILT display strings. The
 * strings are composed here — in the lazy loader chunk — so the classifier
 * in the startup shell only threads them through; the honesty wording costs
 * the eager bundle nothing.
 */
export interface DeclaredCapture {
  /** Which declared field the quoted value comes from, e.g. "sensorModel". */
  readonly field: string;
  /** The declared value, verbatim. */
  readonly value: string;
  /** Verdict headline: `Declared: <value> (from file metadata)`. */
  readonly label: string;
  /** Signals line quoting the declaration with the not-verified disclosure. */
  readonly signal: string;
  /** Standing disclaimer for the declared verdict. */
  readonly disclaimer: string;
}

/**
 * Declared fields that may state what the scan IS, and the keyword set that
 * marks a non-physical (synthetic / procedural / reconstruction / reference)
 * origin. Case-insensitive substring match — deliberately broad, because
 * asserting a physical capture type over a file that declares itself
 * synthetic is the worse failure mode.
 */
const DECLARED_CAPTURE_FIELDS = [
  'sensorModel',
  'datasetType',
  'accuracyClass',
  'description',
  'name',
] as const;
const SYNTHETIC_KEYWORDS = /synthetic|procedural|reconstruction|reference/i;

/**
 * Returns the declared capture statement to QUOTE (sensorModel preferred,
 * then datasetType, then whichever field matched) when any candidate field
 * carries a synthetic/procedural/reconstruction/reference keyword — or
 * undefined, which leaves the classifier's heuristics unchanged.
 */
export function declaredCaptureFromSourceMetadata(
  sourceMetadata: DeclaredFieldsLike | undefined,
): DeclaredCapture | undefined {
  if (!sourceMetadata) return undefined;
  const all = [...sourceMetadata.standard, ...sourceMetadata.extensions];
  const valueOf = (name: string): string | undefined =>
    all.find((f) => f.name === name && f.value.trim().length > 0)?.value;
  const matched = DECLARED_CAPTURE_FIELDS.find((name) => {
    const v = valueOf(name);
    return v !== undefined && SYNTHETIC_KEYWORDS.test(v);
  });
  if (!matched) return undefined;
  // Quote the most specific declaration: sensorModel, then datasetType,
  // then the field that actually matched.
  let field: string = matched;
  for (const preferred of ['sensorModel', 'datasetType'] as const) {
    if (valueOf(preferred) !== undefined) {
      field = preferred;
      break;
    }
  }
  const value = valueOf(field) as string;
  return {
    field,
    value,
    label: `Declared: ${value} (from file metadata)`,
    signal:
      `Declared ${field}: "${value}" — declared by the file, ` +
      `not verified by OpenLiDARViewer`,
    disclaimer:
      'Quoted verbatim from the file\'s own metadata — declared by the ' +
      'file, not verified by OpenLiDARViewer. No literature accuracy ' +
      'ranges apply to a declared synthetic / reference source.',
  };
}
