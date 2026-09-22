#!/usr/bin/env node
/**
 * marker-server.mjs — serves the triangle page and takes its one callback.
 *
 * `xcrun simctl openurl` puts a page in front of Safari; nothing gives the
 * workflow a way to ask that page how it went. `document.title` is readable
 * from a screenshot but not from a shell step, so the triangle page also
 * pings this server when it finishes, and the ping is what a script can
 * actually check. A file rather than an in-memory flag, because the check
 * happens from a later, separate `xcrun` invocation, possibly after this
 * process has taken the hit if Safari's crash also disturbs the host side.
 *
 * `vite preview` already serves the OLV build; this exists only because that
 * build has nothing to do with a standalone triangle page, and adding a
 * route to it would mean shipping test-only code in the real app.
 *
 * `/mark` also takes the OLV build's own post-load render ping
 * (`src/app/testAutoload.ts`), from a page `vite preview` serves on a
 * different port — a cross-origin fetch, hence the CORS header below. The
 * marker write it triggers is a server-side side effect of the request
 * landing at all, so a browser that withheld the response from that page's
 * JS (no preflight is needed for a header-less GET) would still have left
 * the same line in the log; the header only lets the page's own `.catch()`
 * see success too.
 */
import { createServer } from 'node:http';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

import { isCliEntry } from '../lib/isCliEntry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(resolve(HERE, 'webgl-triangle.html'));
const PORT = Number(process.env.OLV_MARKER_PORT ?? 4174);
const MARKER_LOG = resolve(process.env.OLV_MARKER_LOG ?? resolve(HERE, 'triangle-marker.log'));

mkdirSync(dirname(MARKER_LOG), { recursive: true });

export function startMarkerServer({ port = PORT, markerLog = MARKER_LOG } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/mark') {
      const ok = url.searchParams.get('ok');
      const reason = url.searchParams.get('reason') ?? '';
      appendFileSync(markerLog, `${new Date().toISOString()} ok=${ok} reason=${reason}\n`);
      res.writeHead(204, { 'access-control-allow-origin': '*' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
  });
  server.listen(port);
  return server;
}

if (isCliEntry(import.meta.url)) {
  startMarkerServer();
  process.stdout.write(`marker server on http://127.0.0.1:${PORT}/webgl-triangle.html, log at ${MARKER_LOG}\n`);
}
