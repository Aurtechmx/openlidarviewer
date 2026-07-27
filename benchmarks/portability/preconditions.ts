/**
 * preconditions.ts
 *
 * The facts about a host that have to hold before a cross-platform comparison
 * means anything, and the identifier a platform is filed under.
 *
 * ENDIANNESS IS A PRECONDITION, NOT A RESULT. Several science-scoped artifacts
 * are raw typed-array bytes — the DTM grid, the confidence and coverage planes,
 * the source point cloud. A typed array serialises in the host's byte order, so
 * a little-endian and a big-endian host would produce different bytes for
 * identical numbers. Compared without this check that lands as a science
 * mismatch, which is the wrong finding: the arithmetic agreed and the
 * serialisation did not. Every platform records its byte order, an unsupported
 * one halts the comparison by name, and the claim covers little-endian hosts
 * only because those are the only ones that have been run.
 *
 * Pure. No I/O, no clock, no `node:` builtin — the probe is a typed-array view,
 * so a browser-side runner reaches the same answer.
 */

/** The byte order a host serialises typed arrays in. */
export type Endianness = 'LE' | 'BE';

/** The only byte order the comparison is defined for. See the header. */
export const SUPPORTED_ENDIANNESS: Endianness = 'LE';

/**
 * Read the host's byte order by writing a word and reading back its low byte.
 *
 * `os.endianness()` reports the same thing on Node and is not used, so this
 * module stays runtime-neutral and one implementation answers for both halves
 * of the project.
 */
export function detectEndianness(): Endianness {
  const probe = new Uint16Array([0x0102]);
  return new Uint8Array(probe.buffer)[0] === 0x02 ? 'LE' : 'BE';
}

/** Why a byte order other than little-endian stops the comparison. */
export function unsupportedEndiannessReason(platformId: string, found: Endianness): string {
  return (
    `${platformId} reports ${found} byte order. Several science-scoped artifacts are raw typed-array ` +
    'bytes, which serialise in host order, so a comparison against a little-endian platform would ' +
    'report a science mismatch for a serialisation difference. Cross-platform reproducibility is ' +
    'claimed for little-endian platforms only.'
  );
}

/**
 * The directory name and table key one platform is filed under.
 *
 * Platform and architecture only. The Node version, the CPU model and the OS
 * release are all recorded in the environment block and none of them belong in
 * the key: a second macOS ARM64 leg on a different CPU is the same platform,
 * and folding the model in would file it as a new one and quietly weaken a
 * two-platform comparison into two single-platform ones.
 */
export function platformId(platform: string, arch: string): string {
  const clean = (s: string): string => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const p = clean(platform);
  const a = clean(arch);
  if (p === '' || a === '') {
    throw new Error(
      `benchmark portability: a platform id needs both a platform and an architecture, got ${JSON.stringify(platform)} and ${JSON.stringify(arch)}`,
    );
  }
  return `${p}-${a}`;
}
