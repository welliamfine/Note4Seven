import { createId } from '../utils/id';

interface Envelope<T> {
  code: string;
  message: string;
  data: T;
  requestId: string;
}

const LOCAL_API_BASE = 'http://127.0.0.1:8080';
const DEV_OPEN_ID_KEY = 'record_life_dev_openid';
const TOKEN_KEY = 'record_life_access_token_dev';
let accessToken = '';
let loginPromise: Promise<string> | null = null;

function devOpenId(): string {
  return wx.getStorageSync<string>(DEV_OPEN_ID_KEY) || 'dev-user-1';
}

async function call<T>(path: string, method: string, data?: unknown, token?: string): Promise<T> {
  const response = await request(`/api/v1${path}`, method, data, token);
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
      wxCode: 'local-development',
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

export async function uploadBackendFile(
  cloudPath: string,
  filePath: string,
  onProgress?: (progress: number) => void,
): Promise<{ fileID: string }> {
  const token = await ensureRemoteSession();
  const data = await readFile(filePath);
  onProgress?.(20);
  await rawRequest(`/api/v1/dev-storage/upload?key=${encodeURIComponent(cloudPath)}`, data, token);
  onProgress?.(100);
  return { fileID: `local://${cloudPath}` };
}

function request(path: string, method: string, data?: unknown, token?: string): Promise<WechatMiniprogram.RequestSuccessCallbackResult> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${LOCAL_API_BASE}${path}`,
      method: method as WechatMiniprogram.RequestOption['method'],
      header: {
        'x-dev-openid': devOpenId(),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      },
      data: data as string | Record<string, unknown> | ArrayBuffer | undefined,
      success: resolve,
      fail: reject,
    });
  });
}

function rawRequest(path: string, data: ArrayBuffer, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${LOCAL_API_BASE}${path}`,
      method: 'PUT',
      header: {
        authorization: `Bearer ${token}`,
        'x-dev-openid': devOpenId(),
        'content-type': 'application/octet-stream',
      },
      data,
      success: (result) => result.statusCode >= 200 && result.statusCode < 300
        ? resolve()
        : reject(new Error(`LOCAL_UPLOAD_${result.statusCode}`)),
      fail: reject,
    });
  });
}

function readFile(filePath: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      success: ({ data }) => typeof data === 'string'
        ? reject(new Error('LOCAL_UPLOAD_BINARY_READ_FAILED'))
        : resolve(data),
      fail: reject,
    });
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
