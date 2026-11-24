/**
 * generatedText.ts: the titles and notes the app writes into a dialog's fields,
 * told apart from text the user typed, so a sheet can write them in its language.
 */
/** What a default title or note was made from, so a sheet can write it in its own language. */
export interface GeneratedText {
  readonly base: string;
  /** Present for a note. */
  readonly interval?: string;
  readonly crs?: string | null;
}
/** The defaults this tab has made, by their English text. Text the user typed is never here. */
const generated = new Map<string, GeneratedText>();
export function made(text: string, from: GeneratedText): string {
  if (generated.size > 200) generated.clear();
  generated.set(text, from);
  return text;
}
/** What `text` was made from when it is a default this tab made, else null. */
export const generatedFrom = (text: string): GeneratedText | null => generated.get(text) ?? null;
