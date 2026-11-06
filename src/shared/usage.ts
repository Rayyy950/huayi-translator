import type { UsageRecord } from './usage-types';
import { USAGE_KEY } from './settings';

export function localDateKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const EMPTY: UsageRecord = { date: '', chars: 0, requests: 0, tests: 0 };

export async function getUsage(): Promise<UsageRecord> {
  const stored = await chrome.storage.local.get(USAGE_KEY);
  const raw = stored[USAGE_KEY] as Partial<UsageRecord> | undefined;
  const today = localDateKey();
  if (!raw || raw.date !== today) return { ...EMPTY, date: today };
  return {
    date: today,
    chars: Math.max(0, Math.floor(raw.chars ?? 0)),
    requests: Math.max(0, Math.floor(raw.requests ?? 0)),
    tests: Math.max(0, Math.floor(raw.tests ?? 0)),
  };
}

export async function recordUsage(
  chars: number,
  kind: 'request' | 'test' = 'request',
): Promise<UsageRecord> {
  const current = await getUsage();
  const next: UsageRecord = {
    date: current.date,
    chars: current.chars + Math.max(0, Math.floor(chars)),
    requests: current.requests + (kind === 'request' ? 1 : 0),
    tests: current.tests + (kind === 'test' ? 1 : 0),
  };
  await chrome.storage.local.set({ [USAGE_KEY]: next });
  return next;
}

export function softLimitAllows(
  used: number,
  incoming: number,
  limit: number | null,
): { allowed: boolean; used: number; limit: number | null } {
  if (limit === null || limit <= 0) return { allowed: true, used, limit };
  return { allowed: used + incoming <= limit, used, limit };
}
