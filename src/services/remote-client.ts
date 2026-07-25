import { CLOUD_ENV_ID, CLOUD_SERVICE } from '../config/runtime';
import { createId } from '../utils/id';

interface Envelope<T> {
  code: string;
  message: string;
  data: T;
  requestId: string;
}

const TOKEN_KEY = 'record_life_access_token';
let accessToken = '';
let loginPromise: Promise<string> | null = null;

function wxLogin(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.login({ success: ({ code }) => resolve(code), fail: reject });
  });
}

async function call<T>(path: string, method: string, data?: unknown, token?: string): Promise<T> {
  const response = await wx.cloud.callContainer({
    config: { env: CLOUD_ENV_ID },
    path: `/api/v1${path}`,
    method: method as WechatMiniprogram.RequestOption['method'],
    header: {
      'X-WX-SERVICE': CLOUD_SERVICE,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
    },
    data: data as string | Record<string, unknown> | ArrayBuffer | undefined,
  });
  return unwrap<T>(response.statusCode, response.data);
}

export async function ensureRemoteSession(force = false): Promise<string> {
  if (!force) {
    accessToken ||= wx.getStorageSync<string>(TOKEN_KEY) || '';
    if (accessToken) return accessToken;
  }
  if (loginPromise) return loginPromise;
  loginPromise = (async () => {
    const result = await call<{ accessToken: string }>('/auth/wechat/login', 'POST', {
      wxCode: await wxLogin(),
      clientRequestId: createId('login'),
    });
    accessToken = result.accessToken;
    wx.setStorageSync(TOKEN_KEY, accessToken);
    return accessToken;
  })().finally(() => { loginPromise = null; });
  return loginPromise;
}

export async function remoteRequest<T>(path: string, options: {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  data?: unknown;
  public?: boolean;
} = {}): Promise<T> {
  const token = options.public ? undefined : await ensureRemoteSession();
  try {
    return await call<T>(path, options.method ?? 'GET', options.data, token);
  } catch (error) {
    if (!options.public && error instanceof Error && (error as Error & { statusCode?: number }).statusCode === 401) {
      clearRemoteSession();
      return call<T>(path, options.method ?? 'GET', options.data, await ensureRemoteSession(true));
    }
    throw error;
  }
}

export function clearRemoteSession(): void {
  accessToken = '';
  wx.removeStorageSync(TOKEN_KEY);
}

export function uploadBackendFile(
  cloudPath: string,
  filePath: string,
  onProgress?: (progress: number) => void,
): Promise<{ fileID: string }> {
  return new Promise((resolve, reject) => {
    const task = wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success: resolve,
      fail: reject,
    });
    if (onProgress) task.onProgressUpdate(({ progress }) => onProgress(progress));
  });
}

function unwrap<T>(statusCode: number, data: unknown): T {
  const envelope = data as Envelope<T>;
  if (statusCode >= 200 && statusCode < 300 && envelope.code === 'OK') return envelope.data;
  const legacyCode: Record<string, string> = {
    MODULE_MEMBER_LIMIT_REACHED: 'MODULE_FULL',
    RECORD_DATE_NOT_ALLOWED: 'RECORD_DATE_LOCKED',
    RECORD_LOCKED: 'RECORD_DATE_LOCKED',
    CREATOR_CANNOT_LEAVE: 'MODULE_TRANSFER_REQUIRED',
    JOIN_REAPPLY_COOLDOWN: 'JOIN_COOLDOWN',
  };
  const error = new Error(legacyCode[envelope.code] ?? envelope.code ?? 'NETWORK_ERROR');
  Object.assign(error, { code: envelope.code, requestId: envelope.requestId, statusCode });
  throw error;
}
