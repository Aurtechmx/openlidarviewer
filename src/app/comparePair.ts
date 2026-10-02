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
export function resolveComparePair(
  ids: readonly string[],
  selection: ComparePairSelection = { before: null, after: null },
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

  /** Retire any run in flight (its result will be dropped). */
  invalidate(): void {
    this._token++;
  }
}

export type CompareRunStart =
  | { readonly ok: true; readonly beforeId: string; readonly afterId: string; readonly current: () => boolean }
  | { readonly ok: false; readonly message: string };

/** Resolve the pair, then open a guarded run over it. A refused pair also retires any run in flight. */
export function beginCompareRun<T>(
  guard: CompareRunGuard<T>,
  ids: readonly string[],
  selection: ComparePairSelection,
  lookup: (id: string) => T | undefined,
): CompareRunStart {
  const pair = resolveComparePair(ids, selection);
  if (!pair.ok) {
    guard.invalidate();
    return pair;
  }
  return { ...pair, current: guard.begin([pair.beforeId, pair.afterId], lookup) };
}

export interface ComparePairPicker {
  readonly element: HTMLElement;
  setChoices(choices: readonly CompareChoice[]): void;
  selection(): ComparePairSelection;
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
  };
}
