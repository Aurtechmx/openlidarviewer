/**
 * layerIdentity.ts — stable, name-independent identity for a loaded layer.
 *
 * A layer's identity must NOT be its filename or its display label. Two scans
 * dropped under the same name are two layers; a layer the user renames is the
 * same layer; a scan closed and reopened is the same layer. None of that is
 * expressible if identity is a name, so this module assigns each layer a
 * generated `layerId` and carries the display name as a SEPARATE field on the
 * record.
 *
 * Reopen stability is anchored on the source FINGERPRINT — the same spatial
 * facts the session matcher already uses (filename, source point count, extent
 * spans, CRS). A reopened scan whose fingerprint matches one the registry has
 * seen reuses that scan's id; anything else gets a fresh one. The fingerprint
 * is a source fact, never inferred from coordinates in the render frame.
 *
 * Pure: no DOM, no three.js, no viewer. The running app owns one registry and
 * feeds it plain fingerprint records; the id it hands back is what the session
 * persists.
 */

/**
 * The source facts a layer id is anchored on. A structural subset of the
 * session's {@link ScanFacts}, so the same fingerprint the scan matcher builds
 * can key the registry directly. Every field is optional because a raw drop may
 * declare only some of them; the key is built from whatever is present.
 */
export interface LayerFingerprint {
  /** Source file display name — part of the fingerprint, NOT the identity. */
  readonly fileName?: string;
  /** Source point count. */
  readonly sourcePoints?: number;
  /** Source extent spans, in the source's own units. */
  readonly width?: number;
  readonly depth?: number;
  readonly height?: number;
  /** CRS label, when known. */
  readonly crs?: string;
  /** Horizontal EPSG code, when known. */
  readonly epsg?: number;
  /**
   * The file's absolute source origin. Two tiles of one survey routinely share
   * a name, a point count and spans; their position is what tells them apart.
   */
  readonly origin?: readonly [number, number, number];
  /** SHA-256 of the source bytes, when known. */
  readonly sha256?: string;
}

/** A layer's identity record: the stable id, its display name, its source key. */
export interface LayerRecord {
  /** Generated, stable identity. Never derived from a name or filename. */
  readonly layerId: string;
  /** The mutable display label — separate from identity, renameable freely. */
  readonly displayName: string;
  /** Canonical source-fingerprint key this id is anchored on. */
  readonly fingerprint: string;
}

export interface LayerIdentityRegistryOptions {
  /** Override the id generator (tests inject a deterministic counter). */
  readonly generateId?: () => string;
}

/** Round an extent span so trivial float formatting never splits one fingerprint. */
function normSpan(v: number | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  // 6 decimals is finer than any real survey extent needs and coarse enough to
  // absorb the last-bit noise of a recomputed bound.
  return v.toFixed(6);
}

/**
 * Build the canonical, order-stable key for a fingerprint. Filename is included
 * as a source fact — but because it rides alongside the content-distinguishing
 * fields (point count and extent spans), two different scans sharing a name
 * still key apart, and only genuinely identical source facts collide (which is
 * exactly the reopen-stability case).
 */
export function fingerprintKey(f: LayerFingerprint): string {
  const key = legacyFingerprintKey(f);
  const o = f.origin;
  const pos = o && o.every((c) => Number.isFinite(c)) ? o.map((c) => c.toFixed(3)).join(',') : '';
  const sha = (f.sha256 ?? '').trim().toLowerCase();
  if (!pos && !sha) return key;
  return [key, 'o', pos, sha].join('\0');
}

/** True when the fingerprint carries a position or a content digest. */
export function hasPlacementFacts(f: LayerFingerprint): boolean {
  return fingerprintKey(f) !== legacyFingerprintKey(f);
}

/**
 * The key built from the facts older session files stored: name, count, spans
 * and CRS, without position or digest. Used to match such a file, and only
 * where the match is unambiguous.
 */
export function legacyFingerprintKey(f: LayerFingerprint): string {
  return [
    'f',
    (f.fileName ?? '').trim(),
    typeof f.sourcePoints === 'number' && Number.isFinite(f.sourcePoints)
      ? String(f.sourcePoints)
      : '',
    normSpan(f.width),
    normSpan(f.depth),
    normSpan(f.height),
    typeof f.epsg === 'number' && Number.isFinite(f.epsg) ? String(f.epsg) : '',
    (f.crs ?? '').trim(),
  ].join('\0');
}

/** Monotonic counter for the last-resort id path (no WebCrypto at all). */
let fallbackCounter = 0;

/** Generate a fresh, name-independent layer id. */
export function newLayerId(): string {
  const c = (
    globalThis as {
      crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array };
    }
  ).crypto;
  if (c && typeof c.randomUUID === 'function') return `layer_${c.randomUUID()}`;
  // WebCrypto without randomUUID (older engines): build the id from secure
  // random bytes. Not Math.random: a layer id is an internal handle, but weak
  // randomness for identity material is worth avoiding regardless.
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16));
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return `layer_${hex}`;
  }
  // Last resort with no WebCrypto: monotonic time plus a session-local counter.
  // Unique within a session and name-independent by construction; never a secret.
  return `layer_${Date.now().toString(36)}_${(fallbackCounter++).toString(36)}`;
}

/**
 * Assigns and remembers stable layer ids. One instance per running app owns the
 * mapping; it keeps two things:
 *   • a fingerprint→id MEMORY that survives layer removal, so a reopened scan
 *     with a matching fingerprint gets its old id back;
 *   • the live records keyed by id, for rename and lookup.
 */
export class LayerIdentityRegistry {
  private readonly byFingerprint = new Map<string, string>();
  private readonly records = new Map<string, LayerRecord>();
  private readonly gen: () => string;

  constructor(options: LayerIdentityRegistryOptions = {}) {
    this.gen = options.generateId ?? newLayerId;
  }

  /**
   * Resolve the id for a layer being loaded. Reuses the id last bound to this
   * fingerprint (reopen), otherwise generates a fresh one and remembers it.
   * An id a live record still holds is never handed out again: a second open
   * layer with the same fingerprint gets a fresh id.
   */
  resolve(fingerprint: LayerFingerprint, displayName: string): LayerRecord {
    const key = fingerprintKey(fingerprint);
    let layerId = this.byFingerprint.get(key);
    if (layerId === undefined) {
      layerId = this.gen();
      this.byFingerprint.set(key, layerId);
    } else if (this.records.has(layerId)) {
      // The remembered id is in use; the key keeps pointing at it for a reopen.
      layerId = this.gen();
    }
    const record: LayerRecord = { layerId, displayName, fingerprint: key };
    this.records.set(layerId, record);
    return record;
  }

  /**
   * Adopt an id carried in from a session import, binding it to that session's
   * fingerprint so a later reopen of the same scan reuses it rather than
   * minting a new one. The id is remembered, not live: no layer holds it
   * until that scan is opened.
   */
  adopt(layerId: string, fingerprint: LayerFingerprint, displayName: string): LayerRecord {
    const key = fingerprintKey(fingerprint);
    this.byFingerprint.set(key, layerId);
    return { layerId, displayName, fingerprint: key };
  }

  /** Change a layer's display label. Identity is untouched. */
  rename(layerId: string, displayName: string): LayerRecord | null {
    const prev = this.records.get(layerId);
    if (!prev) return null;
    const record: LayerRecord = { ...prev, displayName };
    this.records.set(layerId, record);
    return record;
  }

  /**
   * Drop the live record for a closed layer. The fingerprint→id memory is kept
   * on purpose, so reopening the same scan recovers its id.
   */
  remove(layerId: string): void {
    this.records.delete(layerId);
  }

  /** The live record for an id, or null. */
  get(layerId: string): LayerRecord | null {
    return this.records.get(layerId) ?? null;
  }
}
