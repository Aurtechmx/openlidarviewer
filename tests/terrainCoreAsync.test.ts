/**
 * terrainCoreAsync.test.ts — proves the worker-backed core compute degrades
 * SAFELY and that the async cache path preserves cache + abort semantics.
 *
 * The actual Worker round-trip cannot run in Node/jsdom, so it is NOT faked.
 * What IS testable — and is the real risk surface — is covered here:
 *
 *   computeTerrainCoreAsync (the bridge + fallback):
 *     1. Worker success — returns the worker client's core verbatim (no fallback).
 *     2. Worker FAILURE (construct / message / unsupported) — falls back to the
 *        real synchronous computeTerrainCore and returns a core EQUAL to calling
 *        it directly for a small fixture scene.
 *     3. Abort BEFORE compute — rejects with an AbortError, no fallback compute.
 *     4. A worker-reported ABORT is propagated, not silently recomputed.
 *     4b. STALE-RESULT RACE — the worker fails for real AND the caller's signal
 *         aborts before the fallback runs (dataset changed mid-run): rejects
 *         with an AbortError and never returns a fallback core; the inverse
 *         (signal present but never fired) falls back normally; and an
 *         oversize run (n > MAX_FALLBACK_POINTS) rejects with the too-large
 *         error instead of freezing the main thread.
 *
 *   getOrComputeCoreAsync (the cache + async path):
 *     5. Computes once, reuses on the second call (hit → no recompute).
 *     6. A different cloud / param recomputes (no false hit).
 *     7. Abort/reject BEFORE resolve rejects WITHOUT storing → a later run
 *        recomputes (a failure is never cached).
 *     8. Concurrent misses for the same key coalesce onto one compute.
 *
 * Pure data: no DOM, no real Worker.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeTerrainCoreAsync,
  getLastTerrainComputePath,
  MAX_FALLBACK_POINTS,
  type TerrainCoreClientLike,
} from '../src/terrain/worker/computeTerrainCoreAsync';
import {
  getOrComputeCoreAsync,
  clearTerrainCoreCache,
} from '../src/terrain/contour/terrainCoreCache';
import {
  computeTerrainCore,
  type TerrainCore,
  type TerrainCoreParams,
} from '../src/terrain/contour/analyseContours';

/** A small but real terrain scene — a Gaussian hill on a 26×26 grid. */
function hillScene(): Float32Array {
  const pts: number[] = [];
  for (let x = 0; x <= 25; x++) {
    for (let y = 0; y <= 25; y++) {
      const dx = x - 12.5;
      const dy = y - 12.5;
      pts.push(x, y, 8 * Math.exp(-(dx * dx + dy * dy) / 200));
    }
  }
  return Float32Array.from(pts);
}

const PARAMS: TerrainCoreParams = {
  cellSizeM: 2,
  crs: 'EPSG:32610',
  verticalDatum: 'EPSG:5703',
};

/** A worker-client stub that always throws synchronously from computeCore. */
const throwingClient: TerrainCoreClientLike = {
  computeCore() {
    throw new Error('worker construction failed');
  },
};

/** A worker-client stub that rejects asynchronously (e.g. message error). */
const rejectingClient: TerrainCoreClientLike = {
  computeCore() {
    return Promise.reject(new Error('worker message failed'));
  },
};

describe('computeTerrainCoreAsync — fallback', () => {
  // The fallback fixtures make the bridge announce the worker failure on
  // console.warn BEFORE recovering — expected behaviour, asserted separately
  // in the "failure visibility" suite below. Silence it here so a green run
  // stays clean.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('returns the worker result verbatim when the worker succeeds', async () => {
    const pos = hillScene();
    const sentinel = { __fromWorker: true } as unknown as TerrainCore;
    const client: TerrainCoreClientLike = {
      computeCore: (positions, n) => {
        // The client must receive the caller's array and a correct point count.
        expect(n).toBe(positions.length / 3);
        return Promise.resolve(sentinel);
      },
    };
    const core = await computeTerrainCoreAsync(
      pos,
      pos.length / 3,
      PARAMS,
      undefined,
      undefined,
      client,
    );
    expect(core).toBe(sentinel);
  });

  it('falls back to the real computeTerrainCore when the worker throws', async () => {
    const pos = hillScene();
    const viaFallback = await computeTerrainCoreAsync(
      pos,
      pos.length / 3,
      PARAMS,
      undefined,
      undefined,
      throwingClient,
    );
    const direct = computeTerrainCore(pos, PARAMS);
    // The fallback result must equal a direct synchronous compute.
    expect(viaFallback.elevationRangeM).toBe(direct.elevationRangeM);
    expect(viaFallback.dtm.cols).toBe(direct.dtm.cols);
    expect(viaFallback.dtm.rows).toBe(direct.dtm.rows);
    expect(Array.from(viaFallback.dtm.z)).toEqual(Array.from(direct.dtm.z));
    expect(viaFallback.crs).toBe('EPSG:32610');
  });

  it('falls back when the worker rejects asynchronously', async () => {
    const pos = hillScene();
    const viaFallback = await computeTerrainCoreAsync(
      pos,
      pos.length / 3,
      PARAMS,
      undefined,
      undefined,
      rejectingClient,
    );
    const direct = computeTerrainCore(pos, PARAMS);
    expect(Array.from(viaFallback.dtm.z)).toEqual(Array.from(direct.dtm.z));
  });

  it('does not detach the caller positions (fallback still has the data)', async () => {
    const pos = hillScene();
    const before = pos.length;
    await computeTerrainCoreAsync(
      pos,
      pos.length / 3,
      PARAMS,
      undefined,
      undefined,
      throwingClient,
    );
    // The fallback reads pos synchronously; if it had been detached this throws.
    expect(pos.length).toBe(before);
    expect(pos[0]).toBe(0); // first x of the grid, untouched
  });

  it('rejects (no compute) when the signal is already aborted', async () => {
    const pos = hillScene();
    const ac = new AbortController();
    ac.abort();
    let workerTouched = false;
    const spyClient: TerrainCoreClientLike = {
      computeCore: () => {
        workerTouched = true;
        return Promise.resolve({} as TerrainCore);
      },
    };
    await expect(
      computeTerrainCoreAsync(pos, pos.length / 3, PARAMS, undefined, ac.signal, spyClient),
    ).rejects.toThrow(/abort/i);
    expect(workerTouched).toBe(false);
  });

  it('propagates a worker-reported abort instead of recomputing on the main thread', async () => {
    const pos = hillScene();
    const ac = new AbortController();
    const abortingClient: TerrainCoreClientLike = {
      computeCore: () => Promise.reject(new Error('Terrain analysis aborted')),
    };
    await expect(
      computeTerrainCoreAsync(pos, pos.length / 3, PARAMS, undefined, ac.signal, abortingClient),
    ).rejects.toThrow(/abort/i);
  });

  it('honours classification passed via coreParams in the fallback', async () => {
    const pos = hillScene();
    const classification = new Uint8Array(pos.length / 3).fill(2); // all ground
    const params: TerrainCoreParams = { ...PARAMS, classification };
    const viaFallback = await computeTerrainCoreAsync(
      pos,
      pos.length / 3,
      params,
      undefined,
      undefined,
      throwingClient,
    );
    const direct = computeTerrainCore(pos, params);
    expect(viaFallback.excludedByClassification).toBe(direct.excludedByClassification);
  });
});

describe('computeTerrainCoreAsync — failure visibility', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('reports via === "worker" on a successful worker compute', async () => {
    const pos = hillScene();
    const client: TerrainCoreClientLike = {
      computeCore: () => Promise.resolve({ __fromWorker: true } as unknown as TerrainCore),
    };
    await computeTerrainCoreAsync(pos, pos.length / 3, PARAMS, undefined, undefined, client);
    expect(getLastTerrainComputePath()).toBe('worker');
    // Success must NOT warn (a healthy worker is silent on the warn channel).
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns LOUDLY and reports via === "fallback" when the worker fails', async () => {
    const pos = hillScene();
    const viaFallback = await computeTerrainCoreAsync(
      pos,
      pos.length / 3,
      PARAMS,
      undefined,
      undefined,
      throwingClient,
    );
    // The warning is the must-have signal: a broken worker announces itself.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/worker analysis failed/i);
    // The error itself is included so the developer can see the cause.
    expect(warnSpy.mock.calls[0][1]).toBeInstanceOf(Error);
    expect(getLastTerrainComputePath()).toBe('fallback');
    // …and the fallback core is still correct (analysis never breaks).
    const direct = computeTerrainCore(pos, PARAMS);
    expect(Array.from(viaFallback.dtm.z)).toEqual(Array.from(direct.dtm.z));
  });

  it('warns on an async worker rejection too', async () => {
    const pos = hillScene();
    await computeTerrainCoreAsync(
      pos,
      pos.length / 3,
      PARAMS,
      undefined,
      undefined,
      rejectingClient,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/worker analysis failed/i);
    expect(getLastTerrainComputePath()).toBe('fallback');
  });

  it('stays SILENT on an abort — no warning, propagates the abort', async () => {
    const pos = hillScene();
    const ac = new AbortController();
    const abortingClient: TerrainCoreClientLike = {
      computeCore: () => Promise.reject(new Error('Terrain analysis aborted')),
    };
    await expect(
      computeTerrainCoreAsync(pos, pos.length / 3, PARAMS, undefined, ac.signal, abortingClient),
    ).rejects.toThrow(/abort/i);
    // An abort is expected cancellation, not a failure — it must not warn.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('stays SILENT when the signal is already aborted before compute', async () => {
    const pos = hillScene();
    const ac = new AbortController();
    ac.abort();
    await expect(
      computeTerrainCoreAsync(pos, pos.length / 3, PARAMS, undefined, ac.signal, throwingClient),
    ).rejects.toThrow(/abort/i);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not emit the dev-only info log when ?debug is absent', async () => {
    const pos = hillScene();
    const client: TerrainCoreClientLike = {
      computeCore: () => Promise.resolve({} as TerrainCore),
    };
    await computeTerrainCoreAsync(pos, pos.length / 3, PARAMS, undefined, undefined, client);
    // jsdom's default URL carries no `?debug`, so the success info stays quiet.
    expect(infoSpy).not.toHaveBeenCalled();
  });
});

describe('computeTerrainCoreAsync — fallback stale-result race + oversize guard', () => {
  // The fallback path warns loudly on a real worker failure (pinned above);
  // silence the channel here so the suite output stays clean.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  /** Seed lastComputePath with a known 'worker' value via a healthy client. */
  async function seedWorkerPath(pos: Float32Array): Promise<void> {
    const healthy: TerrainCoreClientLike = {
      computeCore: () => Promise.resolve({ __seed: true } as unknown as TerrainCore),
    };
    await computeTerrainCoreAsync(pos, pos.length / 3, PARAMS, undefined, undefined, healthy);
    expect(getLastTerrainComputePath()).toBe('worker');
  }

  it('rejects with an AbortError — and ignores the stale fallback — when the signal fires during a REAL worker failure', async () => {
    const pos = hillScene();
    await seedWorkerPath(pos);

    const ac = new AbortController();
    // The worker fails for a real (non-abort) reason, and the dataset change
    // lands at the same moment: the abort fires BEFORE the synchronous
    // fallback would start. The abort re-check in computeTerrainCoreAsync
    // must win — the run is cancelled, not silently recomputed.
    const racingClient: TerrainCoreClientLike = {
      computeCore: () => {
        ac.abort();
        return Promise.reject(new Error('worker message failed'));
      },
    };
    const err = await computeTerrainCoreAsync(
      pos,
      pos.length / 3,
      PARAMS,
      undefined,
      ac.signal,
      racingClient,
    ).then(
      () => {
        throw new Error('resolved — a stale fallback core was returned for an aborted run');
      },
      (e: unknown) => e,
    );
    // A genuine AbortError, not the worker error and not a fallback result.
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
    // The stale-result guard held: the fallback never computed, so the path
    // marker still reads the seeded 'worker' value (a fallback compute would
    // have flipped it).
    expect(getLastTerrainComputePath()).toBe('worker');
    // The REAL worker failure still announced itself (an abort alone is
    // silent, but a broken worker must never hide behind a cancelled run).
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/worker analysis failed/i);
  });

  it('falls back normally when a signal is supplied but never fires (inverse of the race)', async () => {
    const pos = hillScene();
    const ac = new AbortController(); // present, never aborted
    const viaFallback = await computeTerrainCoreAsync(
      pos,
      pos.length / 3,
      PARAMS,
      undefined,
      ac.signal,
      rejectingClient,
    );
    const direct = computeTerrainCore(pos, PARAMS);
    expect(Array.from(viaFallback.dtm.z)).toEqual(Array.from(direct.dtm.z));
    expect(getLastTerrainComputePath()).toBe('fallback');
  });

  it('rejects with the too-large error — never a frozen main thread — when the worker fails on an oversize run', async () => {
    const pos = hillScene();
    await seedWorkerPath(pos);

    const n = MAX_FALLBACK_POINTS + 1;
    const err = await computeTerrainCoreAsync(
      pos, // the guard fires on the declared count, before any compute
      n,
      PARAMS,
      undefined,
      undefined,
      throwingClient,
    ).then(
      () => {
        throw new Error('resolved — the oversize fallback guard did not fire');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const msg = String((err as Error).message);
    expect(msg).toMatch(/too\s+large/i);
    // The message names BOTH the offending size and the limit — the figures a
    // developer needs to size the sample down.
    expect(msg).toContain(String(n));
    expect(msg).toContain(String(MAX_FALLBACK_POINTS));
    // Not an abort (the caller must treat this as a real failure) …
    expect((err as Error).name).not.toBe('AbortError');
    // … and no fallback compute happened (path marker keeps its seeded value).
    expect(getLastTerrainComputePath()).toBe('worker');
  });

  it('a run exactly AT the limit still falls back (the guard is strictly greater-than)', async () => {
    const pos = hillScene();
    // n == MAX_FALLBACK_POINTS must pass the guard. The synchronous fallback
    // reads the positions array itself (not n), so the small fixture computes
    // a real core — what is under test is the boundary of the guard.
    const core = await computeTerrainCoreAsync(
      pos,
      MAX_FALLBACK_POINTS,
      PARAMS,
      undefined,
      undefined,
      throwingClient,
    );
    const direct = computeTerrainCore(pos, PARAMS);
    expect(Array.from(core.dtm.z)).toEqual(Array.from(direct.dtm.z));
    expect(getLastTerrainComputePath()).toBe('fallback');
  });
});

describe('getOrComputeCoreAsync — cache + async path', () => {
  // The integration test below routes a worker failure through the cache —
  // the announcement is expected fixture behaviour, silenced like the
  // fallback suite above.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clearTerrainCoreCache();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('computes once, reuses the result on the second call', async () => {
    const pos = hillScene();
    let calls = 0;
    const compute = async (): Promise<TerrainCore> => {
      calls++;
      return { __tag: 'a' } as unknown as TerrainCore;
    };
    const a = await getOrComputeCoreAsync(pos, PARAMS, compute);
    const b = await getOrComputeCoreAsync(pos, PARAMS, compute);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it('recomputes for a different cloud or changed param (no false hit)', async () => {
    let calls = 0;
    const compute = async (): Promise<TerrainCore> => {
      calls++;
      return { __tag: `c${calls}` } as unknown as TerrainCore;
    };
    const a = hillScene();
    const b = a.slice(0, a.length - 3); // different length → different content hash
    await getOrComputeCoreAsync(a, PARAMS, compute);
    await getOrComputeCoreAsync(a, PARAMS, compute); // hit
    await getOrComputeCoreAsync(b, PARAMS, compute); // miss — different cloud
    await getOrComputeCoreAsync(a, { ...PARAMS, cellSizeM: 1 }, compute); // miss — param
    expect(calls).toBe(3);
  });

  it('does NOT store a rejected compute — a later run recomputes', async () => {
    const pos = hillScene();
    let calls = 0;
    const failingThenOk = async (): Promise<TerrainCore> => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return { __tag: 'ok' } as unknown as TerrainCore;
    };
    await expect(getOrComputeCoreAsync(pos, PARAMS, failingThenOk)).rejects.toThrow('boom');
    // The failure was not cached → the next call computes again and succeeds.
    const ok = await getOrComputeCoreAsync(pos, PARAMS, failingThenOk);
    expect(calls).toBe(2);
    expect((ok as unknown as { __tag: string }).__tag).toBe('ok');
  });

  it('does NOT store an aborted compute — a later run recomputes', async () => {
    const pos = hillScene();
    const ac = new AbortController();
    let calls = 0;
    const compute = async (): Promise<TerrainCore> => {
      calls++;
      // First call observes an abort and rejects (as computeTerrainCoreAsync would).
      if (calls === 1) {
        ac.abort();
        throw new DOMException('Terrain analysis aborted', 'AbortError');
      }
      return { __tag: 'after-abort' } as unknown as TerrainCore;
    };
    await expect(getOrComputeCoreAsync(pos, PARAMS, compute)).rejects.toThrow(/abort/i);
    const ok = await getOrComputeCoreAsync(pos, PARAMS, compute);
    expect(calls).toBe(2);
    expect((ok as unknown as { __tag: string }).__tag).toBe('after-abort');
  });

  it('coalesces concurrent misses for the same key onto one compute', async () => {
    const pos = hillScene();
    let calls = 0;
    let release!: (c: TerrainCore) => void;
    const compute = (): Promise<TerrainCore> => {
      calls++;
      return new Promise<TerrainCore>((res) => {
        release = res;
      });
    };
    // Fire two misses for the SAME key before the first resolves.
    const p1 = getOrComputeCoreAsync(pos, PARAMS, compute);
    const p2 = getOrComputeCoreAsync(pos, PARAMS, compute);
    release({ __tag: 'shared' } as unknown as TerrainCore);
    const [a, b] = await Promise.all([p1, p2]);
    expect(calls).toBe(1); // only one compute spawned
    expect(a).toBe(b);
  });

  it('a clear() during an in-flight compute does not re-seed the cache', async () => {
    const pos = hillScene();
    let calls = 0;
    let release!: (c: TerrainCore) => void;
    const compute = (): Promise<TerrainCore> => {
      calls++;
      return new Promise<TerrainCore>((res) => {
        release = res;
      });
    };
    // Miss starts a compute; while it is in flight the scan is closed → clear().
    const inflight = getOrComputeCoreAsync(pos, PARAMS, compute);
    clearTerrainCoreCache();
    // The now-superseded compute finally resolves.
    release({ __tag: 'stale' } as unknown as TerrainCore);
    const stale = await inflight;
    // The original caller still receives its value …
    expect((stale as unknown as { __tag: string }).__tag).toBe('stale');
    // … but it must NOT have been cached: an identical later request recomputes
    // instead of being served the resurrected stale core. (Without the epoch
    // guard the stale core would be cached and this call would hit it.)
    let recomputed = false;
    const fresh = await getOrComputeCoreAsync(pos, PARAMS, () => {
      recomputed = true;
      return Promise.resolve({ __tag: 'fresh' } as unknown as TerrainCore);
    });
    expect(recomputed).toBe(true);
    expect((fresh as unknown as { __tag: string }).__tag).toBe('fresh');
    expect(calls).toBe(1);
  });

  it('integrates with computeTerrainCoreAsync fallback through the cache', async () => {
    const pos = hillScene();
    const core = await getOrComputeCoreAsync(pos, PARAMS, (input, params) =>
      computeTerrainCoreAsync(
        input as Float32Array,
        (input as Float32Array).length / 3,
        params,
        params.classification,
        undefined,
        throwingClient, // force the fallback
      ),
    );
    const direct = computeTerrainCore(pos, PARAMS);
    expect(Array.from(core.dtm.z)).toEqual(Array.from(direct.dtm.z));
    // Second call is a cache hit (no recompute path observable, but must equal).
    const again = await getOrComputeCoreAsync(pos, PARAMS, () => {
      throw new Error('should not be called on a hit');
    });
    expect(again).toBe(core);
  });
});
