/**
 * swUrl.test.ts
 *
 * The service-worker script URL must resolve relative to the PAGE, not the
 * origin root — the app builds with Vite `base: './'` and deploys under
 * sub-paths (GitHub Pages `…/repo/`). The old literal `'/sw.js'` registration
 * 404'd on every sub-path deploy (external-review finding, v0.5.3).
 */

import { describe, it, expect } from 'vitest';
import { serviceWorkerUrl } from '../src/app/swUrl';

describe('serviceWorkerUrl', () => {
  it('resolves to the origin root for a root deploy', () => {
    expect(serviceWorkerUrl('https://viewer.example/')).toBe('https://viewer.example/sw.js');
    expect(serviceWorkerUrl('https://viewer.example/index.html')).toBe(
      'https://viewer.example/sw.js',
    );
  });

  it('stays inside a sub-path deploy (GitHub Pages)', () => {
    expect(serviceWorkerUrl('https://user.github.io/openlidarviewer/')).toBe(
      'https://user.github.io/openlidarviewer/sw.js',
    );
    expect(serviceWorkerUrl('https://user.github.io/openlidarviewer/index.html')).toBe(
      'https://user.github.io/openlidarviewer/sw.js',
    );
  });

  it('ignores query and hash on the page URL (deep links)', () => {
    expect(
      serviceWorkerUrl('https://user.github.io/repo/?copc=https%3A%2F%2Fdata%2Fscan.laz#view'),
    ).toBe('https://user.github.io/repo/sw.js');
  });

  it('handles nested sub-paths', () => {
    expect(serviceWorkerUrl('https://host.example/tools/viewer/v2/')).toBe(
      'https://host.example/tools/viewer/v2/sw.js',
    );
  });

  it('never escapes to the origin root from a sub-path (the v0.5.3 bug shape)', () => {
    const url = serviceWorkerUrl('https://user.github.io/repo/');
    expect(url).not.toBe('https://user.github.io/sw.js');
    expect(new URL(url).pathname).toBe('/repo/sw.js');
  });
});
