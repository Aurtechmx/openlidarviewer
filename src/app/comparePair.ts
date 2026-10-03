/**
 * Before/after pair selection and run guarding for the two-epoch elevation
 * comparison. The comparison math lives in `terrain/change`; this module only
 * decides WHICH two loaded clouds are compared and whether a finished run may
 * still publish its result.
 */

export interface CompareChoice {
  readonly id: string;
  readonly name: string;
}

export interface ComparePairSelection {
  readonly before: string | null;
  readonly after: string | null;
}

export type ComparePairResolution =
  | { readonly ok: true; readonly beforeId: string; readonly afterId: string }
  | { readonly ok: false; readonly message: string };

export const COMPARE_NEEDS_TWO =
  'Compare needs two clouds, a before and an after. Load another scan of the same area, then choose Compare elevation again.';
export const COMPARE_SAME_CLOUD =
  'Before and After are the same cloud. Choose a different cloud for one of them.';

/**
 * Resolve the pair to compare. A selection that names a cloud no longer loaded
 * falls back to load order (first = before, second = after), so two clouds with
 * no explicit choice compare exactly as before.
 */
const NO_SELECTION: ComparePairSelection = { before: null, after: null };

export function resolveComparePair(
  ids: readonly string[],
  selection: ComparePairSelection = NO_SELECTION,
): ComparePairResolution {
  if (ids.length < 2) return { ok: false, message: COMPARE_NEEDS_TWO };
  const pick = (id: string | null, fallback: string): string =>
    id !== null && ids.includes(id) ? id : fallback;
  const beforeId = pick(selection.before, ids[0]);
  const afterId = pick(selection.after, ids[1]);
  if (beforeId === afterId) return { ok: false, message: COMPARE_SAME_CLOUD };
  return { ok: true, beforeId, afterId };
}

/**
 * Each run takes a token and a snapshot of the two layers it read. A run may
 * publish only while its token is the latest and both layers are still the
 * same loaded objects, so an older run never overwrites a newer one and a run
 * whose layer was removed or replaced is dropped.
 */
export class CompareRunGuard<T> {
  private _token = 0;

  begin(ids: readonly [string, string], lookup: (id: string) => T | undefined): () => boolean {
    const token = ++this._token;
    const snapshot = ids.map((id) => lookup(id));
    return () =>
      token === this._token &&
      ids.every((id, i) => snapshot[i] !== undefined && lookup(id) === snapshot[i]);
  }

  /** The token of the most recent run. */
  get token(): number {
    return this._token;
  }

  /** Retire any run in flight (its result will be dropped). */
  invalidate(): void {
    this._token++;
  }
}

export type CompareRunStart =
  | { readonly ok: true; readonly beforeId: string; readonly afterId: string; readonly current: () => boolean }
  | { readonly ok: false; readonly message: string };

/**
 * Resolve the pair, then open a guarded run over it. A refused pair also
 * retires any run in flight. When a run is dropped while it is still the
 * latest (its own cloud was removed or replaced), `onOrphaned` runs once so
 * the caller can clear the run's status line; a run replaced by a newer one
 * leaves the status to that run.
 */
export function beginCompareRun<T>(
  guard: CompareRunGuard<T>,
  ids: readonly string[],
  selection: ComparePairSelection,
  lookup: (id: string) => T | undefined,
  onOrphaned: () => void = () => {},
): CompareRunStart {
  const pair = resolveComparePair(ids, selection);
  if (!pair.ok) {
    guard.invalidate();
    return pair;
  }
  const live = guard.begin([pair.beforeId, pair.afterId], lookup);
  const token = guard.token;
  let orphanHandled = false;
  const current = (): boolean => {
    if (live()) return true;
    if (!orphanHandled && guard.token === token) {
      orphanHandled = true;
      onOrphaned();
    }
    return false;
  };
  return { ...pair, current };
}

export interface ComparePairPicker {
  readonly element: HTMLElement;
  setChoices(choices: readonly CompareChoice[]): void;
  selection(): ComparePairSelection;
  /** Called when the user changes the Before or After selection. */
  onChange(cb: () => void): void;
}

/** One scan a finished comparison was computed from. */
export interface CompareParticipant {
  /** Viewer id the scan had when compared. */
  readonly viewerId: string;
  /** Stable layer id, or null when none was bound. */
  readonly stableId: string | null;
  /** The loaded layer object, so a replaced scan in the same slot does not match. */
  readonly layer: unknown;
}

/**
 * True while a finished comparison still describes the pair the panel names:
 * the selection resolves to the same two viewer ids, and both are still the
 * same loaded layers with the same stable ids. Anything else (a pair change, a
 * participant closed or replaced) makes the result stale.
 */
export function compareResultCurrent(
  held: { readonly before: CompareParticipant; readonly after: CompareParticipant },
  ids: readonly string[],
  selection: ComparePairSelection,
  lookup: (id: string) => unknown,
  stableIdFor: (id: string) => string | null,
): boolean {
  const pair = resolveComparePair(ids, selection);
  if (!pair.ok || pair.beforeId !== held.before.viewerId || pair.afterId !== held.after.viewerId) return false;
  return [held.before, held.after].every(
    (p) => ids.includes(p.viewerId) && lookup(p.viewerId) === p.layer && stableIdFor(p.viewerId) === p.stableId,
  );
}

/** Before and After selectors over the loaded clouds. Text is set with textContent only. */
export function createComparePairPicker(doc: Document = document): ComparePairPicker {
  const root = doc.createElement('div');
  root.className = 'olv-compare-pair';
  root.style.display = 'none';
  const make = (label: string, cls: string): HTMLSelectElement => {
    const wrap = doc.createElement('label');
    wrap.className = 'olv-compare-pair-field';
    const text = doc.createElement('span');
    text.textContent = label;
    const select = doc.createElement('select');
    select.className = cls;
    wrap.append(text, select);
    root.append(wrap);
    return select;
  };
  const before = make('Before', 'olv-compare-before');
  const after = make('After', 'olv-compare-after');
  const listeners: (() => void)[] = [];
  for (const s of [before, after]) s.addEventListener('change', () => listeners.forEach((cb) => cb()));

  const fill = (select: HTMLSelectElement, choices: readonly CompareChoice[], keep: string, fallback: string): void => {
    select.replaceChildren(
      ...choices.map((c) => {
        const o = doc.createElement('option');
        o.value = c.id;
        o.textContent = c.name;
        return o;
      }),
    );
    select.value = choices.some((c) => c.id === keep) ? keep : fallback;
  };

  return {
    element: root,
    setChoices(choices) {
      root.style.display = choices.length >= 2 ? '' : 'none';
      if (choices.length < 2) {
        before.replaceChildren();
        after.replaceChildren();
        return;
      }
      fill(before, choices, before.value, choices[0].id);
      fill(after, choices, after.value, choices[1].id);
    },
    selection() {
      return { before: before.value || null, after: after.value || null };
    },
    onChange(cb) {
      listeners.push(cb);
    },
  };
}

/** A finished difference raster, bound to the two scans it was computed from. */
export interface HeldDifference {
  readonly stem: string;
  readonly asc: () => string;
  readonly before: CompareParticipant;
  readonly after: CompareParticipant;
}

export interface CompareDifferenceDeps {
  readonly slot: { lastDifference: HeldDifference | null };
  readonly ids: () => readonly string[];
  readonly selection: () => ComparePairSelection;
  readonly lookup: (id: string) => unknown;
  readonly stableIdFor: (id: string) => string | null;
  readonly setDifferenceAvailable: (on: boolean) => void;
  readonly setCompareResult: (lines: readonly string[]) => void;
  /** Retire the run in flight, so a run on a pair no longer named never publishes. */
  readonly retireRun?: () => void;
}

/**
 * Binds the shown comparison and its difference raster to the pair they were
 * computed from, and drops both (the download button and the result text too)
 * once the panel names another pair or a participating scan is closed or
 * replaced. Restoring the pair does not bring them back.
 */
export function createCompareDifference(deps: CompareDifferenceDeps) {
  const participant = (viewerId: string, layer: unknown): CompareParticipant => ({ viewerId, stableId: deps.stableIdFor(viewerId), layer });
  // The pair whose result the panel shows, from the start of its run.
  let shown: { before: CompareParticipant; after: CompareParticipant } | null = null;
  return {
    /** A run starts on this pair: forget any earlier difference. */
    begin(ids: readonly [string, string], before: unknown, after: unknown): void {
      deps.slot.lastDifference = null;
      shown = { before: participant(ids[0], before), after: participant(ids[1], after) };
    },
    /** The run's difference raster is ready to download. */
    hold(file: { readonly stem: string; readonly asc: () => string }): void {
      if (shown) deps.slot.lastDifference = { ...file, ...shown };
    },
    dropStale(): void {
      if (!shown || compareResultCurrent(shown, deps.ids(), deps.selection(), deps.lookup, deps.stableIdFor)) return;
      shown = null;
      deps.retireRun?.();
      deps.slot.lastDifference = null;
      deps.setDifferenceAvailable(false);
      deps.setCompareResult([]);
    },
    /** Download the held difference as an ESRI ASCII grid. */
    download(downloadText: (filename: string, text: string) => void): void {
      const held = deps.slot.lastDifference;
      if (held) downloadText(`${held.stem}.asc`, held.asc());
    },
  };
}
