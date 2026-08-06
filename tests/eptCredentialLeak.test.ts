/**
 * eptCredentialLeak.test.ts
 *
 * A signed EPT dataset carries its credential in the URL's query string, and
 * `eptUrls.ts` re-attaches that query to every hierarchy and tile request by
 * design — otherwise a SAS-signed dataset loads `ept.json` and then 401s on
 * the first hierarchy fetch. So every remote EPT URL is, by construction, a
 * live bearer token.
 *
 * The transport used to interpolate that raw URL into its thrown messages,
 * and those messages are displayed: the full-cloud grade action paints
 * `err.message` into the streaming panel, where it reaches screenshots and
 * support tickets.
 *
 * These tests use one token string, `TOP_SECRET_TOKEN`, and assert it never
 * appears in anything a human or a log could see — the message, the structured
 * fields, `String(err)`, the serialised form, the user-facing description, or
 * the panel text the grade action writes.
 */

import { describe, expect, it, vi } from 'vitest';

const { gradeFullCloud } = vi.hoisted(() => ({ gradeFullCloud: vi.fn() }));
vi.mock('../src/render/streaming/fullCloudGradeAdapter', () => ({ gradeFullCloud }));
vi.mock('../src/render/streaming/sampleGrade', () => ({
  gradeSampleDensity: vi.fn(() => ({})),
  summarizeSampleGrade: vi.fn(() => ['Density: Moderate']),
}));

import { createEptTransport, EptFetchError } from '../src/io/ept/eptTransport';
import { describeRemoteEptError } from '../src/io/ept/eptUrlValidation';
import { scrubUrlsForDisplay, sanitizeUrlForDisplay } from '../src/io/range/RangeSource';
import {
  eptBaseUrl,
  eptHierarchyUrl,
  eptTileUrl,
  eptUrlSearch,
} from '../src/io/ept/eptUrls';
import { runFullCloudGrade } from '../src/render/streaming/runFullCloudGradeAction';

/** The credential. Nothing user-visible may contain this string. */
const TOKEN = 'TOP_SECRET_TOKEN';
const MANIFEST_URL = `https://example.com/dataset/ept.json?sv=2021&sig=${TOKEN}`;

// The real URL derivation — the same call chain `openStreaming` uses — so the
// URLs under test carry the credential exactly the way production does.
const BASE = eptBaseUrl(MANIFEST_URL);
const SEARCH = eptUrlSearch(MANIFEST_URL);
const HIERARCHY_URL = eptHierarchyUrl(BASE, { d: 3, x: 1, y: 2, z: 0 }, SEARCH);
const TILE_URL = eptTileUrl(BASE, { d: 3, x: 1, y: 2, z: 0 }, 'laszip', SEARCH);

/** Every surface an error can reach a human through. */
function everySurfaceOf(err: unknown): string[] {
  const e = err as Error & Record<string, unknown>;
  return [
    e.message,
    String(err),
    // How a console or a crash reporter would render it.
    `${e.name}: ${e.message}`,
    JSON.stringify(err),
    JSON.stringify({ ...e, message: e.message, name: e.name }),
    // Own enumerable + declared fields, stringified.
    Object.getOwnPropertyNames(e)
      .map((k) => `${k}=${String(e[k])}`)
      .join(' '),
    describeRemoteEptError(err, MANIFEST_URL),
    // The live leak path, verbatim from runFullCloudGradeAction.ts.
    err instanceof Error ? `Grade failed: ${err.message}` : 'Grade failed.',
  ];
}

function expectNoToken(err: unknown): void {
  for (const surface of everySurfaceOf(err)) {
    expect(surface ?? '').not.toContain(TOKEN);
    expect(surface ?? '').not.toContain('sig=');
  }
}

/** A fetch fake that always answers with the given status. */
function alwaysStatus(status: number): typeof fetch {
  return (async () =>
    new Response('', { status, statusText: 'Err' })) as typeof fetch;
}

const NO_SLEEP = { sleep: () => Promise.resolve() };

describe('the signed-URL fixture really does carry a credential', () => {
  it('re-attaches the token to hierarchy and tile URLs', () => {
    // If this ever stops being true the rest of the file proves nothing.
    expect(HIERARCHY_URL).toContain(TOKEN);
    expect(TILE_URL).toContain(TOKEN);
  });
});

describe('EPT hierarchy fetch failures never carry the credential', () => {
  it('permanent 404 — no token on any surface', async () => {
    const t = createEptTransport({ fetchImpl: alwaysStatus(404), ...NO_SLEEP });
    const err = await t.fetchText(HIERARCHY_URL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EptFetchError);
    expectNoToken(err);
  });

  it('exhausted retries on 500 — no token on any surface', async () => {
    const t = createEptTransport({
      fetchImpl: alwaysStatus(500),
      maxRetries: 1,
      ...NO_SLEEP,
    });
    const err = await t.fetchText(HIERARCHY_URL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EptFetchError);
    expectNoToken(err);
  });
});

describe('EPT tile fetch failures never carry the credential', () => {
  it('permanent 403 — no token on any surface', async () => {
    const t = createEptTransport({ fetchImpl: alwaysStatus(403), ...NO_SLEEP });
    const err = await t.fetchBytes(TILE_URL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EptFetchError);
    expectNoToken(err);
  });

  it('exhausted retries on 503 — no token on any surface', async () => {
    const t = createEptTransport({
      fetchImpl: alwaysStatus(503),
      maxRetries: 2,
      ...NO_SLEEP,
    });
    const err = await t.fetchBytes(TILE_URL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EptFetchError);
    expectNoToken(err);
  });
});

describe('EptFetchError structured fields', () => {
  it('carries operation / status / host / resource, all credential-free', async () => {
    const t = createEptTransport({ fetchImpl: alwaysStatus(404), ...NO_SLEEP });
    const err = (await t
      .fetchBytes(TILE_URL)
      .catch((e: unknown) => e)) as EptFetchError;
    expect(err.operation).toBe('tile');
    expect(err.status).toBe(404);
    expect(err.host).toBe('example.com');
    expect(err.resource).toBe('ept-data/3-1-2-0.laz');
    expect(err.safeUrl).not.toContain(TOKEN);
    // Still says WHICH file failed — sanitising must not cost diagnosability.
    expect(err.message).toContain('ept-data/3-1-2-0.laz');
    expect(err.message).toMatch(/EPT tile fetch failed \(404/);
  });
});

describe('the grade panel — the live leak path', () => {
  it('setGradeError text has no token when the decode fails on a signed tile', async () => {
    const transport = createEptTransport({ fetchImpl: alwaysStatus(500), maxRetries: 0, ...NO_SLEEP });
    const transportError = await transport
      .fetchBytes(TILE_URL)
      .catch((e: unknown) => e);
    gradeFullCloud.mockRejectedValue(transportError);
    const panel = {
      setGradeBusy: vi.fn(),
      setGradeResult: vi.fn(),
      setGradeError: vi.fn(),
      setGradeCancelled: vi.fn(),
    };
    const viewer = { streamingCloud: { crs: () => null }, streamingDecoder: {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runFullCloudGrade({ viewer, panel } as any);
    expect(panel.setGradeError).toHaveBeenCalledTimes(1);
    const painted = panel.setGradeError.mock.calls[0][0] as string;
    expect(painted).toContain('Grade failed');
    expect(painted).not.toContain(TOKEN);
    expect(painted).not.toContain('sig=');
  });
});

describe('describeRemoteEptError — safe verbatim, including the borrowed detail', () => {
  it('scrubs a raw signed URL that arrives inside a foreign error message', () => {
    // The formatter re-appends `detail` from errors it does not own — a
    // runtime fetch rejection, a decoder. Sanitising only the host it computes
    // itself left that seam open.
    const foreign = new Error(`NetworkError while fetching ${TILE_URL}`);
    const msg = describeRemoteEptError(foreign, MANIFEST_URL);
    expect(msg).not.toContain(TOKEN);
    expect(msg).toContain('example.com');
  });

  it('scrubs a signed URL in the entry-URL position too', () => {
    const msg = describeRemoteEptError(new Error('CORS policy blocked'), MANIFEST_URL);
    expect(msg).not.toContain(TOKEN);
  });
});

describe('scrubUrlsForDisplay', () => {
  it('strips the query from every URL in a block of prose', () => {
    const text = `first ${TILE_URL} then ${HIERARCHY_URL} done`;
    const out = scrubUrlsForDisplay(text);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain('ept-data/3-1-2-0.laz');
    expect(out).toContain('ept-hierarchy/3-1-2-0.json');
  });

  it('leaves credential-free text untouched', () => {
    expect(scrubUrlsForDisplay('no urls here')).toBe('no urls here');
    expect(scrubUrlsForDisplay('https://example.com/a.laz')).toBe(
      sanitizeUrlForDisplay('https://example.com/a.laz'),
    );
  });

  it('strips userinfo as well as the query', () => {
    expect(scrubUrlsForDisplay('at https://user:pw@example.com/a.laz now')).not.toContain(
      'pw',
    );
  });
});
