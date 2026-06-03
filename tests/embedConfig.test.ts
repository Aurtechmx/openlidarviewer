import { parseEmbedConfig } from '../src/ui/embedConfig';

test('an empty query yields the all-default config', () => {
  expect(parseEmbedConfig('')).toEqual({
    embed: false,
    uiMinimal: false,
    forceAnnotations: false,
    forceMeasurements: false,
    autoloadSample: null,
    theme: 'dark',
  });
});

test('?embed in any truthy form turns embed mode on', () => {
  expect(parseEmbedConfig('?embed=1').embed).toBe(true);
  expect(parseEmbedConfig('?embed').embed).toBe(true);
  expect(parseEmbedConfig('?embed=true').embed).toBe(true);
});

test('?embed=0 / false keeps embed mode off', () => {
  expect(parseEmbedConfig('?embed=0').embed).toBe(false);
  expect(parseEmbedConfig('?embed=false').embed).toBe(false);
});

test('?ui=minimal is recognised; other ui values are not', () => {
  expect(parseEmbedConfig('?ui=minimal').uiMinimal).toBe(true);
  expect(parseEmbedConfig('?ui=full').uiMinimal).toBe(false);
});

test('?annotations=1 and ?measurements=1 set the force flags', () => {
  const c = parseEmbedConfig('?annotations=1&measurements=1');
  expect(c.forceAnnotations).toBe(true);
  expect(c.forceMeasurements).toBe(true);
});

test('?autoload resolves a sample id but never a remote URL', () => {
  expect(parseEmbedConfig('?autoload=sample:survey').autoloadSample).toBe('survey');
  // A remote URL is deliberately not honoured — remote loading is v0.3.
  expect(parseEmbedConfig('?autoload=https://example.com/a.las').autoloadSample).toBeNull();
  expect(parseEmbedConfig('?autoload=sample:').autoloadSample).toBeNull();
});

test('theme is always dark in v0.2.9', () => {
  expect(parseEmbedConfig('?theme=dark').theme).toBe('dark');
  expect(parseEmbedConfig('?theme=neon').theme).toBe('dark');
});

test('multiple parameters compose', () => {
  const c = parseEmbedConfig('?embed=1&ui=minimal&autoload=sample:scan');
  expect(c.embed).toBe(true);
  expect(c.uiMinimal).toBe(true);
  expect(c.autoloadSample).toBe('scan');
});
