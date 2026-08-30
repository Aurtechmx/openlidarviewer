/**
 * backendLabel.test.ts — the one place the GPU backend is turned into text.
 *
 * Two readouts named the same backend two different ways: the tool dock showed
 * "WebGL2", the debug overlay "WebGL 2". This pins a single canonical label both
 * consume, so the app can never disagree with itself about which backend is live.
 */
import { describe, it, expect } from 'vitest';
import { backendLabel } from '../src/ui/backendLabel';

describe('backendLabel', () => {
  it('names each backend canonically', () => {
    expect(backendLabel('webgpu')).toBe('WebGPU');
    expect(backendLabel('webgl2')).toBe('WebGL 2');
  });

  it('renders an em dash when the backend is not yet known', () => {
    expect(backendLabel(null)).toBe('—');
  });
});
