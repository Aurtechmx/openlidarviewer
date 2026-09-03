#!/usr/bin/env node
/**
 * lint-canonical-urls.mjs — the project's current identity is stated in several
 * files, and they must name the same URLs.
 *
 * v0.6.8 moved the project to its own domain: the docs became the canonical
 * site at the apex, the viewer moved to a subdomain, and the previous host
 * became a redirect. Those URLs are written by hand in package.json, CodeMeta,
 * CITATION.cff, the Zenodo record, the shipped page's OpenGraph tags, the
 * documentation site and the app itself. Nothing tied them together, so one
 * could be updated and the rest left behind.
 *
 * HISTORY IS NOT DRIFT. A release note, a frozen evidence record or an old
 * manifest that names the previous host is a true statement about the release
 * it describes, and rewriting it would make the record dishonest. Those paths
 * are exempt by prefix, not by pattern, so the exemption is a list someone has
 * to add to deliberately.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : null);

/** The one place the canonical names are written down. */
export const CANONICAL = {
  project: 'https://openlidarviewer.org/',
  app: 'https://app.openlidarviewer.org/',
  source: 'https://github.com/Aurtechmx/openlidarviewer',
};

/** The superseded hosts. Present in history, never in current metadata. */
const SUPERSEDED = [/lidar\.aurtech\.mx/, /aurtechmx\.github\.io\/openlidarviewer/];

/**
 * Paths whose job is to preserve what was true earlier. A release note for a
 * shipped version, the frozen validation snapshot, and generated evidence all
 * describe a past state.
 */
const HISTORICAL = [
  'validation/snapshot/',
  'docs/_audit/',
  'docs/validation/evidence/',
  'docs/releases/RELEASE_NOTES_v0.5.',
  'docs/releases/RELEASE_NOTES_v0.6.0',
  'docs/releases/RELEASE_NOTES_v0.6.1',
  'docs/releases/RELEASE_NOTES_v0.6.2',
  'docs/releases/RELEASE_NOTES_v0.6.3',
  'docs/releases/RELEASE_NOTES_v0.6.4',
  'docs/releases/RELEASE_NOTES_v0.6.5',
  'docs/releases/RELEASE_NOTES_v0.6.6',
  'docs/releases/RELEASE_NOTES_v0.6.7',
  'docs-site/releases/v0.5',
  'docs-site/releases/v0.6.0',
  'docs-site/releases/v0.6.1',
  'docs-site/releases/v0.6.2',
  'docs-site/releases/v0.6.3',
  'docs-site/releases/v0.6.4',
  'docs-site/releases/v0.6.5',
  'docs-site/releases/v0.6.6',
  'docs-site/releases/v0.6.7',
];
export const isHistorical = (rel) => HISTORICAL.some((h) => rel.startsWith(h));

const failures = [];
const must = (ok, msg) => { if (!ok) failures.push(msg); };

// ── Each current-metadata surface names the right URL ────────────────────────
const pkg = JSON.parse(read('package.json') ?? '{}');
must(pkg.homepage === CANONICAL.project,
  `package.json homepage is ${pkg.homepage}, expected ${CANONICAL.project}`);

const meta = JSON.parse(read('codemeta.json') ?? '{}');
must(meta.url === CANONICAL.project,
  `codemeta.json url is ${meta.url}, expected ${CANONICAL.project}`);
must(meta.codeRepository === CANONICAL.source,
  `codemeta.json codeRepository is ${meta.codeRepository}, expected ${CANONICAL.source}`);

const cff = read('CITATION.cff') ?? '';
must(cff.includes(`url: "${CANONICAL.project}"`),
  `CITATION.cff url does not name ${CANONICAL.project}`);

const zen = JSON.parse(read('.zenodo.json') ?? '{}');
const zenIds = JSON.stringify(zen);
must(zenIds.includes(CANONICAL.project),
  `.zenodo.json does not name ${CANONICAL.project}`);

// ── The shipped page points at the app, not at the docs ──────────────────────
const html = read('index.html') ?? '';
must(html.includes(`<meta property="og:url" content="${CANONICAL.app}" />`),
  `index.html og:url does not name ${CANONICAL.app}`);
must(html.includes(`<link rel="canonical" href="${CANONICAL.app}" />`),
  `index.html has no canonical link naming ${CANONICAL.app}`);

// ── The docs site serves the apex ────────────────────────────────────────────
const vp = read('docs-site/.vitepress/config.mts') ?? '';
must(/base:\s*process\.env\.DOCS_BASE\s*\?\?\s*'\/'/.test(vp),
  "docs-site base is not '/' — the apex needs a root base");
must((read('docs-site/public/CNAME') ?? '').trim() === 'openlidarviewer.org',
  'docs-site/public/CNAME does not name openlidarviewer.org — Pages will not answer on the domain');

// ── The old host still redirects ─────────────────────────────────────────────
const ht = read('public/.htaccess') ?? '';
must(/RewriteCond\s+%\{HTTP_HOST\}.*lidar\\?\.aurtech\\?\.mx/.test(ht),
  'public/.htaccess has no host-conditional rule for lidar.aurtech.mx');
must(/RewriteRule.*app\.openlidarviewer\.org.*R=30[18]/.test(ht),
  'public/.htaccess does not permanently redirect the old host to the app');

// ── No current surface offers a superseded host as the place to go ───────────
// Two strengths, because the surfaces differ in kind.
//
// STRICT surfaces are metadata and configuration: a machine reads them and a
// superseded host there is simply wrong, whatever the surrounding words say.
//
// PROSE surfaces are documents a person reads. They may NAME the old host,
// because describing a move requires naming what moved, but only alongside
// wording that marks it as the previous address. Announcing the redirect is
// the whole point of the release note; presenting the old host as the current
// one is the defect. Without this split the lint forbids the sentence the
// release exists to publish.
const STRICT_SURFACES = [
  'package.json', 'codemeta.json', 'CITATION.cff', '.zenodo.json', 'index.html',
  'public/llms.txt', 'public/robots.txt', 'docs-site/index.md', 'src/ui/Stage.ts',
];
const PROSE_SURFACES = [
  'README.md', 'docs/usage.md', 'docs-site/guide/index.md',
  'docs/releases/RELEASE_NOTES_v0.6.8.md', 'docs-site/releases/v0.6.8.md',
];
/** Wording that marks a mention as historical rather than as a destination. */
const MOVED = /redirect|keeps working|previous host|formerly|used to|no longer|moved|earlier release/i;

for (const rel of [...STRICT_SURFACES, ...PROSE_SURFACES]) {
  if (isHistorical(rel)) continue;
  const text = read(rel);
  if (text == null) { failures.push(`${rel} is missing`); continue; }
  const prose = PROSE_SURFACES.includes(rel);
  text.split('\n').forEach((l, i) => {
    if (!SUPERSEDED.some((pat) => pat.test(l))) return;
    if (prose && MOVED.test(l)) return;
    failures.push(
      `${rel}:${i + 1} names a superseded host${prose ? ' without marking it as the previous address' : ''}: ${l.trim().slice(0, 90)}`,
    );
  });
}
const CURRENT_SURFACES = [...STRICT_SURFACES, ...PROSE_SURFACES];

if (failures.length > 0) {
  console.error(`lint:canonical-urls FAILED — ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  • ${f}`);
  console.error('\nHistorical records keep the host they shipped with. Only current');
  console.error('identity moves; see the HISTORICAL list in this script.');
  process.exit(1);
}
console.log(`lint:canonical-urls OK — project ${CANONICAL.project}, app ${CANONICAL.app}, ${CURRENT_SURFACES.length} surfaces agree.`);
