import { CompressedChunkCache } from '../src/render/streaming/StreamingCache';

function buf(n: number): ArrayBuffer {
  return new ArrayBuffer(n);
}

test('CompressedChunkCache stores and returns chunks', () => {
  const cache = new CompressedChunkCache(1000);
  cache.put('a', buf(100));
  expect(cache.has('a')).toBe(true);
  expect(cache.get('a')?.byteLength).toBe(100);
  expect(cache.byteSize).toBe(100);
  expect(cache.count).toBe(1);
});

test('CompressedChunkCache evicts least-recently-used entries past the budget', () => {
  const cache = new CompressedChunkCache(250);
  cache.put('a', buf(100));
  cache.put('b', buf(100));
  cache.put('c', buf(100)); // total would be 300 > 250 → 'a' (oldest) evicted
  expect(cache.has('a')).toBe(false);
  expect(cache.has('b')).toBe(true);
  expect(cache.has('c')).toBe(true);
  expect(cache.byteSize).toBe(200);
});

test('a get() refreshes recency so the touched entry survives eviction', () => {
  const cache = new CompressedChunkCache(250);
  cache.put('a', buf(100));
  cache.put('b', buf(100));
  cache.get('a'); // 'a' becomes most-recently-used
  cache.put('c', buf(100)); // evicts the LRU — now 'b', not 'a'
  expect(cache.has('a')).toBe(true);
  expect(cache.has('b')).toBe(false);
  expect(cache.has('c')).toBe(true);
});

test('a chunk larger than the whole budget is not cached', () => {
  const cache = new CompressedChunkCache(100);
  cache.put('big', buf(500));
  expect(cache.has('big')).toBe(false);
  expect(cache.byteSize).toBe(0);
});

test('re-putting an id replaces its bytes without double-counting', () => {
  const cache = new CompressedChunkCache(1000);
  cache.put('a', buf(100));
  cache.put('a', buf(300));
  expect(cache.byteSize).toBe(300);
  expect(cache.count).toBe(1);
});

test('clear empties the cache', () => {
  const cache = new CompressedChunkCache(1000);
  cache.put('a', buf(100));
  cache.put('b', buf(100));
  cache.clear();
  expect(cache.count).toBe(0);
  expect(cache.byteSize).toBe(0);
});

test('get() updates the hit and miss counters', () => {
  const cache = new CompressedChunkCache(1000);
  cache.put('a', buf(100));
  expect(cache.hits).toBe(0);
  expect(cache.misses).toBe(0);
  cache.get('a');                  // hit
  cache.get('missing-one');        // miss
  cache.get('missing-two');        // miss
  cache.get('a');                  // hit
  expect(cache.hits).toBe(2);
  expect(cache.misses).toBe(2);
});

test('eviction increments the evictions counter, one per dropped entry', () => {
  const cache = new CompressedChunkCache(250);
  cache.put('a', buf(100));
  cache.put('b', buf(100));
  expect(cache.evictions).toBe(0);
  cache.put('c', buf(100)); // evicts 'a'
  expect(cache.evictions).toBe(1);
  cache.put('d', buf(200)); // evicts 'b' then 'c' to make room
  expect(cache.evictions).toBe(3);
});

test('clear() does NOT reset the cumulative outcome counters', () => {
  const cache = new CompressedChunkCache(250);
  cache.put('a', buf(100));
  cache.get('a');
  cache.get('z');
  cache.put('b', buf(100));
  cache.put('c', buf(100)); // evicts 'a'
  cache.clear();
  expect(cache.hits).toBe(1);
  expect(cache.misses).toBe(1);
  expect(cache.evictions).toBe(1);
});

test('resetCounters() zeros the outcome counters without dropping entries', () => {
  const cache = new CompressedChunkCache(1000);
  cache.put('a', buf(100));
  cache.get('a');
  cache.get('z');
  cache.resetCounters();
  expect(cache.hits).toBe(0);
  expect(cache.misses).toBe(0);
  expect(cache.evictions).toBe(0);
  expect(cache.has('a')).toBe(true);
});

// --- hysteresis — cache hysteresis -------------------------------------

test('touch() bumps an entry to most-recently-used so it outlives later inserts', () => {
  const cache = new CompressedChunkCache(250);
  cache.put('a', buf(100));
  cache.put('b', buf(100));
  // Without touch, 'a' would be the LRU. Touch promotes it past 'b'.
  expect(cache.touch('a')).toBe(true);
  cache.put('c', buf(100)); // evicts the LRU — now 'b', not 'a'
  expect(cache.has('a')).toBe(true);
  expect(cache.has('b')).toBe(false);
  expect(cache.has('c')).toBe(true);
});

test('touch() does not register as a hit and reports absence with false', () => {
  const cache = new CompressedChunkCache(250);
  cache.put('a', buf(100));
  expect(cache.hits).toBe(0);
  expect(cache.touch('a')).toBe(true);
  expect(cache.touch('missing')).toBe(false);
  // touch() is recency-only; the hit counter is the get()-based metric.
  expect(cache.hits).toBe(0);
  expect(cache.misses).toBe(0);
});
