/**
 * The `?benchmark=nav` runner hook: `window.__olvNavProbe`.
 *
 * start() begins a run, stop(name) ends it and keeps its summary, summary()
 * reads the live run, record(env) builds a nav-jank record from the kept runs
 * (or the live run when none was kept).
 */
import { NavProbe, type NavProbeSummary } from './navProbe';
import { buildNavJankRecord, type NavJankEnv, type NavJankRecord, type NavJankRun } from './navJankRecord';

export interface NavProbeHandle {
  start(): void;
  stop(name?: string): NavProbeSummary;
  summary(): NavProbeSummary;
  record(env: NavJankEnv): NavJankRecord;
  readonly running: boolean;
}

export function createNavProbeHandle(win: Window, probe = new NavProbe()): NavProbeHandle {
  const runs: NavJankRun[] = [];
  return {
    start: () => probe.start(win),
    stop: (name) => {
      probe.stop();
      const summary = probe.summarize();
      runs.push({ name: name ?? `run-${runs.length + 1}`, summary });
      return summary;
    },
    summary: () => probe.summarize(),
    record: (env) => buildNavJankRecord(env, runs.length > 0 ? runs : [{ name: 'live', summary: probe.summarize() }]),
    get running() {
      return probe.running;
    },
  };
}

/** Install the hook on `win` and start recording at once. */
export function installNavProbe(win: Window & { __olvNavProbe?: NavProbeHandle }): NavProbeHandle {
  const handle = createNavProbeHandle(win);
  win.__olvNavProbe = handle;
  handle.start();
  return handle;
}
