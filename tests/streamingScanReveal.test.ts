/**
 * The EPT attach path revealed the nav bar and the body class and never the
 * dock, so a streaming EPT scan loaded with no measure, inspect, probe,
 * annotate or close button. The COPC path did it correctly, thirteen lines
 * written out by hand, and the second format copied some of them.
 *
 * Two tests, because they fail for different reasons. The first pins what the
 * reveal does. The second pins that every streaming attach in main.ts actually
 * calls it, which is the one that would have caught the original bug: a
 * unit test of a helper nobody calls passes perfectly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { revealStreamingScanChrome } from '../src/ui/streamingScanReveal';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function spyChrome() {
  const calls: string[] = [];
  const dock = {
    setEmpty: (v: boolean) => calls.push(`dock.setEmpty(${v})`),
    setMeasureEnabled: (v: boolean) => calls.push(`dock.setMeasureEnabled(${v})`),
    setAnnotateEnabled: (v: boolean) => calls.push(`dock.setAnnotateEnabled(${v})`),
    setInspectEnabled: (v: boolean) => calls.push(`dock.setInspectEnabled(${v})`),
    setProbeEnabled: (v: boolean) => calls.push(`dock.setProbeEnabled(${v})`),
    setCloseEnabled: (v: boolean) => calls.push(`dock.setCloseEnabled(${v})`),
    setBackend: (b: string) => calls.push(`dock.setBackend(${b})`),
  };
  const inspector = { setEmpty: (v: boolean) => calls.push(`inspector.setEmpty(${v})`) };
  const navBar = {
    element: { classList: { remove: (t: string) => calls.push(`navBar.remove(${t})`) } },
    setMode: (m: 'orbit') => calls.push(`navBar.setMode(${m})`),
    flashHelp: () => calls.push('navBar.flashHelp()'),
  };
  const body = { classList: { add: (t: string) => calls.push(`body.add(${t})`) } };
  return { calls, dock, inspector, navBar, body };
}

describe('streaming scan reveal', () => {
  it('enables every tool a streaming scan supports, close included', () => {
    const c = spyChrome();
    revealStreamingScanChrome({
      dock: c.dock,
      inspector: c.inspector,
      navBar: c.navBar,
      backend: 'webgpu',
      body: c.body,
    });

    // Close is the one the EPT path was missing and the one a user cannot work
    // around: without it a loaded scan cannot be dismissed.
    expect(c.calls).toContain('dock.setCloseEnabled(true)');
    expect(c.calls).toContain('dock.setEmpty(false)');
    expect(c.calls).toContain('inspector.setEmpty(false)');
    expect(c.calls).toContain('dock.setMeasureEnabled(true)');
    expect(c.calls).toContain('dock.setInspectEnabled(true)');
    expect(c.calls).toContain('dock.setProbeEnabled(true)');
    expect(c.calls).toContain('dock.setAnnotateEnabled(true)');
    expect(c.calls).toContain('dock.setBackend(webgpu)');
    expect(c.calls).toContain('navBar.remove(olv-hidden)');
    expect(c.calls).toContain('body.add(olv-has-scan)');
  });

  it('is called by every streaming attach path', () => {
    // v0.6 decomposition: both streaming attach paths (COPC + EPT) moved out of
    // the shell into `src/app/openStreaming.ts`, where each attach is followed
    // by the shared reveal — now indirected through the deps as
    // `revealStreamingChrome()`, which `main.ts` binds to the single
    // `revealStreamingScanChrome(...)` call. Scan both files.
    const main = readFileSync(resolve(ROOT, 'src/main.ts'), 'utf8');
    const openStreaming = readFileSync(resolve(ROOT, 'src/app/openStreaming.ts'), 'utf8');
    const src = main + openStreaming;

    // Both streaming formats go through `viewer.attachStreamingCloud`. Counting
    // the reveal against the attaches is what makes a new format fail here
    // instead of shipping a scan with no dock.
    const attaches = src.match(/viewer\.attachStreamingCloud\(/g) ?? [];
    const reveals = src.match(/revealStreamingChrome\(/g) ?? [];

    expect(attaches.length).toBeGreaterThanOrEqual(2);
    expect(reveals.length).toBe(attaches.length);

    // The reveal helper itself is wired exactly once — the shell's deps binding.
    expect((main.match(/revealStreamingScanChrome\(/g) ?? []).length).toBe(1);

    // And nothing re-inlines the block. Two hand-written `setCloseEnabled`
    // calls are correct and expected: the static-load path enables it, and
    // `closeScan` disables it on the way back to the empty state. A third
    // means a streaming path drifted back out of the shared reveal. The
    // static-load enable moved to the extracted open/load pipeline
    // (`src/app/openScan.ts`), so the enable is counted across both files while
    // the disable stays in the shell's `closeScan`.
    const openScanSrc = readFileSync(resolve(ROOT, 'src/app/openScan.ts'), 'utf8');
    const enables = (main + openScanSrc).match(/dock\.setCloseEnabled\(true\)/g) ?? [];
    const disables = (main + openScanSrc).match(/dock\.setCloseEnabled\(false\)/g) ?? [];
    expect(enables.length).toBe(1);
    expect(disables.length).toBe(1);
  });
});
