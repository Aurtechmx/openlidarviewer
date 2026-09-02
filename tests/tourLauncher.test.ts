import { describe, it, expect, vi } from 'vitest';
import { createTourLauncher } from '../src/app/tourLauncher';
import type { TourHandle } from '../src/ui/onboarding/bootTour';

function harness() {
  const handle: TourHandle = { start: vi.fn(), replay: vi.fn() };
  const bootTour = vi.fn(() => handle);
  const load = vi.fn(async () => ({ bootTour }));
  return { handle, bootTour, load, launcher: createTourLauncher(load) };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createTourLauncher', () => {
  it('does not load the chunk until an entry point fires', () => {
    const { load } = harness();
    expect(load).not.toHaveBeenCalled();
  });

  it('boots on first start and forwards the call', async () => {
    const { load, bootTour, handle, launcher } = harness();
    launcher.start();
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(bootTour).toHaveBeenCalledTimes(1);
    expect(handle.start).toHaveBeenCalledTimes(1);
  });

  it('boots exactly once across start and replay, in either order', async () => {
    const { load, bootTour, handle, launcher } = harness();
    launcher.replay();
    launcher.start();
    launcher.replay();
    await settle();
    // One import, one session: replay-after-start reuses the booted tour, the
    // behaviour the eager boot used to guarantee.
    expect(load).toHaveBeenCalledTimes(1);
    expect(bootTour).toHaveBeenCalledTimes(1);
    expect(handle.replay).toHaveBeenCalledTimes(2);
    expect(handle.start).toHaveBeenCalledTimes(1);
  });
});
