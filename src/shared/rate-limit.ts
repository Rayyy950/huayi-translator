function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) return Promise.reject(abortError());
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Spaces acquisitions at least `minIntervalMs` apart. Concurrent callers get
 * slots in order; aborting a waiter releases nothing (its slot stays used),
 * which keeps the provider rate under the configured QPS.
 */
export class RateLimiter {
  private nextSlot = 0;

  constructor(readonly minIntervalMs: number) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.minIntervalMs;
    const wait = slot - now;
    if (wait > 0) await delay(wait, signal);
    if (signal?.aborted) throw abortError();
  }
}

export interface LatestQueueOptions<T> {
  /** Called when an item that was waiting is replaced. */
  onDropped?: (item: T) => void;
}

/**
 * Keeps at most one running task and one waiting task. A newer waiting task
 * replaces the older waiting one; the running task can be aborted by the owner.
 */
export class LatestQueue<T> {
  private running = false;
  private pending: T | null = null;
  private readonly onDropped?: (item: T) => void;

  constructor(options: LatestQueueOptions<T> = {}) {
    this.onDropped = options.onDropped;
  }

  enqueue(item: T, run: (item: T) => Promise<void>): void {
    if (this.running) {
      if (this.pending !== null) this.onDropped?.(this.pending);
      this.pending = item;
      return;
    }
    void this.runNext(item, run);
  }

  private async runNext(item: T, run: (item: T) => Promise<void>): Promise<void> {
    this.running = true;
    try {
      await run(item);
    } finally {
      const next = this.pending;
      this.pending = null;
      if (next !== null) {
        void this.runNext(next, run);
      } else {
        this.running = false;
      }
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }

  clearPending(): void {
    if (this.pending !== null) {
      this.onDropped?.(this.pending);
      this.pending = null;
    }
  }
}
