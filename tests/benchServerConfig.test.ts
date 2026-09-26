import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The nav benchmark reads window.__olvNavDriver / __olvNavProbe, which exist only
// in a build that honours `?benchmark=nav` (the plain build, not build:live) and
// only if the bench talks to THIS checkout's server rather than one left on the port.
const config = readFileSync('playwright.config.ts', 'utf8');
const runner = readFileSync('scripts/governor-ab.mjs', 'utf8');

describe('bench project web server', () => {
  it('serves a plain build by default, where the nav driver is installed', () => {
    expect(config).toContain(": 'npm run build && npm run preview',");
  });
  it('never reuses a server already on the port for bench runs', () => {
    expect(config).toMatch(/OLV_NO_SERVER_REUSE \|\| process\.argv\.includes\('--project=bench'\)\s*\?\s*false/);
    expect(runner).toContain("OLV_NO_SERVER_REUSE: '1'");
    expect(runner).toContain("'--project=bench'");
  });
});
