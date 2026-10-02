export function inlineStyles(html: string): string[];
export function styleHash(text: string): string;
export function styleSources(text: string): string[][];
export function cspStyleProblems(builtHtml: string, sourceHtml: string, policies: Record<string, string>): string[];
