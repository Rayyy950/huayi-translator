import { afterEach, describe, expect, it, vi } from 'vitest';
import { LatestQueue, RateLimiter } from '../../src/shared/rate-limit';

afterEach(() => {
  vi.useRealTimers();
});

describe('RateLimiter', () => {
  it('spaces acquisitions at least the configured interval apart', async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(1000);
    const resolved: number[] = [];
    const start = Date.now();
    const p1 = limiter.acquire().then(() => resolved.push(Date.now() - start));
    const p2 = limiter.acquire().then(() => resolved.push(Date.now() - start));
    const p3 = limiter.acquire().then(() => resolved.push(Date.now() - start));

    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toHaveLength(3);
    await Promise.all([p1, p2, p3]);
  });

  it('rejects waiters that abort', async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(1000);
    await limiter.acquire();
    const controller = new AbortController();
    const wait = limiter.acquire(controller.signal);
    controller.abort();
    await expect(wait).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1000);
  });

  it('does not delay the first acquisition', async () => {
    const limiter = new RateLimiter(5000);
    const start = Date.now();
    await limiter.acquire();
    expect(Date.now() - start).toBeLessThan(100);
  });
});

describe('LatestQueue', () => {
  it('runs one task and replaces the waiting task', async () => {
    const dropped: string[] = [];
    const queue = new LatestQueue<string>({ onDropped: (item) => dropped.push(item) });
    const started: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    queue.enqueue('first', async (item) => {
      started.push(item);
      await gate;
    });
    queue.enqueue('second', async (item) => {
      started.push(item);
    });
    queue.enqueue('third', async (item) => {
      started.push(item);
    });

    expect(started).toEqual(['first']);
    expect(dropped).toEqual(['second']);
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(['first', 'third']);
    expect(queue.isRunning).toBe(false);
    expect(queue.hasPending).toBe(false);
  });

  it('clearPending drops the waiting item', async () => {
    const dropped: string[] = [];
    const queue = new LatestQueue<string>({ onDropped: (item) => dropped.push(item) });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queue.enqueue('first', async () => gate);
    queue.enqueue('second', async () => {});
    queue.clearPending();
    expect(dropped).toEqual(['second']);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.hasPending).toBe(false);
  });
});
