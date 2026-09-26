/**
 * remoteDeepLink.test.ts
 *
 * The shared remote-URL validator and the deep-link confirmation gate. Every
 * remote entry (URL field, `?copc=` deep link, catalog, and the EPT / 3D Tiles
 * validators that delegate to it) goes through `validateRemoteCopcUrl`.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { validateRemoteCopcUrl, isLocalDevPage } from '../src/io/range/RangeSource';
import { validateRemoteEptUrl } from '../src/io/ept/eptUrlValidation';
import type { ConfirmOptions } from '../src/ui/Modal';

vi.mock('../src/ui/Modal', () => ({ openConfirm: vi.fn() }));
const { confirmDeepLinkedRemote, deepLinkHost } = await import('../src/app/remoteDeepLink');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('validateRemoteCopcUrl', () => {
  it('accepts https', () => {
    expect(validateRemoteCopcUrl('https://data.example.org/a.copc.laz').ok).toBe(true);
  });

  it('refuses http on a deployed page and accepts it on a loopback dev page', () => {
    vi.stubGlobal('location', { hostname: 'viewer.example.org' });
    expect(isLocalDevPage()).toBe(false);
    expect(validateRemoteCopcUrl('http://data.example.org/a.copc.laz').ok).toBe(false);
    vi.stubGlobal('location', { hostname: 'localhost' });
    expect(isLocalDevPage()).toBe(true);
    expect(validateRemoteCopcUrl('http://data.example.org/a.copc.laz').ok).toBe(true);
    vi.stubGlobal('location', { hostname: '127.0.0.1' });
    expect(validateRemoteCopcUrl('http://data.example.org/a.copc.laz').ok).toBe(true);
  });

  it('refuses other schemes even on a dev page', () => {
    vi.stubGlobal('location', { hostname: 'localhost' });
    for (const u of ['ftp://h/a', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,x', 'blob:https://h/x']) {
      expect(validateRemoteCopcUrl(u).ok).toBe(false);
    }
  });

  it('refuses a username or password', () => {
    expect(validateRemoteCopcUrl('https://user@data.example.org/a.copc.laz').ok).toBe(false);
    expect(validateRemoteCopcUrl('https://user:pw@data.example.org/a.copc.laz').ok).toBe(false);
    expect(validateRemoteCopcUrl('https://:pw@data.example.org/a.copc.laz').ok).toBe(false);
  });

  it('refuses private and loopback hosts, and over-long URLs', () => {
    expect(validateRemoteCopcUrl('https://127.0.0.1/a.copc.laz').ok).toBe(false);
    expect(validateRemoteCopcUrl('https://169.254.169.254/latest').ok).toBe(false);
    expect(validateRemoteCopcUrl(`https://h.example.org/${'a'.repeat(3000)}`).ok).toBe(false);
  });

  it('is the validator EPT delegates to', () => {
    expect(validateRemoteEptUrl('http://data.example.org/ept.json').ok).toBe(false);
    expect(validateRemoteEptUrl('https://u:p@data.example.org/ept.json').ok).toBe(false);
  });
});

describe('confirmDeepLinkedRemote', () => {
  it('asks with the host only, and opens only on confirm', async () => {
    const seen: ConfirmOptions[] = [];
    const url = 'https://data.example.org:8443/deep/path/scan.copc.laz?sig=secret';
    const yes = await confirmDeepLinkedRemote(url, async (o) => (seen.push(o), true));
    expect(yes).toEqual({ kind: 'open', url });
    expect(seen[0].title).toBe('Open remote dataset from data.example.org:8443?');
    expect(seen[0].confirmLabel).toBe('Open');
    expect(seen[0].cancelLabel).toBe('Cancel');
    const text = JSON.stringify(seen[0]);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('/deep/path');
    expect(seen[0].confirmTip).toBeTruthy();
    expect(seen[0].cancelTip).toBeTruthy();
  });

  it('reports cancel without opening', async () => {
    const r = await confirmDeepLinkedRemote('https://data.example.org/a.copc.laz', async () => false);
    expect(r).toEqual({ kind: 'cancelled' });
  });

  it('refuses an invalid URL without asking', async () => {
    const confirm = vi.fn(async () => true);
    const r = await confirmDeepLinkedRemote('http://user:pw@data.example.org/a.copc.laz', confirm);
    expect(r.kind).toBe('invalid');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('shows the host, not the URL', () => {
    expect(deepLinkHost('https://a.example.org/x/y?z=1')).toBe('a.example.org');
  });
});
