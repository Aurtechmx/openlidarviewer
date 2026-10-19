/**
 * Who may frame the viewer and drive its embed bridge. The viewer's own URL is
 * chosen by whoever frames it, so it can request an embedding origin but never
 * authorise one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideFramePolicy,
  deployerEmbedOrigins,
  parseOriginList,
  readFrameFacts,
  type FrameFacts,
} from '../src/ui/embedPolicy';
import { enforceFramePolicy, renderFramedNotice } from '../src/ui/frameGuard';
import { FakeEl } from './support/measurePanelDom';

const OWN = 'https://viewer.example';
const facts = (over: Partial<FrameFacts> = {}): FrameFacts => ({
  framed: true,
  ownOrigin: OWN,
  ancestorOrigins: undefined,
  parentSameOrigin: false,
  ...over,
});

describe('decideFramePolicy', () => {
  it('does nothing about an unframed page', () => {
    expect(decideFramePolicy(facts({ framed: false }), { deployerOrigins: [] })).toEqual({ kind: 'top', origins: [OWN] });
  });

  it('refuses a cross-origin framer that requests itself when the deployer lists nothing', () => {
    for (const ancestorOrigins of [undefined, ['https://attacker.example']]) {
      const d = decideFramePolicy(facts({ ancestorOrigins }), {
        deployerOrigins: [],
        requestedOrigins: ['https://attacker.example'],
      });
      expect(d.kind).toBe('safe');
    }
  });

  it('refuses a framer the deployer did not list even when the URL asks for it', () => {
    const d = decideFramePolicy(facts({ ancestorOrigins: ['https://attacker.example'] }), {
      deployerOrigins: ['https://portal.example'],
      requestedOrigins: ['https://attacker.example'],
    });
    expect(d.kind).toBe('safe');
  });

  it('accepts a same-origin parent with no list, read from ancestorOrigins or from its location', () => {
    expect(decideFramePolicy(facts({ ancestorOrigins: [OWN] }), { deployerOrigins: [] })).toEqual({
      kind: 'bridge', origins: [OWN], parentVerified: true,
    });
    expect(decideFramePolicy(facts({ parentSameOrigin: true }), { deployerOrigins: [] })).toEqual({
      kind: 'bridge', origins: [OWN], parentVerified: true,
    });
  });

  it('accepts a listed framer verified by ancestorOrigins, and talks to it alone', () => {
    const d = decideFramePolicy(facts({ ancestorOrigins: ['https://portal.example'] }), {
      deployerOrigins: ['https://portal.example', 'https://other.example'],
    });
    expect(d).toEqual({ kind: 'bridge', origins: ['https://portal.example'], parentVerified: true });
  });

  it('uses the immediate parent when the page is nested', () => {
    const d = decideFramePolicy(facts({ ancestorOrigins: ['https://attacker.example', 'https://portal.example'] }), {
      deployerOrigins: ['https://portal.example'],
    });
    expect(d.kind).toBe('safe');
  });

  it('a request narrows the deployer list and cannot extend it', () => {
    const rules = { deployerOrigins: ['https://a.example', 'https://b.example'] };
    const narrowed = decideFramePolicy(facts(), { ...rules, requestedOrigins: ['https://b.example', 'https://evil.example'] });
    expect(narrowed).toEqual({ kind: 'bridge', origins: [OWN, 'https://b.example'], parentVerified: false });
    const none = decideFramePolicy(facts(), { ...rules, requestedOrigins: ['https://evil.example'] });
    expect(none.kind).toBe('safe');
  });

  it('without ancestorOrigins, serves a listed cross-origin parent through the origin check on each message', () => {
    const d = decideFramePolicy(facts(), { deployerOrigins: ['https://portal.example'] });
    expect(d).toEqual({ kind: 'bridge', origins: [OWN, 'https://portal.example'], parentVerified: false });
  });
});

describe('parseOriginList and the build-time list', () => {
  it('keeps http(s) origins only, deduplicated', () => {
    expect(parseOriginList('https://a.example/x, *, null, javascript:alert(1), https://a.example, http://b.example:8080')).toEqual([
      'https://a.example',
      'http://b.example:8080',
    ]);
    expect(parseOriginList('')).toEqual([]);
  });

  it('is empty when the build did not define OLV_EMBED_ORIGINS', () => {
    expect(deployerEmbedOrigins()).toEqual([]);
  });

  it('reads the build-time constant when it is defined', () => {
    vi.stubGlobal('__OLV_EMBED_ORIGINS__', 'https://portal.example,*');
    try {
      expect(deployerEmbedOrigins()).toEqual(['https://portal.example']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('readFrameFacts', () => {
  const fake = (over: Record<string, unknown>): Window => over as unknown as Window;

  it('reports an unframed window', () => {
    const win: Record<string, unknown> = { location: { origin: OWN } };
    win.top = win;
    expect(readFrameFacts(fake(win)).framed).toBe(false);
  });

  it('reads ancestorOrigins and a same-origin parent', () => {
    const win = fake({
      top: {},
      location: { origin: OWN, ancestorOrigins: [OWN] },
      parent: { location: { origin: OWN } },
    });
    expect(readFrameFacts(win)).toEqual({ framed: true, ownOrigin: OWN, ancestorOrigins: [OWN], parentSameOrigin: true });
  });

  it('treats a parent whose location throws as cross-origin', () => {
    const parent = {};
    Object.defineProperty(parent, 'location', { get: () => { throw new Error('SecurityError'); } });
    const win = fake({ top: {}, location: { origin: OWN }, parent });
    expect(readFrameFacts(win)).toMatchObject({ framed: true, ancestorOrigins: undefined, parentSameOrigin: false });
  });

  it('treats a throwing window.top as framed', () => {
    const win = {};
    Object.defineProperty(win, 'top', { get: () => { throw new Error('SecurityError'); } });
    Object.assign(win, { location: { origin: OWN }, parent: {} });
    expect(readFrameFacts(win as Window).framed).toBe(true);
  });
});

describe('frame guard', () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeWindow(opts: { framed: boolean; ancestor?: string }) {
    const body = new FakeEl('body');
    const doc = { createElement: (t: string) => new FakeEl(t), body } as unknown as Document;
    const win: Record<string, unknown> = {
      document: doc,
      location: { origin: OWN, pathname: '/viewer/', ancestorOrigins: opts.ancestor ? [opts.ancestor] : undefined },
    };
    const parent = {};
    Object.defineProperty(parent, 'location', { get: () => { throw new Error('SecurityError'); } });
    win.parent = opts.framed ? parent : win;
    win.top = opts.framed ? parent : win;
    return { win: win as unknown as Window, body };
  }

  it('leaves an unframed page alone', () => {
    const { win, body } = fakeWindow({ framed: false });
    expect(enforceFramePolicy(win)).toBe(true);
    expect(body.children).toHaveLength(0);
  });

  it('replaces a page framed by an unlisted origin with a notice and a link to its own tab', () => {
    const { win, body } = fakeWindow({ framed: true, ancestor: 'https://attacker.example' });
    expect(enforceFramePolicy(win)).toBe(false);
    expect(body.children).toHaveLength(1);
    const link = body.querySelector('a') as unknown as { href: string; target: string; rel: string };
    expect(link.href).toBe(`${OWN}/viewer/`);
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(body.textContent).toContain('not shown inside this page');
  });

  it('lets a page framed by a listed origin start', () => {
    vi.stubGlobal('__OLV_EMBED_ORIGINS__', 'https://portal.example');
    const { win, body } = fakeWindow({ framed: true, ancestor: 'https://portal.example' });
    expect(enforceFramePolicy(win)).toBe(true);
    expect(body.children).toHaveLength(0);
  });

  it('renders the notice without markup from the page', () => {
    const body = new FakeEl('body');
    const doc = { createElement: (t: string) => new FakeEl(t), body } as unknown as Document;
    renderFramedNotice(doc, 'https://viewer.example/');
    expect(body.innerHTML).toBe('');
  });
});
