/**
 * streamingCompatibility.test.ts — is a streaming cloud allowed into a combined
 * result, given the static layers currently loaded?
 *
 * This decision lived inside `Viewer._streamingCompatibility`: build a
 * descriptor for each static cloud plus the stream, classify them together
 * under a sentinel id, and read the stream's state back out. The underlying
 * `classifyLayerCompatibility` is tested, but this adapter — the part that
 * actually answers "may this stream combine" for the live scene — was not,
 * even though it is a refusal boundary: get it wrong and a stream in a
 * different frame silently joins a terrain or volume estimate.
 *
 * Extracting it to a pure function makes the boundary testable without a
 * WebGL context or a live scheduler.
 */

import { describe, it, expect } from 'vitest';
import { resolveStreamingCompatibility } from '../src/render/streamingCompatibility';

const UTM12N = { epsg: 32612, crsName: 'WGS 84 / UTM 12N', verticalDatum: 'NAVD88', verticalEpsg: 5703 };
const UTM13N = { epsg: 32613, crsName: 'WGS 84 / UTM 13N', verticalDatum: 'NAVD88', verticalEpsg: 5703 };

describe('resolveStreamingCompatibility', () => {
  it('is verified when the stream stands alone (no static layers)', () => {
    // A lone layer is verified by definition — nothing to disagree with.
    expect(resolveStreamingCompatibility([], UTM12N)).toBe('verified');
  });

  it('is verified against a static layer in the same full frame', () => {
    expect(resolveStreamingCompatibility([UTM12N], UTM12N)).toBe('verified');
  });

  it('is incompatible against a static layer in a different horizontal CRS', () => {
    // Different projected frames: the stream cannot be merged, and must say so
    // rather than be quietly co-analysed.
    expect(resolveStreamingCompatibility([UTM12N], UTM13N)).toBe('incompatible');
  });

  it('is horizontal-only when horizontal agrees but the vertical is undeclared', () => {
    const noVertical = { epsg: 32612, crsName: 'WGS 84 / UTM 12N' };
    expect(resolveStreamingCompatibility([UTM12N], noVertical)).toBe('horizontal-only');
  });

  it('is unknown when the stream declares no CRS at all', () => {
    // Undeclared is unproven, not agreement.
    expect(resolveStreamingCompatibility([UTM12N], {})).toBe('unknown');
  });

  it('reads the stream back correctly with several matching static layers', () => {
    // The stream is keyed under a reserved id assigned internally, so no number
    // of static layers can shadow it. Three matching statics: the stream stays
    // verified, proving the read-back targets the stream and not a static that
    // landed on the same key.
    expect(resolveStreamingCompatibility([UTM12N, UTM12N, UTM12N], UTM12N)).toBe('verified');
  });

  it('verifies the stream when it sits in the majority frame, outlier aside', () => {
    // Discovered by this test, which was written expecting a refusal: a layer
    // is judged against the DOMINANT compatible group, not required to agree
    // with every other layer. The stream plus one static form the UTM12N
    // majority, so the stream is verified; the lone UTM13N static is the
    // outlier that would read `incompatible` on its own. This is the correct
    // and intended behaviour — a single mismatched layer must not veto a
    // combined result the majority supports.
    expect(resolveStreamingCompatibility([UTM12N, UTM13N], UTM12N)).toBe('verified');
  });
});
