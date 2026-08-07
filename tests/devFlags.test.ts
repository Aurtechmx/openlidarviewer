/**
 * devFlags.test.ts — the v0.5.5 development/audit URL flags (P0).
 *
 * Contract: pure parsing, defaults equal current behavior, garbage input
 * degrades to defaults field-by-field, and a flag can only opt OUT of the
 * default (never enable something extra).
 */

import {
  parseDevFlags,
  readDevFlags,
  resetDevFlagsForTest,
  DEV_FLAG_DEFAULTS,
} from '../src/perf/devFlags';

describe('parseDevFlags — defaults', () => {
  it('an empty query yields the documented defaults', () => {
    expect(parseDevFlags('')).toEqual(DEV_FLAG_DEFAULTS);
    expect(parseDevFlags('?')).toEqual(DEV_FLAG_DEFAULTS);
  });

  it('defaults equal current behavior: default impls, everything on', () => {
    expect(DEV_FLAG_DEFAULTS).toEqual({
      streamingScore: 'default',
      wheelDolly: 'default',
      handPan: true,
      refinementPhase: true,
      adaptiveDpr: true,
      uploadQueue: true,
      angularPrediction: true,
      streamingCommitMode: 'immediate',
      decodePool: false,
      decodeWorkers: null,
    });
  });

  it('unrelated params leave every flag at its default', () => {
    expect(parseDevFlags('?debug=1&copc=https://x/y.laz&benchmark=1')).toEqual(
      DEV_FLAG_DEFAULTS,
    );
  });
});

describe('parseDevFlags — the program §P0 flag set', () => {
  it('?streamingScore=legacy selects the legacy scorer', () => {
    expect(parseDevFlags('?streamingScore=legacy').streamingScore).toBe('legacy');
    expect(parseDevFlags('?streamingScore=LEGACY').streamingScore).toBe('legacy');
    expect(parseDevFlags('?streamingScore=default').streamingScore).toBe('default');
  });

  it('?wheelDolly=legacy selects the legacy wheel path', () => {
    expect(parseDevFlags('?wheelDolly=legacy').wheelDolly).toBe('legacy');
    expect(parseDevFlags('').wheelDolly).toBe('default');
  });

  it.each(['handPan', 'refinementPhase', 'adaptiveDpr', 'uploadQueue', 'angularPrediction'] as const)(
    '?%s=off disables the flag (and 0/false variants too)',
    (flag) => {
      expect(parseDevFlags(`?${flag}=off`)[flag]).toBe(false);
      expect(parseDevFlags(`?${flag}=OFF`)[flag]).toBe(false);
      expect(parseDevFlags(`?${flag}=0`)[flag]).toBe(false);
      expect(parseDevFlags(`?${flag}=false`)[flag]).toBe(false);
      expect(parseDevFlags(`?${flag}=on`)[flag]).toBe(true);
      expect(parseDevFlags('')[flag]).toBe(true);
    },
  );

  it('all seven flags parse together from one query string', () => {
    const flags = parseDevFlags(
      '?streamingScore=legacy&wheelDolly=legacy&handPan=off&refinementPhase=off' +
        '&adaptiveDpr=off&uploadQueue=off&angularPrediction=off',
    );
    expect(flags).toEqual({
      streamingScore: 'legacy',
      wheelDolly: 'legacy',
      handPan: false,
      refinementPhase: false,
      adaptiveDpr: false,
      uploadQueue: false,
      angularPrediction: false,
      streamingCommitMode: 'immediate',
      decodePool: false,
      decodeWorkers: null,
    });
  });

  it('?decodePool=on opts into pooled decoding; every other input leaves it off', () => {
    expect(parseDevFlags('?decodePool=on').decodePool).toBe(true);
    expect(parseDevFlags('?decodePool=ON').decodePool).toBe(true);
    expect(parseDevFlags('?decodePool=1').decodePool).toBe(true);
    expect(parseDevFlags('?decodePool=true').decodePool).toBe(true);
    // This flag runs the opposite way to the rest: absence, garbage, an empty
    // value and an explicit `off` all keep the SHIPPING default, which is the
    // historical single-worker path. No malformed URL can turn pooling on.
    expect(parseDevFlags('').decodePool).toBe(false);
    expect(parseDevFlags('?decodePool').decodePool).toBe(false);
    expect(parseDevFlags('?decodePool=').decodePool).toBe(false);
    expect(parseDevFlags('?decodePool=off').decodePool).toBe(false);
    expect(parseDevFlags('?decodePool=banana').decodePool).toBe(false);
  });

  it('?decodeWorkers=N pins 1-4; anything else defers to the device policy', () => {
    for (const n of [1, 2, 3, 4]) {
      expect(parseDevFlags(`?decodeWorkers=${n}`).decodeWorkers).toBe(n);
    }
    // Out of range, fractional, negative, garbage and absence all read as null,
    // so a mistyped flag falls back to the policy rather than to an extreme.
    for (const bad of ['0', '5', '64', '-1', '2.5', 'banana', '', ' ']) {
      expect(parseDevFlags(`?decodeWorkers=${bad}`).decodeWorkers).toBeNull();
    }
    expect(parseDevFlags('').decodeWorkers).toBeNull();
  });

  it('?streamingCommitMode=metered opts into the metered path; default is immediate', () => {
    expect(parseDevFlags('?streamingCommitMode=metered').streamingCommitMode).toBe('metered');
    expect(parseDevFlags('?streamingCommitMode=METERED').streamingCommitMode).toBe('metered');
    // Absence, garbage, and the explicit value all resolve to the safe default.
    expect(parseDevFlags('').streamingCommitMode).toBe('immediate');
    expect(parseDevFlags('?streamingCommitMode=banana').streamingCommitMode).toBe('immediate');
    expect(parseDevFlags('?streamingCommitMode=immediate').streamingCommitMode).toBe('immediate');
  });
});

describe('parseDevFlags — garbage input', () => {
  it('unknown values degrade to the default, never throw', () => {
    expect(parseDevFlags('?streamingScore=banana').streamingScore).toBe('default');
    expect(parseDevFlags('?handPan=banana').handPan).toBe(true);
    expect(parseDevFlags('?handPan=').handPan).toBe(true);
    expect(parseDevFlags('?adaptiveDpr').adaptiveDpr).toBe(true);
  });

  it('malformed query strings degrade to defaults, never throw', () => {
    expect(parseDevFlags('%%%===&&&')).toEqual(DEV_FLAG_DEFAULTS);
    expect(parseDevFlags('?&&=&%2')).toEqual(DEV_FLAG_DEFAULTS);
  });

  it('accepts a URLSearchParams instance directly', () => {
    const params = new URLSearchParams('uploadQueue=off');
    expect(parseDevFlags(params).uploadQueue).toBe(false);
  });

  it('a flag can only opt out — no value turns a default off implicitly', () => {
    // Every parseable single-flag query differs from defaults in at most
    // that one field.
    const flags = parseDevFlags('?wheelDolly=legacy');
    expect({ ...flags, wheelDolly: 'default' }).toEqual(DEV_FLAG_DEFAULTS);
  });
});

describe('readDevFlags — DOM-free environment', () => {
  it('returns defaults in Node (no window), memoized', () => {
    resetDevFlagsForTest();
    const first = readDevFlags();
    expect(first).toEqual(DEV_FLAG_DEFAULTS);
    // Memoized — same object on the second read.
    expect(readDevFlags()).toBe(first);
    resetDevFlagsForTest();
  });
});
