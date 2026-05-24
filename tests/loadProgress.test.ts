import { loadStageLabel, formatProgress } from '../src/io/loadProgress';
import type { LoadStage } from '../src/io/loadProgress';

const ALL_STAGES: LoadStage[] = [
  'detecting-format',
  'reading-file',
  'parsing-metadata',
  'decoding',
  'optimizing',
  'uploading',
  'rendering',
];

describe('loadStageLabel', () => {
  test('every stage has a non-empty, human-readable label', () => {
    for (const stage of ALL_STAGES) {
      const label = loadStageLabel(stage);
      expect(label.length).toBeGreaterThan(0);
      // A label, not the raw kebab-case stage id.
      expect(label).not.toContain('-');
    }
  });

  test('key stage labels are stable', () => {
    expect(loadStageLabel('decoding')).toBe('Decoding points');
    expect(loadStageLabel('uploading')).toBe('Preparing GPU buffers');
    expect(loadStageLabel('detecting-format')).toBe('Detecting format');
  });
});

describe('formatProgress', () => {
  test('a stage with no detail reads as the label plus an ellipsis', () => {
    expect(formatProgress({ stage: 'reading-file' })).toBe('Reading file…');
  });

  test('a stage with detail appends it after an em dash', () => {
    expect(formatProgress({ stage: 'decoding', detail: '2.1M of 3.6M points' })).toBe(
      'Decoding points — 2.1M of 3.6M points',
    );
  });
});
