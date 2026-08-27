/**
 * localOocWorkerHandler.ts — the message handling for the out-of-core indexer
 * worker, factored out so it can be tested without a worker global.
 *
 * A dedicated Web Worker's message channel is private to the page that created
 * it, but the handler still validates every message before it acts on one, for
 * two reasons the validation makes explicit rather than assumes:
 *
 *  - ORIGIN. A dedicated worker only ever receives messages from its owner, and
 *    per the HTML spec those carry an empty `origin`. Any other origin is not a
 *    legitimate owner message, so it is ignored without a reply.
 *  - SHAPE. `event.data` is untrusted input until it is checked. The handler
 *    confirms it is a well-formed {@link LocalOocRequestMessage} through
 *    {@link isLocalOocRequestMessage} before dispatching, rather than trusting a
 *    cast, so a malformed body cannot reach the build with garbage fields.
 *
 * The worker module is a thin wire: it supplies `post`, the build runner and the
 * cancel-controller storage, and delegates each message here. The build itself
 * is `buildLocalOocStore`, unit-tested in Node against a fake OPFS.
 */
import type {
  LocalOocRequestMessage,
  LocalOocResponseMessage,
} from './localOocIndexerWorkerClient';
import type { LocalOocBuildResult, LocalOocPhase } from '../localOocBuild';

/** A dedicated worker's owner messages carry an empty origin; nothing else is one. */
export function isOwnerMessage(origin: string): boolean {
  return origin === '';
}

/** A structural guard over `event.data`, so a cast never stands in for a check. */
export function isLocalOocRequestMessage(data: unknown): data is LocalOocRequestMessage {
  if (typeof data !== 'object' || data === null) return false;
  const message = data as { type?: unknown };
  if (message.type === 'cancel') return true;
  if (message.type !== 'build') return false;
  const build = data as { file?: unknown; storeName?: unknown; options?: unknown };
  return (
    typeof build.storeName === 'string' &&
    typeof build.options === 'object' &&
    build.options !== null &&
    build.file != null &&
    typeof (build.file as { name?: unknown }).name === 'string' &&
    typeof (build.file as { size?: unknown }).size === 'number'
  );
}

/** The build message, narrowed. */
type BuildMessage = Extract<LocalOocRequestMessage, { type: 'build' }>;

/** What the worker gives the handler: how to reply, how to build, and where the
 *  in-flight cancel controller lives. */
export interface OocWorkerHost {
  post(message: LocalOocResponseMessage): void;
  runBuild(
    message: BuildMessage,
    signal: AbortSignal,
    onPhase: (phase: LocalOocPhase) => void,
  ): Promise<LocalOocBuildResult>;
  getController(): AbortController | null;
  setController(controller: AbortController | null): void;
}

/** The event fields the handler reads — the subset of `MessageEvent` it needs. */
export interface OocWorkerMessageEvent {
  readonly origin: string;
  readonly data: unknown;
}

/**
 * Handle one message from the owner page. Ignores any message that is not a
 * well-formed owner request, and otherwise dispatches a cancel or runs a build.
 */
export async function handleOocWorkerMessage(
  event: OocWorkerMessageEvent,
  host: OocWorkerHost,
): Promise<void> {
  // A dedicated worker accepts only owner messages (origin ''), so a non-empty
  // origin or a malformed body is not acted on.
  if (!isOwnerMessage(event.origin)) return;
  if (!isLocalOocRequestMessage(event.data)) {
    host.post({ type: 'error', message: 'ignored a malformed worker message' });
    return;
  }
  const message = event.data;
  if (message.type === 'cancel') {
    host.getController()?.abort();
    return;
  }

  const controller = new AbortController();
  host.setController(controller);
  try {
    const result = await host.runBuild(message, controller.signal, (phase) =>
      host.post({ type: 'phase', phase }),
    );
    host.post({ type: 'done', result });
  } catch (err) {
    host.post({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : undefined,
    });
  } finally {
    host.setController(null);
  }
}
