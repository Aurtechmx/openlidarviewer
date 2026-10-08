/**
 * keyFileLoader.ts — fills the report verifier's trusted-key field from a file.
 *
 * Reading a file is asynchronous, so a slower earlier read can finish after a
 * later one, and the user can type into the field while a read is running.
 * Every load and every keystroke takes a new generation; a read writes the
 * field only when no later load or edit has happened since it started. Each
 * write goes through `keyChanged`, the same path typing uses, so a Compare in
 * flight is retired either way.
 */

/** Shown when the browser cannot read the chosen file. */
export const KEY_FILE_READ_FAILED = 'The key file could not be read. Pick it again or paste the key.';

/** The parts of the dialog the loader writes. */
export interface KeyFileField {
  setText(text: string): void;
  /** The key text changed: retire any Compare in flight. */
  keyChanged(): void;
  /** The note under the field; an empty string clears it. */
  setProblem(message: string): void;
}

/** What the loader needs from a `File`. */
export interface KeyFileSource {
  readonly size: number;
  text(): Promise<string>;
}

export interface KeyFileLoader {
  /** The user edited the field by hand. */
  typed(): void;
  /** Read `file` into the field unless a later load or edit supersedes it. */
  load(file: KeyFileSource): Promise<void>;
}

export function createKeyFileLoader(
  field: KeyFileField,
  maxBytes: number,
  problemFor: (size: number) => string | null,
): KeyFileLoader {
  let generation = 0;
  return {
    typed(): void {
      generation += 1;
      field.keyChanged();
    },
    async load(file: KeyFileSource): Promise<void> {
      generation += 1;
      const mine = generation;
      const problem = problemFor(file.size);
      field.setProblem(problem ?? '');
      if (problem) {
        field.setText('');
        field.keyChanged();
        return;
      }
      let text: string;
      try {
        text = await file.text();
      } catch {
        if (mine === generation) field.setProblem(KEY_FILE_READ_FAILED);
        return;
      }
      if (mine !== generation) return;
      field.setText(text.slice(0, maxBytes));
      field.keyChanged();
    },
  };
}
