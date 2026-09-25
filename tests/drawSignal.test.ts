import { expect, test, vi } from 'vitest';
import { noteDrawn, onNextDraw } from '../src/render/drawSignal';

test('a draw callback fires once, on the next drawn frame only', () => {
  const cb = vi.fn();
  onNextDraw(cb);
  expect(cb).not.toHaveBeenCalled();
  noteDrawn();
  noteDrawn();
  expect(cb).toHaveBeenCalledTimes(1);
});
