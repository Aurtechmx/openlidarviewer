export interface SwPrecacheManifest {
  totalBytes: number;
  assets: { url: string; bytes: number }[];
}
export function buildSwPrecacheManifest(dir: string): SwPrecacheManifest;
