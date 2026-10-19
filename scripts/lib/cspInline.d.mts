export function hashSource(text: string, algorithm?: 'sha256' | 'sha384' | 'sha512'): string;
export function parsePolicy(policy: string): Map<string, string[]>;
export function governingSources(directives: Map<string, string[]>, directive: string): string[];
export function inlineBlocks(html: string, tag: 'script' | 'style'): Array<{ attrs: string; text: string }>;
export function blockVerdict(
  sources: string[],
  block: { attrs: string; text: string },
): { ok: true } | { ok: false; hash: string };
export function inlineProblems(file: string, html: string, policy: string): string[];
