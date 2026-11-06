import { describe, expect, it } from 'vitest';
import { buildCacheKey, LruCache } from '../../src/shared/cache';

describe('LruCache', () => {
  it('returns values and expires entries after the TTL', () => {
    let now = 1000;
    const cache = new LruCache({ maxEntries: 10, maxBytes: 10_000, ttlMs: 100, now: () => now });
    cache.set('a', '1');
    expect(cache.get('a')).toBe('1');
    now += 101;
    expect(cache.get('a')).toBeUndefined();
  });

  it('evicts the least recently used entry', () => {
    const cache = new LruCache({ maxEntries: 2, maxBytes: 10_000, ttlMs: 1000 });
    cache.set('a', '1');
    cache.set('b', '2');
    expect(cache.get('a')).toBe('1');
    cache.set('c', '3');
    expect(cache.get('a')).toBe('1');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe('3');
  });

  it('enforces the byte budget', () => {
    const cache = new LruCache({ maxEntries: 10, maxBytes: 80, ttlMs: 1000 });
    cache.set('a', 'x'.repeat(20));
    cache.set('b', 'y'.repeat(20));
    cache.set('c', 'z'.repeat(20));
    expect(cache.bytes).toBeLessThanOrEqual(80);
    expect(cache.size).toBeLessThan(3);
  });

  it('clear removes everything', () => {
    const cache = new LruCache({ maxEntries: 10, maxBytes: 1000, ttlMs: 1000 });
    cache.set('a', '1');
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.entries()).toEqual([]);
  });

  it('entries() prunes expired items', () => {
    let now = 0;
    const cache = new LruCache({ maxEntries: 10, maxBytes: 1000, ttlMs: 10, now: () => now });
    cache.set('a', '1');
    now = 11;
    expect(cache.entries()).toEqual([]);
  });
});

describe('buildCacheKey', () => {
  const base = {
    text: 'hello',
    source: 'auto:en',
    target: 'zh-Hans',
    actualProvider: 'tokenhub',
    model: 'hy-mt2-plus',
    region: 'guangzhou',
    promptVersion: 'v1',
  };

  it('is stable for the same inputs', () => {
    expect(buildCacheKey(base)).toBe(buildCacheKey({ ...base }));
  });

  it('isolates provider, model, region, prompt, source and target', () => {
    const key = buildCacheKey(base);
    expect(buildCacheKey({ ...base, actualProvider: 'chrome-local' })).not.toBe(key);
    expect(buildCacheKey({ ...base, model: 'other' })).not.toBe(key);
    expect(buildCacheKey({ ...base, region: 'singapore' })).not.toBe(key);
    expect(buildCacheKey({ ...base, promptVersion: 'v2' })).not.toBe(key);
    expect(buildCacheKey({ ...base, source: 'en:en' })).not.toBe(key);
    expect(buildCacheKey({ ...base, target: 'en' })).not.toBe(key);
    expect(buildCacheKey({ ...base, text: 'hello!' })).not.toBe(key);
  });
});
