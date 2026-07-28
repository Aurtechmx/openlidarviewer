/**
 * A preset names the colour mode it moves into, and the mode is not always
 * available. Forcing Classification on a cloud with no classification field
 * renders every point one colour, which reads as a broken renderer rather
 * than as missing data. These tests pin the availability rule itself.
 */

import { describe, expect, it } from 'vitest';

import { cloudSupportsColorMode } from '../src/render/colorModeSupport';

const empty = {};

describe('cloudSupportsColorMode', () => {
  it('requires the attribute each mode reads', () => {
    expect(cloudSupportsColorMode({ colors: new Uint8Array([1, 2, 3]) }, 'rgb')).toBe(true);
    expect(cloudSupportsColorMode(empty, 'rgb')).toBe(false);

    expect(cloudSupportsColorMode({ intensity: new Uint16Array([7]) }, 'intensity')).toBe(true);
    expect(cloudSupportsColorMode(empty, 'intensity')).toBe(false);

    expect(cloudSupportsColorMode({ classification: new Uint8Array([2]) }, 'classification')).toBe(
      true,
    );
    expect(cloudSupportsColorMode(empty, 'classification')).toBe(false);

    expect(cloudSupportsColorMode({ normals: new Float32Array([0, 1, 0]) }, 'normal')).toBe(true);
    expect(cloudSupportsColorMode(empty, 'normal')).toBe(false);

    expect(cloudSupportsColorMode({ gpsTime: new Float64Array([3e8]) }, 'gpsTime')).toBe(true);
    expect(cloudSupportsColorMode(empty, 'gpsTime')).toBe(false);
  });

  it('treats a present-but-empty attribute as absent', () => {
    // A zero-length typed array is what a reader produces for a field the file
    // declared and never filled. It is not data, and colouring by it yields a
    // uniform result rather than an error.
    expect(cloudSupportsColorMode({ colors: new Uint8Array(0) }, 'rgb')).toBe(false);
    expect(cloudSupportsColorMode({ classification: new Uint8Array(0) }, 'classification')).toBe(
      false,
    );
  });

  it('allows modes derived from positions, which every cloud has', () => {
    expect(cloudSupportsColorMode(empty, 'elevation')).toBe(true);
  });

  it('does not suppress a mode it has not been taught about', () => {
    // Falling through to the renderer that owns the mode is the safer default.
    // Returning false here would silently disable a new mode until someone
    // remembered to edit this file.
    expect(cloudSupportsColorMode(empty, 'density' as never)).toBe(true);
  });
});
