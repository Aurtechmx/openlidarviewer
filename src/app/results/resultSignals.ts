/**
 * resultSignals.ts
 *
 * A tiny, dependency-free meeting point between owners that live in lazy
 * chunks (the Observatory runner, the Flow Pulse and Terrain Access labs) and
 * the Results shelf. An owner announces itself or its latest run by
 * reference; the shelf reads it. Importing this module never loads an owner's
 * chunk, and nothing here copies a result.
 */

/** The read side of the Observatory runner the shelf needs. */
export interface ObservatoryRunnerView {
  getState(): { readonly phase: string; readonly outcome?: { readonly status: string; readonly record?: { readonly id: string } } };
  subscribe(fn: () => void): () => void;
}

/** A lab run kept by reference: the outcome object and the layer it ran on. */
export interface LabRunRef {
  readonly outcome: object;
  readonly layerId: string | null;
  readonly filename: string | null;
}

export type LabKind = 'flow-pulse' | 'terrain-access';

let observatory: ObservatoryRunnerView | null = null;
const labRuns = new Map<LabKind, LabRunRef>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of [...listeners]) {
    try { fn(); } catch { /* a reader never breaks an owner */ }
  }
}

/** Called once by the Observatory entry when it builds the session's runner. */
export function announceObservatoryRunner(r: ObservatoryRunnerView): void {
  observatory = r;
  r.subscribe(notify);
  notify();
}

export function observatoryRunnerView(): ObservatoryRunnerView | null {
  return observatory;
}

/** A lab publishes its latest run, or null when that run is gone. */
export function publishLabRun(kind: LabKind, run: LabRunRef | null): void {
  if ((labRuns.get(kind) ?? null) === run) return;
  if (run) labRuns.set(kind, run);
  else labRuns.delete(kind);
  notify();
}

export function labRun(kind: LabKind): LabRunRef | null {
  return labRuns.get(kind) ?? null;
}

/** Told when any announced owner changes. Returns an unsubscribe. */
export function subscribeResultSignals(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Test only: forget every owner. */
export function resetResultSignalsForTest(): void {
  observatory = null;
  labRuns.clear();
  listeners.clear();
}
