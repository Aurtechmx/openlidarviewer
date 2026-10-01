import { describe, it, expect, vi } from 'vitest';
import { createTourLauncher } from '../src/app/tourLauncher';
import type { TourHandle } from '../src/ui/onboarding/bootTour';

function harness() {
  const handle: TourHandle = { start: vi.fn(), replay: vi.fn() };
  const bootTour = vi.fn(() => handle);
  const load = vi.fn(async () => ({ bootTour }));
  return { handle, bootTour, load, launcher: createTourLauncher(load, { show: vi.fn() }) };
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

  it('reports a failed load with Try again, and the retry loads the chunk again', async () => {
    const handle: TourHandle = { start: vi.fn(), replay: vi.fn() };
    const load = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error('chunk 404')))
      .mockImplementation(async () => ({ bootTour: () => handle }));
    const toasts: Array<{ message: string; action?: { readonly label: string; readonly onClick: () => void } }> = [];
    const launcher = createTourLauncher(load, { show: (message, action) => { toasts.push({ message, action }); } });
    launcher.replay();
    await settle();
    expect(toasts.map((t) => t.message)).toEqual(['chunk 404']);
    expect(toasts[0].action?.label).toBe('Try again');
    toasts[0].action!.onClick();
    await settle();
    // The failed attempt was not kept, so Try again reached the loader again.
    expect(load).toHaveBeenCalledTimes(2);
    expect(handle.replay).toHaveBeenCalledTimes(1);
  });

  it('loads again when the user presses start a second time after a failure', async () => {
    const handle: TourHandle = { start: vi.fn(), replay: vi.fn() };
    const load = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error('chunk 404')))
      .mockImplementation(async () => ({ bootTour: () => handle }));
    const launcher = createTourLauncher(load, { show: vi.fn() });
    launcher.start();
    await settle();
    launcher.start();
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(handle.start).toHaveBeenCalledTimes(1);
  });
});
