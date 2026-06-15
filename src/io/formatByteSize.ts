/**
 * formatByteSize.ts
 *
 * One byte-size formatter for the whole app. Several UI panels (the preload
 * summary, the stage HUD, the batch converter, the debug overlay, the
 * streaming cache readout) each grew their own copy with subtly different
 * bases (1000 vs 1024), precision, and small-value handling — so the same
 * file size could read "12 MB" in one place and "11.8 MB" in another. This is
 * the single source of truth: binary units (1024-based), one decimal from KB
 * up, whole bytes below, and a floor at zero so a negative never prints.
 *
 * Pure — no DOM, no three.js — unit-tested in Node.
 */

/** Render a byte count compactly: 12_400_000 → "11.8 MB". */
export function formatByteSize(bytes: number): string {
  const v = Math.max(0, bytes);
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${Math.round(v)} B`;
}
