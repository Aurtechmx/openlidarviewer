#!/usr/bin/env node
/**
 * serve-deploy-bytes.mjs — serve an EXTRACTED deploy bundle exactly as shipped.
 *
 * The smoke gate builds the application and serves the result of that build.
 * Packaging then builds AGAIN and ships the second build's bytes, so the
 * artifact a user downloads has never been started. Nothing in that chain is
 * wrong individually; together they leave the shipped bundle untested.
 *
 * This server closes that by serving the extracted ZIP and nothing else. It
 * does not compile, bundle, or read `src/`. If a file is missing from the
 * archive, the request 404s and the smoke fails, which is the point.
 *
 * It also applies the bundle's own `_headers`, so the run exercises the
 * Content-Security-Policy the deploy actually ships rather than a permissive
 * dev default. A bundle whose CSP forbids something it needs fails here instead
 * of on the first user's screen.
 *
 * Deliberately dependency-free: adding a static-server package to ship a
 * release would put an untested dependency in the path of the test that exists
 * to prove the release untested-dependency-free.
 *
 * The root and port arrive as OLV_DEPLOY_ROOT / OLV_DEPLOY_PORT rather than as
 * argv, because Playwright's `webServer.command` is a shell string: a directory
 * containing a space would split into two arguments there, and the extraction
 * directory is a system temp path this script does not choose. Environment
 * variables carry the value verbatim, with no quoting to get right.
 *
 * Usage: OLV_DEPLOY_ROOT=<dir> [OLV_DEPLOY_PORT=<port>] node scripts/serve-deploy-bytes.mjs
 *        (argv still works for a manual run: <root-dir> [port])
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(process.env.OLV_DEPLOY_ROOT ?? process.argv[2] ?? '.');
const PORT = Number(process.env.OLV_DEPLOY_PORT ?? process.argv[3] ?? 4173);
if (!existsSync(ROOT)) {
  console.error(`serve-deploy-bytes: ${ROOT} does not exist`);
  process.exit(1);
}

const TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}));

/**
 * Parse the bundle's `_headers` into `[pathGlob, headers]` pairs.
 *
 * Only the shape this file actually uses is supported: a path line in column
 * zero, then indented `Name: value` lines. A trailing `/*` matches by prefix.
 * Unknown syntax is skipped rather than guessed at.
 */
function parseHeaders(root) {
  const file = join(root, '_headers');
  if (!existsSync(file)) return [];
  const sections = [];
  let current = null;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      current = { path: raw.trim(), headers: [] };
      sections.push(current);
      continue;
    }
    const at = raw.indexOf(':');
    if (current && at > 0) {
      current.headers.push([raw.slice(0, at).trim(), raw.slice(at + 1).trim()]);
    }
  }
  return sections;
}

const SECTIONS = parseHeaders(ROOT);

const matches = (pattern, urlPath) => (
  pattern.endsWith('/*') ? urlPath.startsWith(pattern.slice(0, -1)) : pattern === urlPath
);

const server = createServer(async (req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  } catch {
    // A malformed percent-escape threw inside the async handler; the rejection
    // was unhandled and Node exited, so every later smoke request saw
    // ECONNREFUSED and the archive was blamed for a server crash.
    res.writeHead(400).end();
    return;
  }
  // Contain the served path inside ROOT: a `..` segment in a request must not
  // reach a file the archive does not contain, or the smoke would pass on bytes
  // that are not in the bundle.
  const rel = normalize(urlPath).replace(/^([/\\])+/, '');
  const target = resolve(ROOT, rel === '' ? 'index.html' : rel);
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let file = target;
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  let body;
  try {
    body = await readFile(file);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  for (const s of SECTIONS) {
    if (matches(s.path, urlPath)) for (const [k, v] of s.headers) res.setHeader(k, v);
  }
  res.setHeader('Content-Type', TYPES.get(extname(file).toLowerCase()) ?? 'application/octet-stream');
  res.writeHead(200).end(body);
});

// An occupied port must END the run, not be worked around. Playwright is told
// never to reuse an existing server in deploy-root mode, so a port already in
// use means something else would answer for the archive; exiting non-zero makes
// the webServer command fail and takes the smoke down with it.
server.on('error', (err) => {
  const why = err.code === 'EADDRINUSE'
    ? `port ${PORT} is already in use — refusing to let another server answer for the archive`
    : String(err.message ?? err);
  console.error(`serve-deploy-bytes: ${why}`);
  process.exit(1);
});

// Loopback only, and named explicitly. Binding every interface let this
// process take a port that was already in use on 127.0.0.1: the two sockets do
// not collide, no EADDRINUSE is raised, and which server answers `localhost` is
// then a matter of resolution order. The smoke would sometimes be driving
// whatever else was listening. It also has no business being reachable off the
// machine.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`serve-deploy-bytes: ${ROOT} on http://127.0.0.1:${PORT}`
    + ` (${SECTIONS.length} _headers section(s) applied)`);
});
