/**
 * Every repeating timer and animation-frame site in src/ has a named owner.
 *
 * A new `setInterval(`, `requestAnimationFrame(`, or self-re-arming
 * `setTimeout(` in src/ fails this test until it is added below with the
 * owner that stops it (a disposer reachable from the app lifetime owner in
 * src/app/appLifetime.ts, a bound, or the frame scheduler). Counts are exact
 * per file, so a second site in an already-listed file also fails.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

type Kind = 'setInterval' | 'requestAnimationFrame' | 'setTimeout-rearm';
interface Site { readonly kind: Kind; readonly count: number; readonly owner: string }

const ACCEPTED: Record<string, readonly Site[]> = {
  'src/render/frameDemand.ts': [{ kind: 'setInterval', count: 1, owner: 'VisibleHeartbeat: runs only while started and visible; Viewer stops it on detachStreamingCloud/dispose' }],
  'src/app/streamingUiCoordinator.ts': [{ kind: 'setInterval', count: 1, owner: 'streaming status poll; endSession() clears it (lifetime: streaming session)' }],
  'src/ui/DebugOverlay.ts': [{ kind: 'setInterval', count: 1, owner: '?debug=1 refresh; stop() clears it (lifetime: viewer)' }],
  'src/ui/WorkflowController.ts': [{ kind: 'setInterval', count: 1, owner: 'record countdown; bounded to countdownSeconds, cancelCountdown() clears it' }],
  'src/render/frameScheduler.ts': [{ kind: 'requestAnimationFrame', count: 1, owner: 'the render loop; FrameDemand.dispose() cancels it (lifetime: viewer)' }],
  'src/perf/frameTelemetry.ts': [{ kind: 'requestAnimationFrame', count: 1, owner: 'debug frame sampler; stop() cancels it via DebugOverlay.stop()' }],
  'src/render/Viewer.ts': [{ kind: 'requestAnimationFrame', count: 2, owner: 'one-shot: resize debounce (cancelled on dispose) and a single-frame await' }],
  'src/ui/analyseSurfaceTiles.ts': [{ kind: 'requestAnimationFrame', count: 1, owner: 'one-shot coalesced repaint; cancelled on tile teardown' }],
  'src/ui/onboarding/bootTour.ts': [{ kind: 'requestAnimationFrame', count: 2, owner: 'one-shot double-frame deferral of tour start' }],
  'src/ui/fieldSimulation/flowPulseLab.ts': [{ kind: 'requestAnimationFrame', count: 1, owner: 'one-shot yield to the next frame' }],
  'src/app/profileWorkbenchSection.ts': [{ kind: 'requestAnimationFrame', count: 2, owner: 'one-shot deferred run' }],
  'src/render/snapshot.ts': [{ kind: 'requestAnimationFrame', count: 1, owner: 'one-shot frame await' }],
  'src/render/drawSignal.ts': [{ kind: 'requestAnimationFrame', count: 1, owner: 'one-shot frame await' }],
  'src/perf/navDriver.ts': [{ kind: 'requestAnimationFrame', count: 1, owner: 'one frame per trajectory step; bounded by the trajectory, ?benchmark=nav only' }],
  'src/ui/ProjectCard.ts': [{ kind: 'setTimeout-rearm', count: 1, owner: 'fade hand-off poll; bounded by HANDOFF_CEILING_MS' }],
};

const ROOT = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name) && !/\.(test|d)\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** Drop comment-only lines so prose about timers does not count. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

function scan(text: string): Map<Kind, number> {
  const src = code(text);
  const found = new Map<Kind, number>();
  const add = (k: Kind, n: number): void => { if (n) found.set(k, (found.get(k) ?? 0) + n); };
  add('setInterval', (src.match(/\bsetInterval\(/g) ?? []).length);
  add('requestAnimationFrame', (src.match(/\brequestAnimationFrame\(/g) ?? []).length);
  // setTimeout(name, …) inside the body of the function or const `name`.
  let rearm = 0;
  for (const m of src.matchAll(/(?:function\s+(\w+)\s*\(|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[\w<>| ]+)?\s*=>)/g)) {
    const name = m[1] ?? m[2];
    const body = src.slice(m.index! + m[0].length, m.index! + m[0].length + 2000);
    const end = body.search(/\n(?:\s{0,4})\}/);
    const scope = end >= 0 ? body.slice(0, end) : body;
    if (new RegExp(`setTimeout\\(\\s*${name}\\b`).test(scope)) rearm++;
  }
  add('setTimeout-rearm', rearm);
  return found;
}

describe('timer ownership', () => {
  const files = walk(join(ROOT, 'src'));
  const actual = new Map<string, Map<Kind, number>>();
  for (const f of files) {
    const found = scan(readFileSync(f, 'utf8'));
    if (found.size) actual.set(relative(ROOT, f).split('\\').join('/'), found);
  }

  it('every repeating timer / rAF site in src/ is listed with an owner', () => {
    const unowned: string[] = [];
    for (const [file, kinds] of actual) {
      for (const [kind, n] of kinds) {
        const listed = ACCEPTED[file]?.find((s) => s.kind === kind)?.count ?? 0;
        if (n !== listed) unowned.push(`${file}: ${n} ${kind} site(s), ${listed} listed`);
      }
    }
    expect(unowned).toEqual([]);
  });

  it('every listed site still exists', () => {
    const stale: string[] = [];
    for (const [file, sites] of Object.entries(ACCEPTED)) {
      for (const s of sites) {
        if (!s.owner.trim()) stale.push(`${file}: ${s.kind} has no owner`);
        if ((actual.get(file)?.get(s.kind) ?? 0) !== s.count) stale.push(`${file}: ${s.kind}`);
      }
    }
    expect(stale).toEqual([]);
  });
});
