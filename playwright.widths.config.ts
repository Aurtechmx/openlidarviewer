import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/**
 * The startup smoke spec, run once per viewport width.
 *
 * playwright.config.ts pins a single desktop viewport, so the smoke gate has
 * only ever proved that the page starts at one width. The layout branches at
 * several: src/style.css switches to the mobile bottom-sheet under 768 px, and
 * the panel rails re-flow above it. A console error thrown only by the branch
 * a given width takes was invisible to the gate.
 *
 * Everything except the viewport comes from playwright.config.ts — the same
 * webServer, the same baseURL, the same seeded storageState. One build and one
 * preview server serve every project here, which is why five widths cost about
 * as much as one.
 *
 * Run with: npm run test:smoke:widths
 */

/**
 * Five widths, each chosen against a real boundary rather than a device name:
 *
 *   320  the narrowest phone the mobile spec already pins
 *   375  the iPhone SE / mini baseline, also already pinned
 *   767  the last pixel of the mobile bottom-sheet layer
 *   768  the first pixel of the desktop layer — the pair straddles the
 *        breakpoint, which is where a layout regression actually lives
 *   1440 a full desktop, where the rails are widest
 */
const WIDTHS: ReadonlyArray<{ name: string; width: number; height: number }> = [
  { name: 'w320', width: 320, height: 568 },
  { name: 'w375', width: 375, height: 667 },
  { name: 'w767', width: 767, height: 1024 },
  { name: 'w768', width: 768, height: 1024 },
  { name: 'w1440', width: 1440, height: 900 },
];

export default defineConfig({
  ...base,
  projects: WIDTHS.map((v) => ({
    name: v.name,
    // `grepInvert: /@gpu/` mirrors the deterministic project in the base
    // config: a spec whose outcome depends on the runner's GPU adapter must
    // not be pulled in here by widening the viewport list.
    grepInvert: /@gpu/,
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width: v.width, height: v.height },
    },
  })),
});
