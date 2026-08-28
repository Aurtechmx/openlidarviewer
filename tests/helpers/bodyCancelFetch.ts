/**
 * A fetch whose non-success responses expose a body with a spied `cancel()`,
 * so a test can prove a transport tears the abandoned body down before it
 * retries or throws. A success step returns a real Response the bounded read
 * can consume. Shared by the EPT and 3D Tiles transport suites.
 */
export function bodyCancelFetch(
  steps: Array<{ status: number; body?: string }>,
): { fn: typeof fetch; cancels: number } {
  let i = 0;
  const handle = { cancels: 0, fn: undefined as unknown as typeof fetch };
  handle.fn = (async (_input: RequestInfo | URL): Promise<Response> => {
    const step = steps[Math.min(i++, steps.length - 1)]!;
    if (step.status >= 200 && step.status < 300) {
      return new Response(step.body ?? 'ok', { status: 200, statusText: 'OK' });
    }
    const body = {
      cancel: (): Promise<void> => {
        handle.cancels++;
        return Promise.resolve();
      },
    } as unknown as ReadableStream<Uint8Array>;
    return {
      ok: false,
      status: step.status,
      statusText: 'Err',
      body,
      headers: new Headers(),
    } as unknown as Response;
  }) as typeof fetch;
  return handle;
}
