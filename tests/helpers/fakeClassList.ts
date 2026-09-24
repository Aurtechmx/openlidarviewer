/**
 * tests/helpers/fakeClassList.ts
 *
 * The `classList` stub several panel-ARIA suites hand-roll on their own
 * `FakeEl`: a `Set`-backed add/remove/toggle/contains, exposing the raw
 * `_set` for the odd assertion that needs the whole class list. One copy
 * here keeps clipPanelAria/reclassifyUiAria/streamingPanelAria/
 * catalogPanelPcSearchAria/exportPanelPillsAria (and any future FakeEl) from
 * re-declaring the same twelve lines.
 */

export interface FakeClassList {
  readonly _set: Set<string>;
  add(c: string): void;
  remove(c: string): void;
  toggle(c: string, force?: boolean): boolean;
  contains(c: string): boolean;
}

export function makeFakeClassList(): FakeClassList {
  const _set = new Set<string>();
  return {
    _set,
    add(c: string): void {
      _set.add(c);
    },
    remove(c: string): void {
      _set.delete(c);
    },
    toggle(c: string, force?: boolean): boolean {
      const want = force ?? !_set.has(c);
      if (want) _set.add(c);
      else _set.delete(c);
      return want;
    },
    contains(c: string): boolean {
      return _set.has(c);
    },
  };
}
