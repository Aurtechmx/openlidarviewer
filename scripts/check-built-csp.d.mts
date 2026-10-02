export function inlineStyles(html: string): string[];
export function styleHash(text: string): string;
export function styleSources(text: string): string[] | null;
export function cspStyleProblems(builtHtml: string, policies: Record<string, string>): string[];
