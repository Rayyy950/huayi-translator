export interface CacheStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
  entries(): Array<[string, string]>;
  clear(): void;
}

interface Entry {
  value: string;
  createdAt: number;
  lastAccess: number;
  bytes: number;
}

const encoder = new TextEncoder();
const byteLength = (key: string, value: string): number =>
  encoder.encode(key).length + encoder.encode(value).length + 32;

export interface LruCacheOptions {
  maxEntries: number;
  maxBytes: number;
  ttlMs: number;
  now?: () => number;
}

/** Small LRU with TTL and a byte budget. Order is least-recently-used first. */
export class LruCache {
  private readonly map = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: LruCacheOptions) {
    this.maxEntries = options.maxEntries;
    this.maxBytes = options.maxBytes;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  get(key: string): string | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.createdAt > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    entry.lastAccess = this.now();
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: string): void {
    const now = this.now();
    this.map.delete(key);
    this.map.set(key, {
      value,
      createdAt: now,
      lastAccess: now,
      bytes: byteLength(key, value),
    });
    this.evict();
  }

  remove(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    let total = 0;
    for (const entry of this.map.values()) total += entry.bytes;
    return total;
  }

  entries(): Array<[string, string]> {
    this.prune();
    return Array.from(this.map.entries()).map(([key, entry]) => [key, entry.value]);
  }

  prune(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (now - entry.createdAt > this.ttlMs) {
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }

  private evict(): void {
    this.prune();
    while (this.map.size > this.maxEntries) {
      const first = this.map.keys().next();
      if (first.done) break;
      this.map.delete(first.value);
    }
    while (this.bytes > this.maxBytes) {
      const first = this.map.keys().next();
      if (first.done) break;
      this.map.delete(first.value);
    }
  }
}

export interface CacheKeyParts {
  text: string;
  source: string;
  target: string;
  actualProvider: string;
  model?: string;
  region?: string;
  promptVersion?: string;
}

export function buildCacheKey(parts: CacheKeyParts): string {
  return JSON.stringify([
    parts.text,
    parts.source,
    parts.target,
    parts.actualProvider,
    parts.model ?? '',
    parts.region ?? '',
    parts.promptVersion ?? '',
  ]);
}
