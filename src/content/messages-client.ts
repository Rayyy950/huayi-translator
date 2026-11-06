import { AppError } from '../shared/errors';
import type { Response } from '../shared/messages';

export async function sendRuntimeMessage<T>(message: unknown): Promise<Response<T>> {
  try {
    const response = (await chrome.runtime.sendMessage(message)) as Response<T> | undefined;
    if (!response || typeof response !== 'object' || !('ok' in response)) {
      throw new AppError('INTERNAL_ERROR', { diagnostic: 'no response' });
    }
    return response;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('INTERNAL_ERROR', {
      diagnostic: error instanceof Error ? error.name : 'sendMessage',
    });
  }
}
