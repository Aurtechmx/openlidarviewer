/**
 * stageUrlErrors.test.ts: the copy under the Stage's URL field. An empty Open
 * names every entry point the field takes, and a CORS block on an EPT dataset
 * or a tileset says the fix is at the host, since a dataset of many files
 * cannot be downloaded and opened as one.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { tilesetStatusMessage } from '../src/app/openTilesetLayer';
import { URL_FIELD_EMPTY_MESSAGE, UrlFieldMessage, friendlyUrlError } from '../src/ui/Stage';

describe('URL field copy', () => {
  it('names the three entry points when Open is pressed with nothing typed', () => {
    expect(URL_FIELD_EMPTY_MESSAGE).toBe(
      'Enter a URL to a .copc.laz file, an EPT dataset (ept.json) or a 3D Tiles tileset (tileset.json).',
    );
  });

  it('tells an EPT or tileset user to ask the host about CORS, and a COPC user that a download works too', () => {
    const cors = new Error('blocked by CORS policy');
    expect(friendlyUrlError(cors, 'https://h.example/d/ept.json')).toBe(
      'This host blocks browser access. Ask the host to allow CORS for this site.',
    );
    expect(friendlyUrlError(cors, 'https://h.example/d/tileset.json?v=2')).toBe(
      'This host blocks browser access. Ask the host to allow CORS for this site.',
    );
    expect(friendlyUrlError(cors, 'https://h.example/d/scan.copc.laz')).toMatch(/downloading the file/);
  });

  it('keeps the other mappings and falls back to the raw message', () => {
    expect(friendlyUrlError(new Error('404 Not Found'), 'https://h.example/a.copc.laz')).toMatch(/No file found/);
    expect(friendlyUrlError(new Error('Something specific happened.'), '')).toBe('Something specific happened.');
  });

  it('shows a message already written for the user as it stands', () => {
    const range = 'This server ignored the range request and returned the whole file. Try hosting the file on an object store or a static host.';
    expect(friendlyUrlError(new UrlFieldMessage(range), 'https://h.example/a.copc.laz')).toBe(range);
    const transport = 'Could not reach the host. The host also needs to allow cross-origin (CORS) requests from this site.';
    expect(friendlyUrlError(new UrlFieldMessage(transport), 'https://h.example/a.copc.laz')).toBe(transport);
  });

  it('lets every press reach the handler, so the field gives its own reason', () => {
    // Read from source: this suite runs without a DOM.
    const src = readFileSync(new URL('../src/ui/Stage.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/form\.noValidate = true;\s*form\.addEventListener\('submit'/);
  });

  it('says a tileset is missing rather than corrupt, and leaves other failures to the classifier', () => {
    expect(tilesetStatusMessage(new Error('3D Tiles tileset fetch failed (404 Not Found) for https://h/x'))).toMatch(/No file found/);
    expect(tilesetStatusMessage(new Error('3D Tiles tileset fetch failed (403 Forbidden) for https://h/x'))).toMatch(/refused access/);
    expect(tilesetStatusMessage(new Error('3D Tiles tileset fetch failed (503 Busy) for https://h/x'))).toBeNull();
    expect(tilesetStatusMessage(new Error('other'))).toBeNull();
  });
});
