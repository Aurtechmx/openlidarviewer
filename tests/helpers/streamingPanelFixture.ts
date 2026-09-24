/**
 * tests/helpers/streamingPanelFixture.ts
 *
 * The `document` stub install + StreamingPanel callback stub shared by
 * streamingPanelAria.test.ts and streamingPanelColorModes.test.ts: both
 * construct a real `StreamingPanel` against a recording `FakeEl` and need
 * the same six no-op callback spies.
 */

import { vi } from 'vitest';

/** Install the stub `document` StreamingPanel reads at construction time. */
export function installStreamingPanelDom(makeEl: (tag: string) => unknown): void {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: makeEl,
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement ??= class {};
  g.HTMLAnchorElement ??= class {};
}

export function streamingPanelCallbacks() {
  return {
    onColorMode: vi.fn(),
    onQuality: vi.fn(),
    onPauseToggle: vi.fn(),
    onClearCache: vi.fn(),
    onGradeFullCloud: vi.fn(),
    onCancelGrade: vi.fn(),
  };
}
