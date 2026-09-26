/**
 * sourceLink.mjs: point the credits page at the source of the exact build.
 *
 * AGPL-3.0 section 13 asks that users interacting with the program over a
 * network be offered its corresponding source. A link to the repository root
 * names whatever main is today; this names the commit the running build was
 * cut from, or the release tag when the commit is unknown.
 */

export const REPO_URL = 'https://github.com/aurtechmx/openlidarviewer';

/** The source URL and a short label for one build identity. */
export function sourceRefFor(identity) {
  const known = identity.commit && identity.commit !== 'unknown';
  const ref = known ? identity.commit : `v${identity.version}`;
  const label = known
    ? ` (v${identity.version}, commit ${identity.commit}${identity.dirty ? ', with local changes' : ''})`
    : ` (v${identity.version})`;
  return { url: `${REPO_URL}/tree/${ref}`, label };
}

/** Rewrite every `data-olv-source` link and label in an HTML page. */
export function stampSourceLinks(html, identity) {
  const { url, label } = sourceRefFor(identity);
  return html
    .replace(/<a data-olv-source href="[^"]*"/g, `<a data-olv-source href="${url}"`)
    .replace(/<span data-olv-source-label><\/span>/g, `<span data-olv-source-label>${label}</span>`);
}
