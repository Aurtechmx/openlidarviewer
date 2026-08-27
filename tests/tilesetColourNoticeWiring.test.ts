import { describe, expect, it } from 'vitest';

import { PntsChunkDecoder } from '../src/io/tiles3d/pntsDecode';

/**
 * The mixed-colour guard settles a layer's colour meaning on its first tile with
 * points and holds it. That keeps the scene honest on its own, but a user who
 * dropped a coloured tileset and got a grey patch is owed the reason. The decoder
 * reports it through `onColourNotice`; the open path has to pass one, or the
 * guard is correct and silent.
 *
 * This reads the shipped source rather than driving a decode, because the wiring
 * is one argument at one call site and the failure mode is that nobody passed it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const openTilesetLayerSrc = readFileSync(
  fileURLToPath(new URL('../src/app/openTilesetLayer.ts', import.meta.url)),
  'utf8',
);

describe('the tileset open passes a colour notice sink', () => {
  it('constructs the decoder with an onColourNotice callback', () => {
    const construction = openTilesetLayerSrc.match(/new PntsChunkDecoder\([^;]{0,300}\),/);
    expect(construction, 'openTilesetLayer no longer constructs a PntsChunkDecoder').not.toBeNull();
    expect(
      construction?.[0],
      'the decoder is constructed with no colour-notice sink, so a mixed tileset ' +
        'is drawn honestly and the user is never told why',
    ).toMatch(/onColourNotice/);
  });

  it('routes it to a surface the user actually sees', () => {
    const construction = openTilesetLayerSrc.match(/new PntsChunkDecoder\([^;]{0,300}\),/);
    expect(construction?.[0]).toMatch(/showToast/);
  });

  it('the decoder still accepts the option it is handed', () => {
    const seen: string[] = [];
    expect(() => new PntsChunkDecoder({ onColourNotice: (m) => seen.push(m) })).not.toThrow();
  });
});
