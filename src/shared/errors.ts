import type { ActionId, ErrorCode, ErrorPayload } from './types';

const USER_MESSAGES: Record<ErrorCode, string> = {
  UNSUPPORTED: '当前浏览器或页面环境不支持所选翻译引擎。',
  MODEL_NOT_READY: '本地翻译模型尚未准备完成。',
  MODEL_DOWNLOAD_FAILED: '本地翻译模型下载失败。',
  AUTH_FAILED: '云端 API Key 无效或未授权。',
  QUOTA_EXCEEDED: '云端额度不足或模型未开通。',
  RATE_LIMITED: '请求过于频繁，已被云端限流。',
  NETWORK_ERROR: '网络请求失败，无法连接翻译服务。',
  TIMEOUT: '翻译请求超时。',
  TEXT_TOO_LONG: '选区文字过长。',
  LANGUAGE_UNCERTAIN: '无法可靠判断源语言。',
  PERMISSION_DENIED: '缺少所需的网站访问权限。',
  CANCELLED: '请求已取消。',
  CONFIG_MISSING: '云端翻译尚未配置。',
  INTERNAL_ERROR: '翻译时发生内部错误。',
};

const ACTIONS: Partial<Record<ErrorCode, ActionId>> = {
  MODEL_NOT_READY: 'prepare-model',
  MODEL_DOWNLOAD_FAILED: 'prepare-model',
  AUTH_FAILED: 'configure-cloud',
  QUOTA_EXCEEDED: 'configure-cloud',
  CONFIG_MISSING: 'configure-cloud',
  PERMISSION_DENIED: 'grant-access',
  LANGUAGE_UNCERTAIN: 'open-options',
  TEXT_TOO_LONG: 'reduce-selection',
};

const RETRYABLE: Partial<Record<ErrorCode, boolean>> = {
  NETWORK_ERROR: true,
  TIMEOUT: true,
  RATE_LIMITED: true,
  INTERNAL_ERROR: true,
  MODEL_DOWNLOAD_FAILED: true,
  MODEL_NOT_READY: true,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly action?: ActionId;
  readonly diagnostic?: string;
  readonly userMessage: string;

  constructor(
    code: ErrorCode,
    options: { message?: string; retryable?: boolean; action?: ActionId; diagnostic?: string } = {},
  ) {
    super(options.message ?? USER_MESSAGES[code]);
    this.name = 'AppError';
    this.code = code;
    this.userMessage = options.message ?? USER_MESSAGES[code];
    this.retryable = options.retryable ?? RETRYABLE[code] ?? false;
    this.action = options.action ?? ACTIONS[code];
    this.diagnostic = options.diagnostic;
  }

  toPayload(): ErrorPayload {
    return {
      code: this.code,
      message: this.userMessage,
      retryable: this.retryable,
      ...(this.action ? { action: this.action } : {}),
      ...(this.diagnostic ? { diagnostic: this.diagnostic } : {}),
    };
  }
}

export function toErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof AppError) return error.toPayload();
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return new AppError('CANCELLED').toPayload();
    }
    return new AppError('INTERNAL_ERROR', {
      diagnostic: error.name,
    }).toPayload();
  }
  return new AppError('INTERNAL_ERROR').toPayload();
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
