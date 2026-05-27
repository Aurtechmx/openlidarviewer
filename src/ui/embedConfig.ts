/**
 * embedConfig.ts
 *
 * Parses the URL query string into a typed embed configuration — the stable,
 * documented surface for embedding OpenLiDARViewer in an `<iframe>`.
 *
 * Supported parameters:
 *   ?embed=1           strip the top bar and chrome
 *   ?ui=minimal        hide the dock and panels, keep the canvas and nav
 *   ?annotations=1     keep the annotations panel visible
 *   ?measurements=1    keep the measurements panel visible
 *   ?autoload=sample:<id>   autoload a built-in sample on startup
 *   ?theme=dark        select a theme (only `dark` exists today)
 *
 * `?autoload` resolves `sample:` ids; the remote-URL load path uses the
 * separate `?copc=<url>` parameter, which routes to the `PointCloudSource`
 * abstraction for both COPC and EPT entries.
 *
 * Pure — unit-tested in Node.
 */

/** The viewer theme. Only `dark` exists; the type is the seam for future ones. */
export type ViewerTheme = 'dark';

/** The parsed embed configuration. */
export interface EmbedConfig {
  /** `?embed=1` — strip the top bar and surrounding chrome. */
  embed: boolean;
  /** `?ui=minimal` — hide the tool dock and side panels. */
  uiMinimal: boolean;
  /** `?annotations=1` — keep the annotations panel visible. */
  forceAnnotations: boolean;
  /** `?measurements=1` — keep the measurements panel visible. */
  forceMeasurements: boolean;
  /** Built-in sample id to autoload (`?autoload=sample:<id>`), or null. */
  autoloadSample: string | null;
  /** Selected theme. */
  theme: ViewerTheme;
}

/** A query flag is on when present and not explicitly `0` / `false`. */
function flag(params: URLSearchParams, key: string): boolean {
  if (!params.has(key)) return false;
  const value = params.get(key);
  return value !== '0' && value !== 'false';
}

/**
 * Parse an embed configuration from a URL query string (e.g.
 * `window.location.search`).
 */
export function parseEmbedConfig(search: string): EmbedConfig {
  const params = new URLSearchParams(search);

  // `?autoload=sample:<id>` — only built-in samples in v0.2.9.
  const autoload = params.get('autoload');
  const autoloadSample =
    autoload && autoload.startsWith('sample:') ? autoload.slice('sample:'.length) : null;

  return {
    embed: flag(params, 'embed'),
    uiMinimal: params.get('ui') === 'minimal',
    forceAnnotations: flag(params, 'annotations'),
    forceMeasurements: flag(params, 'measurements'),
    autoloadSample: autoloadSample && autoloadSample.length > 0 ? autoloadSample : null,
    // Only `dark` exists; an unrecognised value falls back to it.
    theme: 'dark',
  };
}
