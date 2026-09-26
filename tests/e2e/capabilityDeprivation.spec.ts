/**
 * capabilityDeprivation.spec.ts — the core viewer without each optional feature.
 *
 * Every case removes ONE optional browser capability before any app script
 * runs (page.addInitScript), then proves the core path still holds: the app
 * boots, opens tests/fixtures/tiny.ply, draws it, and an orbit drag moves the
 * camera, with no uncaught page error. A capability is removed by deleting it
 * from its object and every prototype up the chain, so both a presence check
 * (`'x' in obj`) and a typeof check see it as absent.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  bootAndOpenTiny,
  collectPageErrors,
  expectDrawn,
  expectOrbitMovesCamera,
} from './viewerFloor';

/** Browser-side: remove `keys` from each named global object and its prototypes. */
function removeCapabilities(spec: Array<[string, string[]]>): void {
  const roots: Record<string, unknown> = {
    window: globalThis,
    navigator: globalThis.navigator,
    storage: globalThis.navigator?.storage,
    element: globalThis.Element?.prototype,
    document: globalThis.document,
  };
  for (const [rootName, keys] of spec) {
    const root = roots[rootName];
    for (const key of keys) {
      let obj: unknown = root;
      while (obj && obj !== Object.prototype) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          try { delete (obj as Record<string, unknown>)[key]; } catch { /* non-configurable */ }
        }
        obj = Object.getPrototypeOf(obj);
      }
      if (root && key in (root as object)) {
        // Could not delete (non-configurable): shadow it with undefined instead.
        try { Object.defineProperty(root, key, { value: undefined, configurable: true }); } catch { /* ignore */ }
      }
    }
  }
}

async function deprive(page: Page, spec: Array<[string, string[]]>): Promise<void> {
  await page.addInitScript(removeCapabilities, spec);
}

async function expectCoreViewer(page: Page, input: 'mouse' | 'touch' = 'mouse'): Promise<void> {
  const errors = collectPageErrors(page);
  await bootAndOpenTiny(page);
  await expectDrawn(page);
  await expectOrbitMovesCamera(page, input);
  expect(errors).toEqual([]);
}

const CASES: Array<{ name: string; spec: Array<[string, string[]]>; absent: string }> = [
  { name: 'no WebGPU (navigator.gpu absent)', spec: [['navigator', ['gpu']]], absent: `'gpu' in navigator` },
  { name: 'no OPFS (storage.getDirectory absent)', spec: [['storage', ['getDirectory']]], absent: `typeof navigator.storage?.getDirectory === 'function'` },
  { name: 'no File System Access API (showOpenFilePicker absent)', spec: [['window', ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']]], absent: `typeof window.showOpenFilePicker === 'function'` },
  { name: 'no SharedArrayBuffer and not cross-origin isolated', spec: [['window', ['SharedArrayBuffer', 'crossOriginIsolated']]], absent: `typeof SharedArrayBuffer !== 'undefined' || globalThis.crossOriginIsolated === true` },
  { name: 'no OffscreenCanvas', spec: [['window', ['OffscreenCanvas']]], absent: `typeof OffscreenCanvas !== 'undefined'` },
  { name: 'no CompressionStream / DecompressionStream', spec: [['window', ['CompressionStream', 'DecompressionStream']]], absent: `typeof CompressionStream !== 'undefined' || typeof DecompressionStream !== 'undefined'` },
  { name: 'no Fullscreen API', spec: [['element', ['requestFullscreen', 'webkitRequestFullscreen']], ['document', ['exitFullscreen', 'webkitExitFullscreen', 'fullscreenEnabled', 'webkitFullscreenEnabled']]], absent: `typeof Element.prototype.requestFullscreen === 'function' || document.fullscreenEnabled === true` },
  { name: 'no Service Worker', spec: [['navigator', ['serviceWorker']]], absent: `'serviceWorker' in navigator && navigator.serviceWorker != null` },
  { name: 'no IndexedDB', spec: [['window', ['indexedDB']]], absent: `typeof indexedDB !== 'undefined' && indexedDB != null` },
];

test.describe('capability deprivation: the core viewer without one optional feature', () => {
  for (const c of CASES) {
    test(`boots, opens, draws and navigates with ${c.name}`, async ({ page }) => {
      await deprive(page, c.spec);
      await expectCoreViewer(page);
      // The capability really was gone for the whole session, not restored.
      expect(await page.evaluate(c.absent)).toBe(false);
    });
  }
});

test.describe('capability deprivation: touch-only landscape device', () => {
  // isMobile + hasTouch is what makes the engine report hover:none and a
  // coarse pointer; the assertion below checks that it did.
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test('boots, opens, draws and navigates with hover:none, coarse pointer, landscape touch', async ({ page }) => {
    await expectCoreViewer(page, 'touch');
    expect(await page.evaluate(() => [
      matchMedia('(hover: none)').matches,
      matchMedia('(pointer: coarse)').matches,
      navigator.maxTouchPoints > 0 || 'ontouchstart' in window,
      innerWidth > innerHeight,
    ])).toEqual([true, true, true, true]);
  });
});
