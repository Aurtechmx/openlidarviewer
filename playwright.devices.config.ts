import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/**
 * Device-profile sweep: phone and tablet emulation over the specs whose
 * results mean something on a phone or tablet.
 *
 * Not part of CI and not run by any npm script other than
 * `npm run test:e2e:devices`. It is an opt-in local sweep, advisory only.
 *
 * Everything except the projects comes from playwright.config.ts: the same
 * webServer, baseURL and seeded storageState. Set OLV_DEPLOY_PORT to run it
 * beside another e2e run on the default port.
 *
 * WHAT IS COLLECTED. Only the spec files in DEVICE_SPECS. A spec belongs there
 * when it is device-agnostic (it asserts nothing about viewport size or pointer
 * type) or when its subject is a phone, tablet or touch screen. Specs written
 * for a desktop viewport are not listed: run under a phone profile they fail
 * because the profile is wrong, not because the product is.
 *
 * WHAT IS LEFT OUT INSIDE A LISTED FILE. Some listed files also hold cases
 * that pin a desktop viewport and a fine pointer (for example the fine-pointer
 * cases of largeTouchLayout.spec.ts, or the fixed-width sweep of
 * responsiveLayout.spec.ts). Those carry the `@desktop-only` tag
 * (`{ tag: '@desktop-only' }` on the test or describe) and every project here
 * excludes it with `grepInvert`. Tag any new desktop-pinned case in a listed
 * file the same way. `@phone-only` marks a case that asserts the phone layout
 * at the project's own viewport; the tablet project excludes it. `@touch`
 * marks cases whose subject is a touch screen; it is informational, nothing
 * here selects on it.
 *
 * Emulation is not a device. The WebKit profiles are Playwright's WebKit build
 * on this machine's GPU, not Mobile Safari on an iPhone or iPad, and the
 * Chromium profile is not Chrome on Android. A pass is evidence about layout,
 * hit targets and touch handling, never about the renderer on real hardware.
 */
const DEVICE_SPECS = [
  // Device-agnostic: start-up and main-thread responsiveness.
  'smoke',
  'longTaskResponsiveness',
  // Touch and phone/tablet layout subjects.
  'touchGesture',
  'phoneWorkspace',
  'phoneAnalyseTab',
  'phoneMeasureHint',
  'visualsStudioMobile',
  'largeTouchLayout',
  'responsiveLayout',
  // Cross-cutting conventions asserted at phone size as well as desktop.
  'ceA11y',
  'ceExit',
  'ceStrip',
  'ceTargets',
  // UX journeys with a touch section. Their desktop sections skip themselves
  // on a touch project (`project.use.hasTouch`).
  'journeys/j1-open-scope',
  'journeys/j3-navigate',
  'journeys/j10-a11y-layout',
];

const DEVICE_MATCH = new RegExp(`/(${DEVICE_SPECS.join('|')})\\.spec\\.ts$`);

/** Excluded from every device project: desktop-pinned cases and the GPU/bench/soak sets. */
const NOT_ON_DEVICES = /@desktop-only|@gpu|@bench|@soak/;

const PROFILES: ReadonlyArray<{ name: string; device: string; tablet?: boolean }> = [
  { name: 'iphone-se', device: 'iPhone SE' },
  { name: 'iphone-15-pro-max', device: 'iPhone 15 Pro Max' },
  { name: 'ipad-pro-11', device: 'iPad Pro 11', tablet: true },
  { name: 'pixel-7', device: 'Pixel 7' },
];

export default defineConfig({
  ...base,
  projects: PROFILES.map((p) => ({
    name: p.name,
    use: { ...devices[p.device] },
    testMatch: DEVICE_MATCH,
    grepInvert: p.tablet ? [NOT_ON_DEVICES, /@phone-only/] : NOT_ON_DEVICES,
  })),
});
