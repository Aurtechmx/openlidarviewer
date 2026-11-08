export interface SwPrecacheManifest {
  totalBytes: number;
  assets: { url: string; bytes: number }[];
  index: { url: string; sha256: string };
}
export function buildSwPrecacheManifest(dir: string): SwPrecacheManifest;
