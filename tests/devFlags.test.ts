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
    });
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
