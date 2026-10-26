/**
 * stageUrlErrors.test.ts: the copy under the Stage's URL field. An empty Open
 * names every entry point the field takes, and a CORS block on an EPT dataset
 * or a tileset says the fix is at the host, since a dataset of many files
 * cannot be downloaded and opened as one.
 */
import { describe, expect, it } from 'vitest';

import { URL_FIELD_EMPTY_MESSAGE, friendlyUrlError } from '../src/ui/Stage';

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
});
