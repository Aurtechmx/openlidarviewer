import { buildPreloadSummary, formatByteSize } from '../src/io/preloadSummary';
import type { SourceMetadata } from '../src/io/PointCloudSource';

test('formatByteSize renders compact units', () => {
  expect(formatByteSize(512)).toBe('512 B');
  expect(formatByteSize(2048)).toBe('2.0 KB');
  expect(formatByteSize(5 * 1024 * 1024)).toBe('5.0 MB');
  expect(formatByteSize(3 * 1024 ** 3)).toBe('3.0 GB');
  expect(formatByteSize(-10)).toBe('0 B');
});

test('a summary always carries the format label and the size', () => {
  const meta: SourceMetadata = {
    format: 'pcd',
    label: 'PCD cloud',
    byteSize: 12 * 1024 * 1024,
  };
  expect(buildPreloadSummary(meta)).toEqual(['PCD cloud detected', '12.0 MB']);
});

test('a revealed point count and load mode are included when present', () => {
  const meta: SourceMetadata = {
    format: 'las',
    label: 'LAS scan',
    byteSize: 48 * 1024 * 1024,
    estimatedPointCount: 4_200_000,
    loadModeSummary: 'Large-file optimization enabled',
  };
  expect(buildPreloadSummary(meta)).toEqual([
    'LAS scan detected',
    '4.2M source points',
    '48.0 MB',
    'Large-file optimization enabled',
  ]);
});

test('a PTS header count appears even without a load mode', () => {
  const meta: SourceMetadata = {
    format: 'pts',
    label: 'PTS scan',
    byteSize: 900_000,
    estimatedPointCount: 15_000,
  };
  expect(buildPreloadSummary(meta)).toEqual([
    'PTS scan detected',
    '15K source points',
    '878.9 KB',
  ]);
});
