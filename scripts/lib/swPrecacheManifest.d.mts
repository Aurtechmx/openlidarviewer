export interface SwPrecacheManifest {
  totalBytes: number;
  assets: { url: string; bytes: number; sha256: string }[];
  index: { url: string; sha256: string };
}
export function buildSwPrecacheManifest(dir: string): SwPrecacheManifest;
