export function testSeamEnabled(mode: string, env: Record<string, string | undefined>): boolean;
export function parseEmbedOrigins(raw: string | undefined): { origins: string[]; dropped: string[] };
export const EMBED_ORIGINS_STAMP_NAME: string;
export function embedOriginsStamp(origins: readonly string[]): { name: string; content: string } | null;
export function findEmbedOriginsStamp(html: string): string[] | null;
