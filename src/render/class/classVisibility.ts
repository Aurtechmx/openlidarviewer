/**
 * classVisibility.ts
 *
 * Pure 256-entry visibility state for ASPRS point classes. Extended
 * LAS (point-data-record format >= 6) stores the classification as a
 * full byte, so legal class codes span 0-255 — a 32-wide state would
 * silently drop everything above code 31. This module keeps the full
 * 256-wide band so any class the loader later discovers has a defined
 * visibility slot from the start.
 *
 * All public methods mask the incoming code with `& 0xff`, so callers
 * may pass raw, unvalidated class bytes without range checks. The
 * default state is "everything visible"; the GPU mask uniform and the
 * UI both build on the queries exposed here.
 *
 * Pure data — no DOM, no three.js, no I/O.
 */

/** Number of distinct ASPRS class codes a full byte can hold. */
const CLASS_COUNT = 256;

/**
 * Holds show/hide state for all 256 possible ASPRS class codes.
 * Visible by default; codes are always masked with `& 0xff`.
 */
export class ClassVisibility {
  /** One flag per class code; `true` means visible. */
  private readonly visible: boolean[];

  constructor() {
    this.visible = new Array<boolean>(CLASS_COUNT).fill(true);
  }

  /** Returns whether the given class code is currently shown. */
  isVisible(code: number): boolean {
    return this.visible[code & 0xff];
  }

  /** Sets the visibility of a single class code. */
  setVisible(code: number, on: boolean): void {
    this.visible[code & 0xff] = on;
  }

  /** Hides every class, then shows only the given code. */
  isolate(code: number): void {
    this.visible.fill(false);
    this.visible[code & 0xff] = true;
  }

  /** Resets every class to visible. */
  showAll(): void {
    this.visible.fill(true);
  }

  /** True when at least one class is hidden. */
  isFiltered(): boolean {
    return this.visible.includes(false);
  }

  /** Returns the visible class codes in ascending order. */
  visibleCodes(): number[] {
    const out: number[] = [];
    for (let code = 0; code < CLASS_COUNT; code++) {
      if (this.visible[code]) out.push(code);
    }
    return out;
  }

  /** Returns the HIDDEN class codes in ascending order (the saved-filter shape). */
  hiddenCodes(): number[] {
    const out: number[] = [];
    for (let code = 0; code < CLASS_COUNT; code++) {
      if (!this.visible[code]) out.push(code);
    }
    return out;
  }

  /**
   * Reconstructs the filter from a saved hidden-code list: shows everything,
   * then hides exactly the given codes. Out-of-range codes wrap via `& 0xff`
   * (matching {@link setVisible}); an empty list clears the filter.
   */
  setHidden(codes: readonly number[]): void {
    this.visible.fill(true);
    for (const code of codes) this.visible[code & 0xff] = false;
  }

  /**
   * Returns a 256-entry mask for a GPU uniform: `1` where the class is
   * shown, `0` where hidden. A fresh array is returned each call.
   */
  toMaskArray(): Float32Array {
    const mask = new Float32Array(CLASS_COUNT);
    for (let code = 0; code < CLASS_COUNT; code++) {
      mask[code] = this.visible[code] ? 1 : 0;
    }
    return mask;
  }
}
