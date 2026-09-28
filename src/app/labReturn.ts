/**
 * labReturn.ts
 *
 * Which lab started the terrain run, so the Terrain page can offer the way
 * back once the run has produced a ground surface. One pending lab at most;
 * opening the lab again clears it.
 */
export type ReturnLab = 'flow-pulse' | 'terrain-access';

let pending: ReturnLab | null = null;

export function setLabReturn(lab: ReturnLab | null): void { pending = lab; }

export function labReturn(): ReturnLab | null { return pending; }
