import { readFile } from 'node:fs/promises';

const ACCESS_TOKEN_PATH = '/.tencentcloudbase/wx/cloudbase_access_token';

export type CloudbaseAccessTokenState = 'ready' | 'missing' | 'forbidden' | 'unreadable';

export interface CloudbaseAccessTokenResult {
  token: string | null;
  state: CloudbaseAccessTokenState;
}

export type CloudbaseAccessTokenProvider = () => Promise<CloudbaseAccessTokenResult>;

export async function readCloudbaseAccessToken(): Promise<CloudbaseAccessTokenResult> {
  try {
    const token = (await readFile(ACCESS_TOKEN_PATH, 'utf8')).trim();
    return token
      ? { token, state: 'ready' }
      : { token: null, state: 'unreadable' };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
    return {
      token: null,
      state: code === 'ENOENT' ? 'missing' : code === 'EACCES' ? 'forbidden' : 'unreadable',
    };
  }
}

export function buildWechatOpenApiUrl(base: string, path: string, cloudbaseAccessToken: string | null): string {
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
  // Without a mounted token, CloudRun authenticates requests through its
  // in-network HTTP OpenAPI proxy. A mounted token can use the public HTTPS API.
  if (url.hostname === 'api.weixin.qq.com') {
    url.protocol = cloudbaseAccessToken ? 'https:' : 'http:';
  }
  if (cloudbaseAccessToken) {
    url.searchParams.set('cloudbase_access_token', cloudbaseAccessToken);
  }
  return url.toString();
}
