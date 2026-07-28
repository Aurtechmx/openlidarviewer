#!/usr/bin/env node
/**
 * verify-archive-portability.mjs — check the RELEASED SOURCE ARCHIVE, from a
 * copy of it that has no repository around it.
 *
 * The defect this exists to catch has shipped: `lint:release-truth` read a file
 * that `.gitattributes` export-ignored, so the published zip failed its own
 * declared verification while the working-tree gate stayed green. Every other
 * release check in this repo runs in the working tree, where the excluded file
 * is still on disk, so none of them could see it.
 *
 * So the unit of work here is an extracted archive in a temp directory outside
 * the repository. `resolveArchive()` refuses a directory that is inside the
 * repository or that carries a .git, which removes the silent fallback: a check
 * that accidentally reads the working tree cannot pass by looking at the wrong
 * files, because there are no other files to look at.
 *
 * Three checks legitimately need the repository — the export-ignore inventory
 * (computed by differencing tracked files against archive contents) and the
 * two determinism rebuilds. They are marked `needsRepo` and are skipped, not
 * silently passed, when the repository is absent.
 *
 * Usage:
 *   npm run benchmark:archive-portability
 *   node scripts/verify-archive-portability.mjs --archive <dir> --json <path>
 *   node scripts/verify-archive-portability.mjs --keep     # leave the extract
 *
 * Exit code is 0 when no check reports an `error` finding. `warn` findings are
 * reported and do not fail. Machine-readable result is written to
 * release/archive-portability.json by default.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname, join, relative, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

// ── pure helpers (exercised by tests/benchmark/archivePortability.test.ts) ────

/** Bare package name of an import specifier, or null for a relative/absolute one. */
export function bareSpecifier(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/')) return null;
  if (spec.startsWith('node:') || spec.startsWith('data:') || spec.startsWith('http')) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Relative link and include targets in a markdown file, as archive-relative
 * paths. Anchors, query strings, external URLs, mailto and bare fragments are
 * dropped; a `path#section` include keeps the path.
 */
export function markdownTargets(text, fromRelPath) {
  const dir = posix.dirname(fromRelPath);
  const out = [];
  const push = (raw, kind) => {
    let t = raw.trim();
    if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('#') || t.startsWith('//')) return;
    t = t.split('#')[0].split('?')[0];
    if (!t) return;
    let base = dir;
    if (t.startsWith('/')) {
      // A site-absolute link inside docs-site/ addresses the site root.
      // Elsewhere it addresses a deployed URL, not a file in the archive.
      if (!fromRelPath.startsWith('docs-site/')) return;
      base = 'docs-site';
      t = t.slice(1);
    }
    out.push({ kind, target: posix.normalize(posix.join(base, t)) });
  };
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) push(m[1], 'link');
  for (const m of text.matchAll(/<!--\s*@include:\s*([^\s>]+?)\s*-->/g)) push(m[1], 'include');
  return out;
}

/**
 * Candidate archive paths a markdown target may denote. VitePress links are
 * extensionless and directory links mean the directory's index page, so a
 * target resolves if any candidate ships.
 */
export function linkCandidates(target) {
  const t = target.replace(/\/$/, '');
  return [target, t, `${t}.md`, `${t}/index.md`];
}

/** Import specifiers in a source file, comments stripped so prose cannot look like an import. */
export function importSpecifiers(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out = [];
  const add = (m) => { for (const x of code.matchAll(m)) out.push(x[1]); };
  add(/^\s*import\s+[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm);
  add(/^\s*import\s*['"]([^'"]+)['"]/gm);
  add(/^\s*export\s+[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm);
  add(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g);
  add(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g);
  add(/\bvi\.mock\(\s*['"]([^'"]+)['"]/g);
  return out;
}

/** Files a package.json script tree tells a reader to execute, as repo-relative paths. */
export function scriptFileTargets(scripts) {
  const out = new Set();
  const text = Object.values(scripts).join('\n');
  for (const m of text.matchAll(/\b(?:node|bash|sh|python3)\s+(?:"?\$ROOT\/)?((?:scripts|benchmarks|tests)\/[\w./-]+)/g)) out.add(m[1]);
  for (const m of text.matchAll(/\b(?:vitest run|playwright test[^\n&|]*?)\s+((?:tests|benchmarks)\/[\w./-]+\.(?:test\.ts|spec\.ts))/g)) out.add(m[1]);
  for (const m of text.matchAll(/(?:^|\s)((?:tests|benchmarks)\/[\w./-]+\.(?:test|spec)\.ts)/g)) out.add(m[1]);
  return [...out];
}

/** `npm run <name>` invocations named in prose. */
/**
 * Does any of `texts` read `name` out of node_modules? Each text is a shipped
 * non-JS file that mentions node_modules at all. A scoped package may be
 * assembled one path segment at a time, so the scope and the bare name are
 * looked for separately rather than as one joined string. Every text is
 * already known to mention node_modules, which is what keeps a bare name like
 * "three" from matching unrelated prose.
 */
export function readsPackageFromNodeModules(texts, name) {
  const [scope, bare] = name.startsWith('@') ? name.split('/') : [null, name];
  return texts.some((t) => (scope == null ? t.includes(bare) : t.includes(scope) && t.includes(bare)));
}

export function documentedScripts(text) {
  return [...text.matchAll(/npm run ([a-z0-9][a-z0-9:_-]*)/g)].map((m) => m[1]);
}

/**
 * The repository paths MANIFEST.md declares the archive to carry.
 *
 * MANIFEST.md is the archive's own inventory: every document it names in a
 * code span is a promise to the reader that the file is in the deposit. The
 * tokens are taken literally — one code span, no spaces, path characters only
 * — so prose in code spans (`npm run gate`, a version string with a space)
 * never enters the list. A trailing slash marks a directory and is kept, so
 * the caller can tell "this file ships" from "something under here ships".
 *
 * Release-asset names such as `release-manifest-v0.6.2.json` come out of here
 * too; the caller drops anything the repository does not track, because a file
 * that is not in the tree cannot have been export-ignored out of the archive.
 */
export function manifestInventoryPaths(text) {
  const out = new Set();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const tok = m[1].trim();
    if (!/^[A-Za-z0-9][\w.@-]*(?:\/[\w.@-]+)*\/?$/.test(tok)) continue;
    out.add(tok);
  }
  return [...out];
}

// ── archive acquisition ──────────────────────────────────────────────────────

function listFiles(root, base = root) {
  const out = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else if (e.isFile()) out.push(relative(base, p).split(/[\\/]/).join('/'));
  }
  return out;
}

const hasRepo = (() => {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: REPO, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

const git = (args, opts = {}) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28, ...opts });

/**
 * Produce the directory the checks run against, and refuse anything that could
 * make a check read the working tree instead.
 */
function resolveArchive(explicit, keep) {
  let dir;
  let built = false;
  if (explicit) {
    dir = resolve(explicit);
  } else {
    if (!hasRepo) {
      console.error('✗ no repository and no --archive: nothing to extract. Pass --archive <extracted-dir>.');
      process.exit(2);
    }
    const tmp = mkdtempSync(join(tmpdir(), 'olv-archive-'));
    const tar = git(['archive', '--format=tar', '--prefix=archive/', 'HEAD'], { encoding: 'buffer' });
    writeFileSync(join(tmp, 'src.tar'), tar);
    execFileSync('tar', ['-xf', join(tmp, 'src.tar'), '-C', tmp]);
    rmSync(join(tmp, 'src.tar'));
    dir = join(tmp, 'archive');
    built = true;
    if (keep) console.log(`  extracted archive kept at ${dir}`);
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`✗ archive directory does not exist: ${dir}`);
    process.exit(2);
  }
  // Structural guard: no working-tree fallback is reachable from here.
  const rel = relative(REPO, dir);
  if (rel === '' || !rel.startsWith('..')) {
    console.error(`✗ refusing to check ${dir}: it is inside the repository. The archive must be extracted outside it.`);
    process.exit(2);
  }
  if (existsSync(join(dir, '.git'))) {
    console.error(`✗ refusing to check ${dir}: it carries a .git. An archive has no repository around it.`);
    process.exit(2);
  }
  return { dir, built };
}

// ── check harness ────────────────────────────────────────────────────────────

const checks = [];
const check = (id, title, fn, opts = {}) => checks.push({ id, title, fn, ...opts });

/** True when a markdown target denotes something the archive actually carries. */
const resolves = (c, target) => linkCandidates(target).some((p) => c.set.has(p) || existsSync(join(c.A, p)));

function makeCtx(A) {
  const files = listFiles(A).sort();
  const set = new Set(files);
  const read = (p) => (set.has(p) ? readFileSync(join(A, p), 'utf8') : null);
  const pkg = JSON.parse(readFileSync(join(A, 'package.json'), 'utf8'));
  const markdown = files.filter((f) => f.endsWith('.md'));
  return { A, files, set, read, pkg, markdown };
}

// ── 1. self-containment: everything the archive tells you to run is in it ────

check('scripts-present', 'every file the archive’s own package.json scripts execute ships in the archive', (c) => {
  const f = [];
  for (const t of scriptFileTargets(c.pkg.scripts)) {
    if (!c.set.has(t)) f.push({ level: 'error', message: `package.json scripts run "${t}", which is not in the archive.` });
  }
  return f;
});

check('documented-scripts-exist', 'every `npm run` command named in shipping documentation exists in the archive’s package.json', (c) => {
  const f = [];
  const known = new Set(Object.keys(c.pkg.scripts));
  for (const md of c.markdown) {
    if (md.startsWith('docs/_audit/')) continue;
    for (const name of new Set(documentedScripts(c.read(md)))) {
      if (!known.has(name)) f.push({ level: 'error', message: `${md} documents "npm run ${name}", which the archive’s package.json does not define.` });
    }
  }
  return f;
});

/**
 * Run the archive's own dependency-free verification, inside the archive.
 * A tool that cannot start is recorded as unrun rather than counted as a pass,
 * because an unrunnable check is not a green one: `needs-install` without
 * node_modules, `needs-build` without a bundle, `needs-repo` when the check's
 * subject is the repository the archive was cut from.
 */
check('archive-self-verification', 'the archive’s own node-only verification scripts run and pass inside the archive', (c) => {
  const f = [];
  const ran = [];
  // Excluded, each for a reason checked against the script's own usage text:
  //   verify-archive-portability — this script; running it here would recurse.
  //   release:verify — verify-release-assets.mjs takes `-- --dir <staging>`;
  //     a source archive carries no staged asset directory to point it at.
  //   release:manifest, gen:claim-registry, docs:render — generators, not checks.
  const NEEDS_ARGS_OR_GENERATES = new Set([
    'scripts/verify-archive-portability.mjs',
    'scripts/verify-release-assets.mjs',
    'scripts/create-release-manifest.mjs',
    // build-validation-snapshot writes a directory; verify-validation-snapshot
    // is the check over what it wrote, and that one does run here.
    'scripts/build-validation-snapshot.mjs',
    'scripts/generate-claim-registry.mjs',
    'scripts/render-claim-register.mjs',
    // test-file.mjs prints `usage: test-file.mjs <file.test.ts ...>` and exits
    // non-zero with no arguments; it is a runner, not a check.
    'scripts/test-file.mjs',
  ]);
  const candidates = Object.entries(c.pkg.scripts)
    .filter(([, cmd]) => /^node scripts\/[\w.-]+\.mjs$/.test(cmd))
    .map(([name, cmd]) => ({ name, script: cmd.replace(/^node /, '') }))
    .filter(({ script }) => !NEEDS_ARGS_OR_GENERATES.has(script));
  for (const { name, script } of candidates) {
    if (!c.set.has(script)) {
      f.push({ level: 'error', message: `npm run ${name} runs ${script}, absent from the archive.` });
      continue;
    }
    let out = '';
    let code = 0;
    try {
      out = execFileSync('node', [script], { cwd: c.A, encoding: 'utf8', stdio: 'pipe', timeout: 300_000 });
    } catch (e) {
      code = e.status ?? 1;
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    // A tool that cannot start without an installed tree or a built bundle is
    // recorded as unrun, not as a pass. An unrunnable check is not a green one.
    if (code !== 0 && /Cannot find package|ERR_MODULE_NOT_FOUND|node_modules not found/.test(out)) {
      ran.push({ name, status: 'needs-install' });
      continue;
    }
    if (code !== 0 && /No build found/.test(out)) {
      ran.push({ name, status: 'needs-build' });
      continue;
    }
    // A check whose subject is the repository cannot run against an extract by
    // definition: the extract is what it would have been asked to produce.
    if (code !== 0 && /needs a git repository|not a git repository/.test(out)) {
      ran.push({ name, status: 'needs-repo' });
      continue;
    }
    // A check whose input is produced by the gate this check runs inside
    // cannot be evaluated from within that gate: on a version bump the
    // figures are stale until a passing run regenerates them, and the run
    // cannot pass while the check reads them. `npm run evidence` runs it
    // after collection, which is where the comparison is meaningful.
    if (code !== 0 && /Re-run "npm run evidence"/.test(out)) {
      ran.push({ name, status: 'needs-gate-run' });
      continue;
    }
    ran.push({ name, status: code === 0 ? 'pass' : 'fail', exit: code });
    if (code !== 0) {
      f.push({ level: 'error', message: `npm run ${name} exits ${code} inside the extracted archive:\n${out.trim().split('\n').slice(-12).join('\n')}` });
    }
  }
  return { findings: f, detail: { ran } };
});

// ── 2. exclusion correctness, both directions ────────────────────────────────

const INTERNAL = [
  { re: /READINESS_REPORT/, what: 'readiness report' },
  { re: /(^|\/)docs\/_audit\//, what: 'internal audit' },
  { re: /-plan\.md$/, what: 'internal plan' },
  { re: /HANDOFF|_PRIVATE|GITHUB-PUBLISH-CHECKLIST|ROADMAP-INTERNAL/, what: 'internal working note' },
  { re: /(^|\/)node_modules\//, what: 'vendored dependency tree' },
  { re: /(^|\/)(dist|coverage|test-results|playwright-report)\//, what: 'build or test output' },
  { re: /^release\//, what: 'generated release output' },
];

check('no-internal-material', 'nothing internal or generated ships in the archive', (c) => {
  const f = [];
  for (const p of c.files) {
    for (const { re, what } of INTERNAL) {
      if (re.test(p)) f.push({ level: 'error', message: `${p} is ${what} and must not ship.` });
    }
  }
  return f;
});

/**
 * The direction that has failed before: a file that DOES ship pointing at a
 * file that does not. A markdown link or a VitePress include is an error — it
 * dangles for the reader. A path named in source or tooling is a warning: the
 * archive still builds, but it cites a document the reader cannot open.
 */
check('no-dangling-references-to-excluded', 'nothing that ships references a file that does not', (c) => {
  const f = [];
  const tracked = git(['ls-files']).split('\n').filter(Boolean);
  const excluded = tracked.filter((p) => !c.set.has(p)).sort();
  for (const md of c.markdown) {
    for (const { kind, target } of markdownTargets(c.read(md), md)) {
      if (resolves(c, target)) continue;
      const why = excluded.includes(target) ? 'excluded from the archive by .gitattributes export-ignore' : 'not in the archive';
      f.push({ level: 'error', message: `${md} ${kind === 'include' ? 'includes' : 'links to'} ${target}, ${why}.` });
    }
  }
  // Markdown is scanned here as well as through its links. A shipped document
  // that names an excluded file in prose or in a code span — no link syntax
  // around it — used to be read by neither loop: `markdownTargets` only sees
  // link and include syntax, and this scan only saw source and tooling. That
  // is exactly how a governing document can be export-ignored while three
  // shipped files still tell the reader to go and read it.
  const codeFiles = c.files.filter((p) => /\.(ts|mts|mjs|js|sh|json|yaml|yml|md)$/.test(p));
  for (const p of excluded) {
    if (p === '.gitattributes') continue;
    for (const cf of codeFiles) {
      const text = c.read(cf);
      if (text && text.includes(p)) {
        f.push({ level: 'warn', message: `${cf} names ${p}, which is export-ignored and absent from the archive.` });
      }
    }
  }
  return { findings: f, detail: { excludedCount: excluded.length, excluded } };
}, { needsRepo: true });

/**
 * The archive against its own inventory.
 *
 * The dangling-reference check above answers "does anything shipped point at
 * something absent", which degrades to a warning for a prose mention and so
 * cannot, on its own, fail a release. This one asks the stronger question the
 * deposit actually makes: MANIFEST.md tells a reader what the archive holds,
 * so every path it names that the repository TRACKS must be in the archive.
 * Tracked-but-absent is one thing and one thing only — an export-ignore that
 * deleted a declared document — and it is an error, never a warning.
 *
 * Untracked names are skipped rather than flagged: `SHA256SUMS` and the
 * per-release manifest are attached to the release, not committed, so their
 * absence from a source archive is correct.
 */
check('manifest-inventory-ships', 'every tracked path MANIFEST.md declares is in the archive', (c) => {
  const f = [];
  const text = c.read('MANIFEST.md');
  if (text === null) return [{ level: 'error', message: 'MANIFEST.md is not in the archive.' }];
  const tracked = git(['ls-files']).split('\n').filter(Boolean);
  const trackedFiles = new Set(tracked);
  const trackedDirs = new Set();
  for (const p of tracked) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) trackedDirs.add(parts.slice(0, i).join('/'));
  }
  const declared = [];
  for (const tok of manifestInventoryPaths(text)) {
    const p = tok.replace(/\/$/, '');
    if (trackedFiles.has(p)) {
      declared.push({ token: tok, kind: 'file' });
      if (!c.set.has(p)) {
        f.push({ level: 'error', message: `MANIFEST.md declares ${tok}, which the repository tracks but the archive does not carry.` });
      }
    } else if (trackedDirs.has(p)) {
      declared.push({ token: tok, kind: 'directory' });
      if (!c.files.some((q) => q.startsWith(`${p}/`))) {
        f.push({ level: 'error', message: `MANIFEST.md declares ${tok}, which the repository tracks but the archive carries nothing from.` });
      }
    }
  }
  if (declared.length === 0) {
    f.push({ level: 'error', message: 'MANIFEST.md declares no tracked path at all — the inventory check has nothing to verify.' });
  }
  return { findings: f, detail: { declared } };
}, { needsRepo: true });

// ── 3. doc-link integrity across everything that ships ───────────────────────

check('doc-links-resolve', 'every relative link in shipping markdown resolves to a file that also ships', (c) => {
  const f = [];
  for (const md of c.markdown) {
    for (const { kind, target } of markdownTargets(c.read(md), md)) {
      if (resolves(c, target)) continue;
      f.push({ level: 'error', message: `${md}: ${kind} target ${target} is absent from the archive.` });
    }
  }
  return f;
});

// ── 4. manifest accuracy, both directions ────────────────────────────────────

/**
 * Every checksum manifest that ships must account for its directory in both
 * directions: nothing listed is missing or altered, and nothing present is
 * unlisted. A one-directional verifier passes an archive with an extra file.
 */
check('checksum-manifests-bidirectional', 'every shipped SHA256SUMS accounts for its directory in both directions', (c) => {
  const f = [];
  const detail = [];
  const manifests = c.files.filter((p) => p.endsWith('/SHA256SUMS') || p === 'SHA256SUMS');
  if (manifests.length === 0) f.push({ level: 'error', message: 'the archive carries no checksum manifest at all.' });
  for (const m of manifests) {
    const dir = posix.dirname(m);
    const listed = new Map();
    for (const line of c.read(m).split('\n')) {
      const hit = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
      if (hit) listed.set(posix.normalize(posix.join(dir, hit[2].trim())), hit[1]);
    }
    for (const [p, want] of listed) {
      if (!c.set.has(p)) {
        f.push({ level: 'error', message: `${m} lists ${p}, absent from the archive.` });
        continue;
      }
      const got = createHash('sha256').update(readFileSync(join(c.A, p))).digest('hex');
      if (got !== want) f.push({ level: 'error', message: `${m}: ${p} hashes ${got}, manifest says ${want}.` });
    }
    const siblings = c.files.filter((p) => posix.dirname(p) === dir && p !== m && !p.endsWith('.md'));
    for (const p of siblings) {
      if (!listed.has(p)) f.push({ level: 'error', message: `${m} does not account for ${p}, which sits beside it in the archive.` });
    }
    detail.push({ manifest: m, listed: listed.size, siblings: siblings.length });
  }
  return { findings: f, detail };
});

// ── 5. determinism ───────────────────────────────────────────────────────────

check('archive-determinism', 'building the archive twice from the same commit yields identical bytes', () => {
  const f = [];
  const digest = () => createHash('sha256').update(git(['archive', '--format=tar', '--prefix=archive/', 'HEAD'], { encoding: 'buffer' })).digest('hex');
  const a = digest();
  const b = execFileSync('git', ['archive', '--format=tar', '--prefix=archive/', 'HEAD'], {
    cwd: REPO,
    encoding: 'buffer',
    maxBuffer: 1 << 28,
    env: { ...process.env, TZ: 'Asia/Kolkata', LC_ALL: 'C.UTF-8' },
  });
  const bHash = createHash('sha256').update(b).digest('hex');
  if (a !== bHash) f.push({ level: 'error', message: `two git archive runs of HEAD differ: ${a} vs ${bHash}.` });
  return { findings: f, detail: { tarSha256: a, secondRunEnv: 'TZ=Asia/Kolkata LC_ALL=C.UTF-8' } };
}, { needsRepo: true });

// ── 6. dependency honesty ────────────────────────────────────────────────────

check('lockfile-consistent', 'the lockfile ships and agrees with package.json', (c) => {
  const f = [];
  const lockText = c.read('package-lock.json');
  if (lockText == null) return [{ level: 'error', message: 'package-lock.json is not in the archive; the dependency set is not pinned for a reader.' }];
  const lock = JSON.parse(lockText);
  if (lock.name !== c.pkg.name) f.push({ level: 'error', message: `lockfile names "${lock.name}", package.json names "${c.pkg.name}".` });
  if (lock.version !== c.pkg.version) f.push({ level: 'error', message: `lockfile version ${lock.version} disagrees with package.json ${c.pkg.version}.` });
  const rootPkg = lock.packages?.[''] ?? {};
  for (const kind of ['dependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(c.pkg[kind] ?? {})) {
      if ((rootPkg[kind] ?? {})[name] !== range) {
        f.push({ level: 'error', message: `lockfile root ${kind} entry for ${name} is ${(rootPkg[kind] ?? {})[name]}, package.json says ${range}.` });
      }
      if (!lock.packages?.[`node_modules/${name}`]) {
        f.push({ level: 'error', message: `lockfile has no resolved entry for ${name}; npm ci from this archive would not be reproducible.` });
      }
    }
  }
  return f;
});

check('imports-declared', 'every package the archive imports is a declared dependency', (c) => {
  const f = [];
  const declared = new Set([...Object.keys(c.pkg.dependencies ?? {}), ...Object.keys(c.pkg.devDependencies ?? {})]);
  const used = new Set();
  const sources = c.files.filter((p) => /^(src|tests|scripts|benchmarks|docs-site)\/.*\.(ts|mts|tsx|mjs|js)$/.test(p) || /^[\w.-]+\.(ts|mts|mjs|js)$/.test(p));
  for (const p of sources) {
    for (const spec of importSpecifiers(c.read(p))) {
      const b = bareSpecifier(spec);
      if (!b) continue;
      used.add(b);
      if (!declared.has(b)) f.push({ level: 'error', message: `${p} imports "${b}", which is not declared in package.json.` });
    }
  }
  // A package can be consumed by path rather than by import: a build script
  // that reads a font file out of node_modules writes no import specifier, and
  // may assemble the path one segment at a time so no full package name ever
  // appears as a single string. Scanning imports alone reports such a package
  // as unused, which is true of the import graph and false of the archive.
  const byPath = new Set();
  const nonJs = c.files
    .filter((p) => /\.(py|sh|ya?ml|css|html)$/.test(p))
    .map((p) => c.read(p))
    .filter((t) => t != null && t.includes('node_modules'));
  for (const name of Object.keys(c.pkg.dependencies ?? {})) {
    if (used.has(name)) continue;
    if (readsPackageFromNodeModules(nonJs, name)) {
      byPath.add(name);
      continue;
    }
    f.push({ level: 'warn', message: `runtime dependency "${name}" is declared but nothing in the archive imports it or reads it out of node_modules.` });
  }
  return { findings: f, detail: { imported: [...used].sort(), readByPath: [...byPath].sort() } };
});

check('sbom-matches-manifest', 'the SBOM ships and covers the declared dependency set', (c) => {
  const text = c.read('sbom.json');
  if (text == null) return [{ level: 'warn', message: 'sbom.json is not in the archive.' }];
  const f = [];
  const sbom = JSON.parse(text);
  const byName = new Map((sbom.components ?? []).map((k) => [k.group ? `${k.group}/${k.name}` : k.name, k]));
  if (sbom.metadata?.component?.version && sbom.metadata.component.version !== c.pkg.version) {
    f.push({ level: 'error', message: `sbom.json describes version ${sbom.metadata.component.version}, package.json says ${c.pkg.version}.` });
  }
  for (const name of Object.keys(c.pkg.dependencies ?? {})) {
    if (!byName.has(name)) f.push({ level: 'error', message: `sbom.json has no component for runtime dependency ${name}.` });
  }
  return { findings: f, detail: { components: byName.size } };
});

// ── 7. version coherence ─────────────────────────────────────────────────────

check('version-coherence', 'package.json, the citation file, the changelog and the versioned documents agree', (c) => {
  const f = [];
  const v = c.pkg.version;
  const cff = c.read('CITATION.cff');
  if (cff == null) f.push({ level: 'error', message: 'CITATION.cff is not in the archive.' });
  else {
    const m = cff.match(/^version:\s*"?([^"\n]+)"?/m);
    if (!m) f.push({ level: 'error', message: 'CITATION.cff states no version.' });
    else if (m[1].trim() !== v) f.push({ level: 'error', message: `CITATION.cff version ${m[1].trim()} disagrees with package.json ${v}.` });
  }
  const changelog = c.read('CHANGELOG.md');
  if (changelog == null) f.push({ level: 'error', message: 'CHANGELOG.md is not in the archive.' });
  else if (!new RegExp(`^##\\s*\\[${v.replace(/\./g, '\\.')}\\]`, 'm').test(changelog)) {
    f.push({ level: 'error', message: `CHANGELOG.md has no released section for ${v}.` });
  }
  for (const doc of [`RELEASE_NOTES_v${v}.md`, `KNOWN_LIMITATIONS_v${v}.md`, `VALIDATION_REPORT_v${v}.md`, `REPRODUCIBILITY_v${v}.md`]) {
    if (!c.set.has(doc)) f.push({ level: 'error', message: `${doc} is not in the archive; the release’s own evidence set is incomplete.` });
  }
  const manifestDoc = c.read('MANIFEST.md');
  if (manifestDoc == null) f.push({ level: 'error', message: 'MANIFEST.md is not in the archive.' });
  else {
    for (const m of manifestDoc.matchAll(/v(\d+\.\d+\.\d+(?:-[\w.]+)?)/g)) {
      if (m[1] !== v) f.push({ level: 'error', message: `MANIFEST.md names v${m[1]}, but this archive is v${v}.` });
    }
  }
  // A CITATION date must match the changelog entry for the same version.
  if (cff && changelog) {
    const cffDate = cff.match(/^date-released:\s*"?([\d-]+)"?/m)?.[1];
    const clDate = changelog.match(new RegExp(`^##\\s*\\[${v.replace(/\./g, '\\.')}\\]\\s*-\\s*([\\d-]+)`, 'm'))?.[1];
    if (cffDate && clDate && cffDate !== clDate) {
      f.push({ level: 'error', message: `CITATION.cff date-released ${cffDate} disagrees with the CHANGELOG entry for ${v} (${clDate}).` });
    }
  }
  return f;
});

// ── run ──────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const keep = argv.includes('--keep');
  const only = arg('--only');
  const { dir: A, built } = resolveArchive(arg('--archive'), keep);
  const jsonPath = resolve(arg('--json') ?? join(REPO, 'release/archive-portability.json'));

  console.log(`Archive portability — checking ${A}`);
  console.log(`  repository present: ${hasRepo ? 'yes' : 'no'}\n`);

  const ctx = makeCtx(A);
  const results = [];
  for (const c of checks) {
    if (only && c.id !== only) continue;
    if (c.needsRepo && !hasRepo) {
      results.push({ id: c.id, title: c.title, status: 'skipped', reason: 'requires the repository', findings: [] });
      console.log(`  ○ ${c.id} — skipped (requires the repository)`);
      continue;
    }
    let raw;
    try {
      raw = c.fn(ctx);
    } catch (e) {
      raw = [{ level: 'error', message: `check threw: ${e.message}` }];
    }
    const findings = Array.isArray(raw) ? raw : raw.findings;
    const detail = Array.isArray(raw) ? undefined : raw.detail;
    const errors = findings.filter((x) => x.level === 'error');
    const warns = findings.filter((x) => x.level === 'warn');
    const status = errors.length ? 'fail' : 'pass';
    results.push({ id: c.id, title: c.title, status, errors: errors.length, warnings: warns.length, findings, detail });
    const mark = status === 'pass' ? (warns.length ? '!' : '✓') : '✗';
    console.log(`  ${mark} ${c.id} — ${c.title}`);
    for (const x of findings) console.log(`      [${x.level}] ${x.message}`);
  }

  const totalErrors = results.reduce((n, r) => n + (r.errors ?? 0), 0);
  const totalWarnings = results.reduce((n, r) => n + (r.warnings ?? 0), 0);
  const out = {
    suite: 'archive-portability',
    generatedAt: new Date().toISOString(),
    // The extract lives in a per-user temp directory whose name carries a
    // host identifier, and this file ships inside the archive it describes.
    // The path is recorded relative to the temp root.
    archiveDir: A.replace(tmpdir(), '<temp>').replace('/private/var/folders', '<temp>').replace('/var/folders', '<temp>'),
    archiveBuiltHere: built,
    repositoryPresent: hasRepo,
    nodeVersion: process.version,
    version: ctx.pkg.version,
    fileCount: ctx.files.length,
    totals: {
      checks: results.length,
      passed: results.filter((r) => r.status === 'pass').length,
      failed: results.filter((r) => r.status === 'fail').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      errors: totalErrors,
      warnings: totalWarnings,
    },
    results,
  };
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(out, null, 2)}\n`);

  console.log(`\n${totalErrors === 0 ? '✓' : '✗'} ${out.totals.passed} passed, ${out.totals.failed} failed, ${out.totals.skipped} skipped — ${totalErrors} errors, ${totalWarnings} warnings`);
  console.log(`  result: ${relative(REPO, jsonPath) || jsonPath}`);
  if (built && !keep) rmSync(dirname(A), { recursive: true, force: true });
  else if (built) console.log(`  extract kept: ${A}`);
  process.exit(totalErrors === 0 ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
