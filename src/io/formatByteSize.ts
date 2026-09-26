/**
 * formatByteSize.ts
 *
 * One byte-size formatter for the whole app. Several UI panels (the preload
 * summary, the stage HUD, the batch converter, the debug overlay, the
 * streaming cache readout) each grew their own copy with subtly different
 * bases (1000 vs 1024), precision, and small-value handling — so the same
 * file size could read "12 MB" in one place and "11.8 MB" in another. This is
 * the single source of truth: binary units (1024-based), one decimal from KiB
 * up, whole bytes below, and a floor at zero so a negative never prints.
 *
 * The divisions are 1024-based, so the labels are the IEC binary ones —
 * KiB/MiB/GiB, matching `zipStore.ts`'s existing GiB convention — rather than
 * the decimal (1000-based) KB/MB/GB those letters denote by SI definition.
 *
 * Pure — no DOM, no three.js — unit-tested in Node.
 */

/** Render a byte count compactly: 12_400_000 → "11.8 MiB". */
export function formatByteSize(bytes: number): string {
  const v = Math.max(0, bytes);
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GiB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MiB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KiB`;
  return `${Math.round(v)} B`;
}

/** A byte unit {@link formatBytesIn} can print: decimal (SI) or binary (IEC). */
export type ByteUnit = 'kB' | 'MB' | 'GB' | 'KiB' | 'MiB' | 'GiB';

const BYTES_PER_UNIT: Readonly<Record<ByteUnit, number>> = {
  kB: 1e3,
  MB: 1e6,
  GB: 1e9,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
};

/**
 * Render a byte count in ONE fixed unit, for readouts whose unit must not
 * change with magnitude (a size limit quoted next to the file's size, a
 * benchmark column). The unit name says the base: `MB` is 10^6 bytes, `MiB`
 * is 2^20. `digits = 0` rounds half up, like `Math.round`.
 *
 *   formatBytesIn(12_345_678, 'MB')      → "12.3 MB"
 *   formatBytesIn(40 * 2 ** 20, 'MiB', 0) → "40 MiB"
 */
export function formatBytesIn(bytes: number, unit: ByteUnit, digits = 1): string {
  const v = bytes / BYTES_PER_UNIT[unit];
  return `${digits === 0 ? Math.round(v) : v.toFixed(digits)} ${unit}`;
}

/**
 * Render an integer with thousands separators: 4_200_000 → "4,200,000". The
 * companion count formatter to {@link formatByteSize}, kept here so the overlay
 * and the streaming-diagnostics readout share one grouping rule rather than each
 * carrying a copy. Pure — no DOM, no three.js.
 */
export function groupInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
