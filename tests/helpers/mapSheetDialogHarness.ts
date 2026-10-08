/**
 * tests/helpers/mapSheetDialogHarness.ts
 *
 * Drives the AnalysePanel map sheet dialog on the recording DOM stub. The stub
 * drops listeners, so `installDialogListeners` records them on `FakeEl` and
 * `fire` runs them, which lets a suite press the dialog's own buttons.
 */

import { FakeEl, installAnalysePanelDom } from './analysePanelDom';

type Listener = () => void;
const listeners = new WeakMap<FakeEl, Map<string, Listener[]>>();

/** Install the stub document and make `FakeEl` keep its listeners. */
export function installDialogListeners(): void {
  installAnalysePanelDom({ ns: true });
  FakeEl.prototype.addEventListener = function (this: FakeEl, type: string, fn: Listener): void {
    const m = listeners.get(this) ?? new Map<string, Listener[]>();
    m.set(type, [...(m.get(type) ?? []), fn]);
    listeners.set(this, m);
  } as FakeEl['addEventListener'];
}

/** Run every listener `node` recorded for `type`. */
export function fire(node: FakeEl, type: string): void {
  for (const fn of listeners.get(node)?.get(type) ?? []) fn();
}

/** A 24 by 24 sloped plane at 0.5 m spacing: contours at a 0.5 m interval. */
export function slopePositions(): Float32Array {
  const pts: number[] = [];
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) pts.push(x * 0.5, y * 0.5, 50 + 0.4 * x + 0.2 * y);
  }
  return new Float32Array(pts);
}

/** One dialog the mocked `openModal` opened. `close` fires `onClose` once. */
export interface RecordedModal {
  readonly footer: unknown;
  readonly body: unknown;
  closed: number;
  readonly close: () => void;
}

/** What the mocked modules recorded. Suites clear both before each case. */
export const recorded = {
  downloads: [] as { name: string; blob: Blob }[],
  modals: [] as RecordedModal[],
};

/** Stand-in for `src/io/download`: keeps every download instead of saving it. */
export function downloadModuleMock(): Record<string, unknown> {
  return {
    triggerDownload: (blob: Blob, name: string) => { recorded.downloads.push({ name, blob }); },
    downloadBytes: () => {},
  };
}

/** Stand-in for `src/ui/Modal`: records each dialog's body and footer. */
export function modalModuleMock(): Record<string, unknown> {
  return {
    FOCUSABLE: '',
    focusableIn: () => [],
    openModal: (opts: { footer: unknown; body: unknown; onClose?: () => void }) => {
      const rec: RecordedModal = {
        footer: opts.footer,
        body: opts.body,
        closed: 0,
        close: () => {
          if (rec.closed++ === 0) opts.onClose?.();
        },
      };
      recorded.modals.push(rec);
      return { close: rec.close, dialog: opts.body };
    },
  };
}
