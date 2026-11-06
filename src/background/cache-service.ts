import { LruCache } from '../shared/cache';
import type { ProviderId } from '../shared/types';

const CACHE_KEY = 'translation.cache.v1';
const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 200;
const MAX_BYTES = 2 * 1024 * 1024;

export interface StoredTranslation {
  translatedText: string;
  detectedSource?: string;
  actualProvider: ProviderId;
  fallback: boolean;
}

interface Envelope {
  at: number;
  v: StoredTranslation;
}

/**
 * In-memory LRU backed by chrome.storage.session. The session area is set to
 * TRUSTED_CONTEXTS, so page scripts and content scripts cannot read it.
 */
export class TranslationCache {
  private readonly lru = new LruCache({
    maxEntries: MAX_ENTRIES,
    maxBytes: MAX_BYTES,
    ttlMs: TTL_MS,
  });
  private loaded = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const stored = await chrome.storage.session.get(CACHE_KEY);
      const entries = stored[CACHE_KEY];
      if (!Array.isArray(entries)) return;
      const now = Date.now();
      for (const pair of entries) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const [key, value] = pair as [unknown, unknown];
        if (typeof key !== 'string' || typeof value !== 'string') continue;
        try {
          const envelope = JSON.parse(value) as Envelope;
          if (!envelope || typeof envelope.at !== 'number') continue;
          if (now - envelope.at > TTL_MS) continue;
          const reWrapped = JSON.stringify({ at: envelope.at, v: envelope.v });
          this.lru.set(key, reWrapped);
        } catch {
          // Skip corrupt entries.
        }
      }
    } catch {
      // Session storage may be unavailable in tests; keep the in-memory cache.
    }
  }

  async get(key: string): Promise<StoredTranslation | undefined> {
    await this.ensureLoaded();
    const raw = this.lru.get(key);
    if (!raw) return undefined;
    try {
      const envelope = JSON.parse(raw) as Envelope;
      if (Date.now() - envelope.at > TTL_MS) {
        this.lru.remove(key);
        return undefined;
      }
      return envelope.v;
    } catch {
      this.lru.remove(key);
      return undefined;
    }
  }

  async set(key: string, value: StoredTranslation): Promise<void> {
    await this.ensureLoaded();
    this.lru.set(key, JSON.stringify({ at: Date.now(), v: value }));
    this.schedulePersist();
  }

  async clear(): Promise<void> {
    await this.ensureLoaded();
    this.lru.clear();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      await chrome.storage.session.remove(CACHE_KEY);
    } catch {
      // ignore
    }
  }

  async stats(): Promise<{ entries: number; bytes: number; maxEntries: number; maxBytes: number }> {
    await this.ensureLoaded();
    this.lru.prune();
    return {
      entries: this.lru.size,
      bytes: this.lru.bytes,
      maxEntries: MAX_ENTRIES,
      maxBytes: MAX_BYTES,
    };
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, 500);
  }

  private async persist(): Promise<void> {
    try {
      const entries = this.lru.entries();
      await chrome.storage.session.set({ [CACHE_KEY]: entries });
    } catch {
      // Cache loss is acceptable; never block translation on it.
    }
  }
}

export const translationCache = new TranslationCache();
