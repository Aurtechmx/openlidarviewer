/**
 * profileSectionSnapshot.ts
 *
 * What a section was taken from, and whether that was all of it.
 *
 * A static cloud is entirely in memory, so a section over one is complete by
 * construction. A streaming cloud is not: only the resident nodes exist, and
 * the set changes as the scheduler loads and evicts. A section taken from it
 * is a snapshot of that moment, and saying so is the difference between a
 * measurement and a number.
 *
 * Pure. No viewer, no scheduler, no DOM. The host supplies which sources are
 * eligible and which nodes are resident; this decides the order they are read
 * in, what the result may claim, and whether a completed extraction is still
 * the one the user asked for.
 */

/** What a section was able to read. */
export type ProfileSectionScope =
  | 'full-static-source'
  | 'mixed-full-and-resident'
  | 'resident-snapshot'
  | 'empty';

/** One resident streaming node offered to a section. */
export interface ResidentNodeRef {
  /**
   * Stable octree key, `depth-x-y-z`.
   *
   * Identity comes from the key rather than from arrival, because the map the
   * scheduler fills is populated in decode order and that depends on the
   * network.
   */
  readonly key: string;
  readonly pointCount: number;
}

/** What the host knows about a streaming source's node coverage. */
export interface StreamingCoverage {
  /**
   * Nodes the source is known to contain, when the hierarchy has been read
   * far enough to say. Null means the count is not known.
   */
  readonly knownNodeCount: number | null;
  /** Nodes currently resident. */
  readonly residentNodeCount: number;
}

const KEY_PATTERN = /^(\d+)-(\d+)-(\d+)-(\d+)$/;

/**
 * Order resident nodes for a deterministic read.
 *
 * Sorted by depth, then x, then y, then z, parsed as numbers so `10-...`
 * follows `9-...` instead of preceding it as a string compare would. A key
 * that does not parse sorts after every key that does, by its own text, so a
 * source using another scheme still reads in a fixed order rather than in
 * arrival order.
 */
export function orderResidentNodes(nodes: readonly ResidentNodeRef[]): ResidentNodeRef[] {
  const parsed = nodes.map((n) => {
    const m = KEY_PATTERN.exec(n.key);
    return {
      node: n,
      ok: m !== null,
      d: m ? Number(m[1]) : 0,
      x: m ? Number(m[2]) : 0,
      y: m ? Number(m[3]) : 0,
      z: m ? Number(m[4]) : 0,
    };
  });
  parsed.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    if (!a.ok) return a.node.key < b.node.key ? -1 : a.node.key > b.node.key ? 1 : 0;
    return a.d - b.d || a.x - b.x || a.y - b.y || a.z - b.z;
  });
  return parsed.map((p) => p.node);
}

/**
 * Whether a streaming source can be said to be fully resident.
 *
 * Returns null when the answer is unknown, which is not the same as false. A
 * source whose hierarchy has not been read far enough to count its nodes
 * cannot support either claim, and an absence of pending requests is not
 * evidence of coverage: a scheduler with nothing queued has often simply
 * stopped asking.
 */
export function streamingIsComplete(coverage: StreamingCoverage): boolean | null {
  const known = coverage.knownNodeCount;
  if (known == null || !Number.isFinite(known) || known < 0) return null;
  if (!Number.isFinite(coverage.residentNodeCount) || coverage.residentNodeCount < 0) return null;
  return coverage.residentNodeCount >= known;
}

/**
 * The scope a section may claim.
 *
 * A streaming source that is provably fully resident still reports as a
 * resident snapshot when any part of the section came from one, because the
 * claim describes where the returns came from rather than how complete the
 * transfer happened to be.
 */
export function resolveSectionScope(input: {
  readonly staticSourceCount: number;
  readonly streamingSourceCount: number;
}): ProfileSectionScope {
  const hasStatic = input.staticSourceCount > 0;
  const hasStream = input.streamingSourceCount > 0;
  if (hasStatic && hasStream) return 'mixed-full-and-resident';
  if (hasStatic) return 'full-static-source';
  if (hasStream) return 'resident-snapshot';
  return 'empty';
}

/**
 * The sentence a header shows for a scope.
 *
 * A resident scope whose completeness is unknown says so rather than
 * implying either answer.
 */
export function describeSectionScope(
  scope: ProfileSectionScope,
  streamingComplete: boolean | null,
): string {
  switch (scope) {
    case 'full-static-source':
      return 'Full static source';
    case 'mixed-full-and-resident':
      return streamingComplete === true
        ? 'Static source plus a fully resident streaming source'
        : 'Mixed static and resident streaming snapshot';
    case 'resident-snapshot':
      if (streamingComplete === true) return 'Resident snapshot, every known node resident';
      if (streamingComplete === false) return 'Resident snapshot, streaming source incomplete';
      return 'Resident snapshot, coverage unknown';
    default:
      return 'No source read';
  }
}

/**
 * Guards a section against an older extraction landing after a newer one.
 *
 * Each request takes the next token; a result is accepted only while its
 * token is still the current one. Closing or deleting the measurement
 * invalidates every outstanding request without needing to reach them.
 */
export class SectionGeneration {
  private _current = 0;
  private _abandoned = false;

  /** Claim the next token. */
  next(): number {
    this._current++;
    return this._current;
  }

  /** The token a result must carry to be accepted. */
  get current(): number {
    return this._current;
  }

  /**
   * True when `token` is still the newest and the section is still open.
   *
   * Tokens start at 1, so the zero a caller holds before its first request
   * is refused rather than matching the counter's initial value.
   */
  accepts(token: number): boolean {
    if (!Number.isInteger(token) || token < 1) return false;
    return !this._abandoned && token === this._current;
  }

  /**
   * Refuse every outstanding and future result.
   *
   * Permanent: a closed or deleted measurement has no later state in which
   * an extraction already in flight becomes wanted again.
   */
  abandon(): void {
    this._abandoned = true;
  }

  /** Whether the section has been abandoned. */
  get abandoned(): boolean {
    return this._abandoned;
  }
}
