import { describe, expect, it } from 'vitest';

import { looksLikeRemoteDataset } from '../src/ui/Stage';

describe('URL field blur hint', () => {
  it('accepts COPC, EPT and 3D Tiles entry points', () => {
    expect(looksLikeRemoteDataset('https://host.example/a/scan.copc.laz')).toBe(true);
    expect(looksLikeRemoteDataset('https://host.example/a/ept.json')).toBe(true);
    expect(looksLikeRemoteDataset('https://host.example/a/ept.json?sig=1')).toBe(true);
    expect(looksLikeRemoteDataset('https://host.example/a/tileset.json')).toBe(true);
    expect(looksLikeRemoteDataset('https://host.example/a/Tileset.json?v=2')).toBe(true);
  });

  it('flags other URLs', () => {
    expect(looksLikeRemoteDataset('https://host.example/a/scan.las')).toBe(false);
    expect(looksLikeRemoteDataset('https://host.example/a/not-tileset.json')).toBe(false);
  });
});
