import { defineConfig } from 'vitepress';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * VitePress config for the OpenLiDARViewer docs site.
 *
 * This build is entirely separate from the app build: it has its own entry
 * (`npm run docs:dev` / `docs:build` / `docs:preview`), never touches
 * vite.config.ts, and ships nothing into the app bundle.
 *
 * Source strategy — opt-in by construction. The site's pages live under
 * docs-site/ and are thin wrappers that `<!--@include: ...-->` the canonical
 * markdown from docs/ and the repo root, so there is exactly one authoritative
 * copy of every document and the site can never fork it. Because srcDir is
 * docs-site/ itself, a repo document is published only when a wrapper page
 * explicitly includes it; docs/_audit/**, the internal plan documents, and
 * research notes are unpublishable unless someone deliberately writes a
 * wrapper for them. scripts/lint-docs-site.mjs enforces that no wrapper ever
 * does, and that the built output stays clean.
 */

/** Version display is derived from package.json at build time — never hardcoded. */
const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string; description: string };

const GITHUB = 'https://github.com/Aurtechmx/openlidarviewer';

/**
 * The canonical docs cross-link each other by repo-relative filename
 * (e.g. `[streaming](streaming.md)`), which is correct on GitHub but does not
 * match the site's URL layout once the file is included by a wrapper page.
 * This explicit map rewrites each known target (matched by basename, anchor
 * preserved) to its published page; the map lives here — next to the sidebar
 * that defines the layout — so adding a page and its remap is one edit.
 */
const CANONICAL_LINKS: Record<string, string> = {
  'USER_GUIDE.md': '/guide/user-guide',
  'usage.md': '/guide/measurement-analysis',
  'navigation.md': '/guide/navigation',
  'terrain-intelligence.md': '/guide/terrain-intelligence',
  'contour-studio.md': '/guide/contour-studio',
  'streaming.md': '/guide/streaming',
  'mobile-browser-support.md': '/guide/mobile',
  'supported-formats.md': '/formats/',
  'EVIDENCE_MODEL.md': '/validation/',
  'cross-implementation.md': '/validation/cross-implementation',
  'THREATS_TO_VALIDITY.md': '/validation/threats-to-validity',
  'METHOD_VERSIONS.md': '/validation/method-versions',
  'METHOD_REGISTRY.md': '/validation/method-versions',
  'terrain-validation-matrix.md': '/validation/terrain-validation-matrix',
  'REPRODUCIBILITY.md': '/reproducibility/',
  'ARTIFACT_EVALUATION.md': '/reproducibility/artifact-evaluation',
  'DATA_AVAILABILITY.md': '/reproducibility/data-availability',
  'REVIEWER_QUICKSTART.md': '/reproducibility/reviewer-quickstart',
  'architecture.md': '/reference/architecture',
  'performance.md': '/reference/performance',
  'benchmarks.md': '/reference/benchmarks',
  'limitations.md': '/reference/limitations',
  'CHANGELOG.md': '/releases/',
  // Documents that are deliberately NOT published (developer/internal) keep
  // working by pointing at the repository copy instead of a dead page.
  'developer-manual.md': `${GITHUB}/blob/main/docs/developer-manual.md`,
  'CONTRIBUTING.md': `${GITHUB}/blob/main/CONTRIBUTING.md`,
  'SECURITY.md': `${GITHUB}/blob/main/SECURITY.md`,
  'claim-register.yaml': `${GITHUB}/blob/main/docs/validation/claim-register.yaml`,
};

/**
 * Release pages are one wrapper per RELEASE_NOTES_v*.md; derive the sidebar
 * from the files on disk (newest first) so a new release only adds a wrapper.
 */
const releasePages = readdirSync(new URL('../releases', import.meta.url))
  .filter((f) => /^v\d[\d.]*\.md$/.test(f))
  .map((f) => f.replace(/\.md$/, ''))
  .sort((a, b) => {
    const pa = a.slice(1).split('.').map(Number);
    const pb = b.slice(1).split('.').map(Number);
    return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
  });

export default defineConfig({
  title: 'OpenLiDARViewer',
  description: pkg.description,

  // Project-pages subpath (https://aurtechmx.github.io/openlidarviewer/).
  // If the site later moves to its own docs subdomain (e.g. docs.aurtech.mx
  // via a CNAME on the Pages branch), set DOCS_BASE=/ in the docs workflow —
  // nothing else changes.
  base: process.env.DOCS_BASE ?? '/openlidarviewer/',

  // The canonical documents also link to files that exist only in the
  // repository (source files, the developer manual, other unpublished docs).
  // Known targets are remapped to real pages or GitHub above; the long tail is
  // tolerated rather than failing the build, because the alternative is
  // forking the canonical files just to edit their links.
  ignoreDeadLinks: true,

  // The generated claim-register partial is INCLUDED by validation/claim-register.md;
  // excluding it here keeps the raw partial from also publishing as its own page.
  srcExclude: ['validation/claim-register.generated.md'],

  markdown: {
    // The canonical documents are plain markdown written for GitHub, where
    // prose like `"Declared: <value>"` renders as text. VitePress pages are
    // Vue templates, so an unbackticked <placeholder> would otherwise be
    // parsed as an unclosed element and fail the build. None of the included
    // documents use raw inline HTML (verified), so raw HTML is disabled and
    // markdown-it escapes those angle brackets back into visible text.
    html: false,

    config(md) {
      // Rewrite canonical repo-relative links (see CANONICAL_LINKS above).
      const defaultRender =
        md.renderer.rules.link_open ??
        ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
      md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const href = tokens[idx].attrGet('href');
        if (href && !/^[a-z]+:/i.test(href) && !href.startsWith('/') && !href.startsWith('#')) {
          const [path, anchor] = href.split('#');
          const base = path.split('/').pop() ?? '';
          const mapped = CANONICAL_LINKS[base];
          if (mapped) {
            tokens[idx].attrSet('href', anchor ? `${mapped}#${anchor}` : mapped);
          } else if (/(^|\/)(src|tests|scripts|benchmarks|docs)\//.test(path)) {
            // A source-tree or unpublished-doc link has no page here; send it
            // to the repository copy rather than a dead relative path.
            const repoPath = path.replace(/^(\.\.?\/)+/, '');
            tokens[idx].attrSet('href', `${GITHUB}/blob/main/${repoPath}`);
          }
        }
        return defaultRender(tokens, idx, options, env, self);
      };
    },
  },

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/', activeMatch: '^/guide/' },
      { text: 'Formats', link: '/formats/', activeMatch: '^/formats/' },
      { text: 'Scientific validation', link: '/validation/', activeMatch: '^/validation/' },
      { text: 'Reproducibility', link: '/reproducibility/', activeMatch: '^/reproducibility/' },
      { text: 'Reference', link: '/reference/architecture', activeMatch: '^/reference/' },
      { text: 'Releases', link: '/releases/', activeMatch: '^/releases/' },
      // Build-time version display, straight from package.json.
      { text: `v${pkg.version}`, link: `/releases/v${pkg.version}` },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Quickstart', link: '/guide/' },
            { text: 'User guide', link: '/guide/user-guide' },
            { text: 'Navigation', link: '/guide/navigation' },
            { text: 'Measurement & analysis', link: '/guide/measurement-analysis' },
            { text: 'Terrain intelligence', link: '/guide/terrain-intelligence' },
            { text: 'Contour Studio', link: '/guide/contour-studio' },
            { text: 'Streaming (COPC + EPT)', link: '/guide/streaming' },
            { text: 'Mobile', link: '/guide/mobile' },
          ],
        },
      ],
      '/formats/': [{ text: 'Formats', items: [{ text: 'Supported formats', link: '/formats/' }] }],
      '/validation/': [
        {
          text: 'Scientific validation',
          items: [
            { text: 'Evidence model', link: '/validation/' },
            { text: 'Claim register', link: '/validation/claim-register' },
            { text: 'Internal vs independent', link: '/validation/cross-implementation' },
            { text: 'Threats to validity', link: '/validation/threats-to-validity' },
            { text: 'Method versions & registry', link: '/validation/method-versions' },
            { text: 'Terrain validation matrix', link: '/validation/terrain-validation-matrix' },
          ],
        },
      ],
      '/reproducibility/': [
        {
          text: 'Reproducibility & artifacts',
          items: [
            { text: 'Reproducibility', link: '/reproducibility/' },
            { text: 'Artifact evaluation', link: '/reproducibility/artifact-evaluation' },
            { text: 'Data availability', link: '/reproducibility/data-availability' },
            { text: 'Reviewer quickstart', link: '/reproducibility/reviewer-quickstart' },
            { text: 'Validation report', link: '/reproducibility/validation-report' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Architecture', link: '/reference/architecture' },
            { text: 'Performance', link: '/reference/performance' },
            { text: 'Benchmarks', link: '/reference/benchmarks' },
            { text: 'Embed & session reference', link: '/reference/embed-session' },
            { text: 'Limitations', link: '/reference/limitations' },
          ],
        },
      ],
      '/releases/': [
        {
          text: 'Releases',
          items: [
            { text: 'Changelog', link: '/releases/' },
            ...releasePages.map((v) => ({ text: v, link: `/releases/${v}` })),
          ],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: GITHUB }],

    footer: {
      message: 'MIT licensed. Local-first: the viewer never uploads your data.',
      copyright: `© Aurtech — OpenLiDARViewer v${pkg.version}`,
    },

    search: { provider: 'local' },
  },
});
