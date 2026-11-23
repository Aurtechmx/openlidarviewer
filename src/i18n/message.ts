/**
 * message.ts: fill a catalog template.
 *
 * Templates name their parameters in braces, `{count} points`. A missing
 * parameter throws, so a sentence never goes out with a hole in it.
 */
export function fill(template: string, params: Readonly<Record<string, string | number>> = {}, key = 'message'): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (!(name in params)) throw new RangeError(`${key}: missing parameter ${name}`);
    return String(params[name]);
  });
}

/** The parameter names a template uses, sorted, for catalog parity tests. */
export function templateParams(template: string): string[] {
  return [...new Set([...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort((a, b) => (a < b ? -1 : 1));
}
