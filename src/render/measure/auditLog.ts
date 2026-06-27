/**
 * auditLog.ts
 *
 * A tamper-evident, replayable record of what was done to a dataset and what
 * each measurement claimed.
 *
 * Local-first means the data never leaves the machine — but a surveyor staking
 * their name on a number needs more than privacy: they need to prove the number
 * wasn't quietly changed afterwards. This is an append-only hash chain. Each
 * entry's hash folds in the previous entry's hash plus a CANONICAL (stable
 * key-order) serialization of its own contents, so any later edit to any entry
 * — a reclassification logged with the wrong target class, a volume whose ±
 * band was tampered down — breaks the chain from that point on and
 * {@link verifyAuditChain} reports exactly where.
 *
 * Deterministic by construction: the same sequence of appends always yields the
 * same hashes and the same serialization, so two parties can independently
 * verify they hold the same history.
 *
 * The hash function is injectable. The built-in {@link fnv1a} is a fast,
 * deterministic, NON-cryptographic checksum — it catches accidental corruption
 * and casual edits. For cryptographic tamper-evidence, inject a SHA-256 (e.g.
 * via SubtleCrypto, pre-hashing each body) — the chain logic is hash-agnostic.
 */

export type HashFn = (input: string) => string;

/**
 * Stable, key-sorted serialization so a record's hash never depends on the
 * order its fields happened to be written in. Arrays keep their order
 * (it's meaningful); object keys are sorted.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

/** FNV-1a 32-bit — deterministic, fast, non-cryptographic. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface AuditEntry {
  /** Position in the chain, 0-based. */
  readonly seq: number;
  /** What happened, e.g. 'reclassify' | 'measure.volume' | 'export'. */
  readonly type: string;
  /** The payload — edit details, or a measurement value with its uncertainty. */
  readonly data: unknown;
  /** Chain hash: hashFn(prevHash + canonical({seq,type,data})). */
  readonly hash: string;
}

const GENESIS = '0';

export class AuditLog {
  private readonly _entries: AuditEntry[] = [];
  private readonly _hashFn: HashFn;

  constructor(hashFn: HashFn = fnv1a) {
    this._hashFn = hashFn;
  }

  /** Append a record and return it. The chain head advances to its hash. */
  append(type: string, data: unknown): AuditEntry {
    const seq = this._entries.length;
    const prev = seq === 0 ? GENESIS : this._entries[seq - 1].hash;
    const hash = this._hashFn(prev + '|' + canonicalize({ seq, type, data }));
    const entry: AuditEntry = { seq, type, data, hash };
    this._entries.push(entry);
    return entry;
  }

  get entries(): ReadonlyArray<AuditEntry> {
    return this._entries;
  }

  /** The current chain head hash (or the genesis sentinel when empty). */
  get head(): string {
    return this._entries.length === 0 ? GENESIS : this._entries[this._entries.length - 1].hash;
  }

  /** Deterministic, canonical serialization of the whole log for export. */
  serialize(): string {
    return canonicalize({ version: 1, entries: this._entries });
  }
}

/**
 * Recompute the chain over `entries` and return the index of the FIRST entry
 * that is out of order or whose hash doesn't match — i.e. the first point of
 * tampering or corruption. Returns -1 when the chain is fully intact.
 */
export function verifyAuditChain(
  entries: ReadonlyArray<AuditEntry>,
  hashFn: HashFn = fnv1a,
): number {
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq !== i) return i;
    const expect = hashFn(prev + '|' + canonicalize({ seq: e.seq, type: e.type, data: e.data }));
    if (expect !== e.hash) return i;
    prev = e.hash;
  }
  return -1;
}
