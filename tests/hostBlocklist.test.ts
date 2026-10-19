import { describe, expect, test } from 'vitest';
import { isBlockedHost, validateRemoteCopcUrl } from '../src/io/range/RangeSource';
import { resolveTilesetContentUrl, validateRemoteTilesetUrl } from '../src/io/tiles3d/tilesetUrl';
import { CURATED_LOCATIONS } from '../src/io/catalog/curatedLocations';

/** Hostnames as `new URL(...).hostname` yields them (IPv6 bracketed and compressed). */
const BLOCKED: string[] = [
  // Names
  'localhost', 'LOCALHOST.', 'foo.localhost', 'x.local', 'metadata.google.internal',
  'intranet', 'router', 'printer.lan', 'router.home.arpa', 'home.arpa', 'wiki.corp', 'files.private', 'a.intranet', 'host.localdomain',
  // IPv4
  '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
  '100.64.0.1', '100.100.100.200', '192.0.0.192', '192.0.0.1', '198.18.0.1', '198.19.255.255',
  '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
  // IPv6
  '[::1]', '[::]', '[::7f00:1]', '[::a00:1]', '[::ffff:7f00:1]', '[::ffff:a9fe:a9fe]', '[::ffff:0:7f00:1]',
  '[64:ff9b::7f00:1]', '[64:ff9b::808:808]', '[2002:7f00:1::]', '[2002:a9fe:a9fe::]', '[fec0::1]', '[fe80::1]', '[febf::1]',
  '[fd00::1]', '[fc00::1]', '[ff02::1]', '[100::1]', '[2001:0:4136:e378:8000:63bf:3fff:fdd2]',
];

const ALLOWED: string[] = [
  'example.com', 'data.example.org', 'open-lidar-data.s3.eu-central-1.amazonaws.com',
  's3-us-west-2.amazonaws.com', 'd1234abcd.cloudfront.net', 'storage.googleapis.com', 'my-bucket.blob.core.windows.net',
  '8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '198.17.0.1', '198.20.0.1',
  '192.0.2.1', '223.255.255.254',
  '[2606:4700:4700::1111]', '[2001:4860:4860::8888]', '[2a00:1450:4001::200e]', '[::ffff:808:808]',
  'x.localx.com', 'notlocalhost.com', 'corp.example.com', 'lan.example.com',
];

describe('isBlockedHost', () => {
  test.each(BLOCKED)('blocks %s', (host) => {
    expect(isBlockedHost(host)).toBe(true);
  });
  test.each(ALLOWED)('allows %s', (host) => {
    expect(isBlockedHost(host)).toBe(false);
  });
  test('refuses an IPv6 literal it cannot parse', () => {
    expect(isBlockedHost('[1:2:3]')).toBe(true);
    expect(isBlockedHost('[::g]')).toBe(true);
  });
});

describe('validateRemoteCopcUrl through the URL parser', () => {
  test.each([
    'https://[::127.0.0.1]/a.copc.laz',
    'https://[::ffff:127.0.0.1]/a.copc.laz',
    'https://[64:ff9b::127.0.0.1]/a.copc.laz',
    'https://[2002:7f00:1::]/a.copc.laz',
    'https://[::ffff:0:127.0.0.1]/a.copc.laz',
    'https://2130706433/a.copc.laz',
    'https://0x7f.1/a.copc.laz',
    'https://intranet/a.copc.laz',
    'https://router/a.copc.laz',
    'https://printer.lan/a.copc.laz',
    'https://224.0.0.1/a.copc.laz',
    'https://255.255.255.255/a.copc.laz',
  ])('refuses %s', (url) => {
    expect(validateRemoteCopcUrl(url).ok).toBe(false);
  });

  test('still accepts an ordinary public https URL', () => {
    expect(validateRemoteCopcUrl('https://example.com/data/a.copc.laz').ok).toBe(true);
  });
});

describe('the 3D Tiles validators share the list', () => {
  test('refuses a tileset entry and a content URI on a newly blocked host', () => {
    for (const host of ['intranet', '[::7f00:1]', '[2002:a9fe:a9fe::]', 'router.home.arpa']) {
      expect(validateRemoteTilesetUrl(`https://${host}/ts/tileset.json`).ok).toBe(false);
      expect(resolveTilesetContentUrl(`https://${host}/ts/`, 'a.pnts').ok).toBe(false);
    }
  });
  test('still accepts a public tileset', () => {
    expect(validateRemoteTilesetUrl('https://cdn.example.com/ts/tileset.json').ok).toBe(true);
    expect(resolveTilesetContentUrl('https://cdn.example.com/ts/', 'a.pnts').ok).toBe(true);
  });
});

describe('curated catalogue hosts', () => {
  test('every curated stream URL still passes the validator', () => {
    const urls = CURATED_LOCATIONS.map((l) => l.streamUrl);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(isBlockedHost(new URL(url).hostname), url).toBe(false);
      expect(validateRemoteCopcUrl(url).ok || /ept\.json$/.test(url), url).toBe(true);
    }
  });
});
