/**
 * chunkFailureNote.ts: the line a panel shows in place of a part that failed to
 * load. The first failure may offer Try again, because Firefox recovers with it.
 * A repeat, or a part with no retry, says a reload is needed and what it costs.
 */
import { chunkFailureText, chunkReloadAction, countChunkFailure } from '../app/staleChunkReload';
import { el } from './dom';

export interface ChunkFailureNoteOpts {
  /** Names the part across attempts. */
  readonly key: string;
  /** What failed, as the start of a sentence. */
  readonly what: string;
  /** Run the load again. Absent offers only the reload. */
  readonly retry?: () => void;
  /** The first failure's sentence, when it is not "<what> could not load." */
  readonly firstText?: string;
}

export function chunkFailureNote(opts: ChunkFailureNoteOpts): HTMLElement {
  const note = el('div', { className: 'olv-report-empty olv-chunk-failure' });
  const button = (text: string, onClick: () => void): void => {
    const b = el('button', { className: 'olv-inline-retry', text }) as HTMLButtonElement;
    b.type = 'button';
    b.addEventListener('click', onClick);
    note.append(b);
  };
  const { retry } = opts;
  if (retry && countChunkFailure(opts.key) < 2) {
    note.append(el('div', { text: opts.firstText ?? `${opts.what} could not load.` }));
    button('Try again', retry);
    return note;
  }
  note.append(el('div', { text: chunkFailureText(opts.what) }));
  const reload = chunkReloadAction();
  if (reload) button(reload.label, reload.onClick);
  return note;
}
