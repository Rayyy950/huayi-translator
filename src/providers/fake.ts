import { AppError } from '../shared/errors';
import { delay } from '../shared/rate-limit';
import type { SourceLanguage, TargetLanguage } from '../shared/types';

/**
 * Test-only provider. It is selected only when __FAKE_PROVIDER__ is true in the
 * build (npm run build:test) and the hidden useFakeProvider setting is on.
 * Markers let e2e tests exercise ordering and failures deterministically.
 */
export function fakeTranslate(
  text: string,
  _source: SourceLanguage,
  _target: TargetLanguage,
  signal: AbortSignal,
): Promise<{ text: string; attempts: number; charsSent: number }> {
  let delayMs = 120;
  let body = text;
  if (body.startsWith('[[slow]]')) {
    delayMs = 1500;
    body = body.slice('[[slow]]'.length);
  } else if (body.startsWith('[[fast]]')) {
    delayMs = 30;
    body = body.slice('[[fast]]'.length);
  }
  const failNetwork = body.includes('[[fail-network]]');
  const failAuth = body.includes('[[fail-auth]]');
  const empty = body.includes('[[empty]]');
  body = body
    .replaceAll('[[fail-network]]', '')
    .replaceAll('[[fail-auth]]', '')
    .replaceAll('[[empty]]', '');

  return delay(delayMs, signal).then(() => {
    if (failAuth) throw new AppError('AUTH_FAILED', { diagnostic: 'fake auth' });
    if (failNetwork) throw new AppError('NETWORK_ERROR', { diagnostic: 'fake network' });
    if (empty) throw new AppError('INTERNAL_ERROR', { diagnostic: 'fake empty' });
    return { text: `〔测试译文〕${body.trim()}`, attempts: 1, charsSent: Array.from(body).length };
  });
}
