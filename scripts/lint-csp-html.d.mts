export function readMirroredPolicy(): { present: boolean; policy: string | null };
export function lintPages(
  policy: string,
  mirrored: { present: boolean; policy: string | null },
  pages: Record<string, string>,
): string[];
export function policyFromHtaccess(text: string): string | null;
