/**
 * viteDefines.mjs: the build-time constants whose value depends on the build
 * mode or the environment, kept out of vite.config.ts so they can be tested.
 */

/**
 * Whether the Playwright seam (`window.__OLV_TEST_API__`, `?test=1`) is compiled
 * in. On for the dev server and for a build that opts in with OLV_TEST_SEAM=1
 * (the Playwright web server). Never on for `--mode live`, the deployed build:
 * an OLV_TEST_SEAM=1 left exported in a packaging shell must not reach users.
 *
 * @param {string} mode the Vite mode
 * @param {Record<string, string | undefined>} env the process environment
 */
export function testSeamEnabled(mode, env) {
  if (mode === 'live') return false;
  return mode === 'development' || env.OLV_TEST_SEAM === '1';
}

/**
 * The deployer's embed allow-list: the origins of the http(s) URLs in the
 * comma-separated `OLV_EMBED_ORIGINS`. Empty by default, which allows
 * same-origin framing only. Entries that are not http(s) origins (`*`, a bare
 * host, a `javascript:` URL) are dropped, and the build says so.
 *
 * @param {string | undefined} raw
 * @returns {{ origins: string[], dropped: string[] }}
 */
export function parseEmbedOrigins(raw) {
  const origins = [];
  const dropped = [];
  for (const entry of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    let origin = null;
    try {
      const u = new URL(entry);
      if (u.protocol === 'https:' || u.protocol === 'http:') origin = u.origin;
    } catch {
      origin = null;
    }
    if (origin === null) dropped.push(entry);
    else if (!origins.includes(origin)) origins.push(origin);
  }
  return { origins, dropped };
}
