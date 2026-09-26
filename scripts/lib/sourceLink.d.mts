export declare const REPO_URL: string;
export interface SourceIdentity { version: string; commit: string; dirty: boolean }
export declare function sourceRefFor(identity: SourceIdentity): { url: string; label: string };
export declare function stampSourceLinks(html: string, identity: SourceIdentity): string;
