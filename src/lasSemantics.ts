/**
 * lasSemantics.ts: the one source of ASPRS/LAS point semantics.
 *
 * Class names, classification flags and conversion safety were previously
 * decided independently in eight modules, and they disagreed: the point
 * inspector named class 12 "Overlap" for every format while the export legend
 * named it "Reserved (12)", and the legend called every code at or above 19
 * user-defined. Both cannot be right, and under the extended formats neither
 * is. Class 12 is Overlap Points only in the legacy point formats; from format
 * 6 the code is reserved and overlap moved to a dedicated flag bit.
 *
 * Nothing here imports anything. Decoders, renderers, panels, legends and
 * writers all read semantics from this module so a correction lands once.
 */

/** Point Data Record Format. Formats 6 and above carry extended semantics. */
export type Pdrf = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/** The first PDRF whose classification field is a full byte. */
export const FIRST_EXTENDED_PDRF = 6;

/** Highest code the legacy 5-bit classification field can carry. */
export const LEGACY_MAX_CLASS = 31;

export function isExtendedPdrf(pdrf: number): boolean {
  return pdrf >= FIRST_EXTENDED_PDRF;
}

export function isValidPdrf(pdrf: number): pdrf is Pdrf {
  return Number.isInteger(pdrf) && pdrf >= 0 && pdrf <= 10;
}

/**
 * Legacy classification table (point formats 0 to 5), as LAS 1.1 to 1.3 define
 * it. Code 12 is Overlap Points here, and 8 is Model Key-point.
 */
const LEGACY_CLASS_NAMES: Readonly<Record<number, string>> = {
  0: 'Created, Never Classified',
  1: 'Unclassified',
  2: 'Ground',
  3: 'Low Vegetation',
  4: 'Medium Vegetation',
  5: 'High Vegetation',
  6: 'Building',
  7: 'Low Point (Noise)',
  8: 'Model Key-point',
  9: 'Water',
  10: 'Reserved',
  11: 'Reserved',
  12: 'Overlap Points',
};

/**
 * Extended classification table (point formats 6 to 10). Code 12 is reserved;
 * overlap is the dedicated flag, not a class. Codes 19 to 22 are named, so a
 * viewer must not report them as user-defined.
 */
const EXTENDED_CLASS_NAMES: Readonly<Record<number, string>> = {
  0: 'Created, Never Classified',
  1: 'Unclassified',
  2: 'Ground',
  3: 'Low Vegetation',
  4: 'Medium Vegetation',
  5: 'High Vegetation',
  6: 'Building',
  7: 'Low Point (Noise)',
  8: 'Reserved',
  9: 'Water',
  10: 'Rail',
  11: 'Road Surface',
  12: 'Reserved',
  13: 'Wire - Guard (Shield)',
  14: 'Wire - Conductor (Phase)',
  15: 'Transmission Tower',
  16: 'Wire-Structure Connector',
  17: 'Bridge Deck',
  18: 'High Noise',
  19: 'Overhead Structure',
  20: 'Ignored Ground',
  21: 'Snow',
  22: 'Temporal Exclusion',
};

/** Lowest code in the user-definable range of the extended table. */
export const FIRST_USER_DEFINABLE_CLASS = 64;

/** How a classification code is allocated by the specification. */
export type ClassAllocation = 'defined' | 'reserved' | 'user-definable';

export function classAllocation(code: number, pdrf: number): ClassAllocation {
  if (!isExtendedPdrf(pdrf)) {
    return code in LEGACY_CLASS_NAMES ? 'defined' : 'reserved';
  }
  if (code >= FIRST_USER_DEFINABLE_CLASS) return 'user-definable';
  const name = EXTENDED_CLASS_NAMES[code];
  return name !== undefined && name !== 'Reserved' ? 'defined' : 'reserved';
}

/**
 * The name for a classification code under the format that carries it.
 *
 * The PDRF is required rather than optional. A caller that does not know the
 * format cannot name code 12 correctly, and defaulting would reintroduce the
 * disagreement this module exists to remove.
 */
export function classificationName(code: number, pdrf: number): string {
  if (!Number.isInteger(code) || code < 0 || code > 255) return `Invalid (${code})`;
  const table = isExtendedPdrf(pdrf) ? EXTENDED_CLASS_NAMES : LEGACY_CLASS_NAMES;
  const name = table[code];
  if (name !== undefined) return name;
  if (classAllocation(code, pdrf) === 'user-definable') return `User definable (${code})`;
  return `Reserved (${code})`;
}

/** Classification flags carried beside the class code. */
export interface ClassificationFlags {
  synthetic: boolean;
  keyPoint: boolean;
  withheld: boolean;
  /** Extended formats only. Legacy files express overlap as class 12. */
  overlap: boolean;
}

export const NO_FLAGS: Readonly<ClassificationFlags> = Object.freeze({
  synthetic: false,
  keyPoint: false,
  withheld: false,
  overlap: false,
});

/** Bit positions of the flags inside the legacy classification byte. */
const LEGACY_SYNTHETIC_BIT = 0x20;
const LEGACY_KEY_POINT_BIT = 0x40;
const LEGACY_WITHHELD_BIT = 0x80;

/**
 * Split a legacy classification byte into its class and flags.
 *
 * In formats 0 to 5 the byte is the class in bits 0 to 4 with three flags
 * above it, so masking the byte with 0x1f to "get the class" also erases
 * Synthetic, Key-point and Withheld.
 */
export function decodeLegacyClassificationByte(byte: number): {
  code: number;
  flags: ClassificationFlags;
} {
  return {
    code: byte & 0x1f,
    flags: {
      synthetic: (byte & LEGACY_SYNTHETIC_BIT) !== 0,
      keyPoint: (byte & LEGACY_KEY_POINT_BIT) !== 0,
      withheld: (byte & LEGACY_WITHHELD_BIT) !== 0,
      overlap: (byte & 0x1f) === 12,
    },
  };
}

/** Rebuild a legacy classification byte from a class and its flags. */
export function encodeLegacyClassificationByte(
  code: number,
  flags: Partial<ClassificationFlags> = {},
): number {
  let byte = code & 0x1f;
  if (flags.synthetic) byte |= LEGACY_SYNTHETIC_BIT;
  if (flags.keyPoint) byte |= LEGACY_KEY_POINT_BIT;
  if (flags.withheld) byte |= LEGACY_WITHHELD_BIT;
  return byte;
}

/**
 * How a class and its flags read to a person: the base class, with any
 * overlap shown beside it rather than replacing it.
 */
export function describeClassification(
  code: number,
  pdrf: number,
  flags: Readonly<ClassificationFlags> = NO_FLAGS,
): string {
  const base = classificationName(code, pdrf);
  const marks: string[] = [];
  if (flags.overlap) marks.push('Overlap');
  if (flags.synthetic) marks.push('Synthetic');
  if (flags.keyPoint) marks.push('Key-point');
  if (flags.withheld) marks.push('Withheld');
  return marks.length === 0 ? base : `${base} · ${marks.join(' · ')}`;
}

/** What a conversion to the legacy encoding would lose. */
export interface LossyConversion {
  /** Codes that do not fit the 5-bit field and would wrap to another class. */
  wrappingCodes: number[];
  /** True when the source carries overlap as a flag, which legacy cannot hold. */
  losesOverlapFlag: boolean;
}

export function canRepresentInLegacy(code: number): boolean {
  return Number.isInteger(code) && code >= 0 && code <= LEGACY_MAX_CLASS;
}

/**
 * Inspect a set of classes for a legacy write.
 *
 * A code above 31 does not merely fail to fit. Masked into five bits it lands
 * on another valid class, so Ignored Ground (20) stays 20 while a user class
 * at 64 reads as Created, Never Classified. The caller refuses by default and
 * reports this rather than writing a file that looks well formed.
 */
export function inspectLegacyConversion(
  codes: Iterable<number>,
  anyOverlapFlag = false,
): LossyConversion {
  const wrapping = new Set<number>();
  for (const code of codes) {
    if (!canRepresentInLegacy(code)) wrapping.add(code);
  }
  return {
    wrappingCodes: [...wrapping].sort((a, b) => a - b),
    losesOverlapFlag: anyOverlapFlag,
  };
}

export function isLossy(conversion: LossyConversion): boolean {
  return conversion.wrappingCodes.length > 0 || conversion.losesOverlapFlag;
}

/** A sentence naming exactly what a lossy legacy write would drop. */
export function describeLoss(conversion: LossyConversion, pdrf: number): string {
  const parts: string[] = [];
  if (conversion.wrappingCodes.length > 0) {
    const named = conversion.wrappingCodes
      .map((c) => `${c} (${classificationName(c, pdrf)})`)
      .join(', ');
    parts.push(`classes ${named} do not fit the 5-bit legacy field and would read as another class`);
  }
  if (conversion.losesOverlapFlag) {
    parts.push('the overlap flag has no legacy representation beside a base class');
  }
  return parts.join('; ');
}
