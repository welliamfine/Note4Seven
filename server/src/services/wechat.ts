import type { AppConfig } from '../config';
import { AppError } from '../lib/errors';
import {
  buildWechatOpenApiUrl,
  readCloudbaseAccessToken,
  type CloudbaseAccessTokenProvider,
  type CloudbaseAccessTokenResult,
  type CloudbaseAccessTokenState,
} from './cloudbase-token';

interface WechatResponse {
  errcode?: number;
  errmsg?: string;
  code?: string | number;
  message?: string;
  request_id?: string;
  error_type?: string;
  error_code?: string | number;
  error_message?: string;
  trace_id?: string;
  result?: {
    suggest?: 'pass' | 'review' | 'risky';
    label?: number;
  };
}

const CLOUD_TOKEN_RETRY_DELAYS_MS = [0, 150, 350] as const;

export interface WechatIntegrationReadiness {
  status: 'ready' | 'pending' | 'not_required';
  mode: 'direct_token' | 'transparent_proxy' | 'not_required' | 'unavailable';
  tokenFile: CloudbaseAccessTokenState | 'not_required';
}

export class WechatService {
  constructor(
    private readonly config: AppConfig,
    private readonly accessToken: CloudbaseAccessTokenProvider = readCloudbaseAccessToken,
  ) {}

  async integrationReadiness(): Promise<WechatIntegrationReadiness> {
    if (this.config.nodeEnv !== 'production') {
      return { status: 'not_required', mode: 'not_required', tokenFile: 'not_required' };
    }
    const accessToken = await this.accessToken();
    if (accessToken.token) {
      return { status: 'ready', mode: 'direct_token', tokenFile: accessToken.state };
    }
    if (usesCloudRunOpenApiProxy(this.config.wechatOpenApiBase)) {
      return { status: 'ready', mode: 'transparent_proxy', tokenFile: accessToken.state };
    }
    return { status: 'pending', mode: 'unavailable', tokenFile: accessToken.state };
  }

  async integrationStatus(): Promise<'ready' | 'pending' | 'not_required'> {
    return (await this.integrationReadiness()).status;
  }

  async assertTextAllowed(openId: string, content: string, scene = 2): Promise<void> {
    if (!content.trim()) return;
    if (this.config.nodeEnv !== 'production') return;
    const result = await this.call<WechatResponse>('/wxa/msg_sec_check', {
      openid: openId,
      version: 2,
      scene,
      content,
    });
    if (result.errcode && result.errcode !== 0) {
      throw new AppError('CONTENT_CHECK_UNAVAILABLE', '内容检查暂时不可用，请稍后重试', 503, {
        wechatCode: result.errcode,
        wechatMessage: result.errmsg,
      });
    }
    if (result.result?.suggest !== 'pass') {
      throw new AppError('CONTENT_REJECTED', '文字内容未通过安全检查，请修改后重试', 422);
    }
  }

  async sendSubscriptionMessage(payload: Record<string, unknown>): Promise<void> {
    const result = await this.call<WechatResponse>('/cgi-bin/message/subscribe/send', payload);
    if (result.errcode && result.errcode !== 0) {
      throw new AppError('SUBSCRIBE_MESSAGE_FAILED', '订阅消息发送失败', 502, {
        wechatCode: result.errcode,
      });
    }
  }

  async beginMediaCheck(openId: string, mediaUrl: string, scene = 2): Promise<string> {
    if (this.config.nodeEnv !== 'production') return `local_trace_${Date.now()}`;
    const result = await this.call<WechatResponse>('/wxa/media_check_async', {
      openid: openId,
      version: 2,
      scene,
      media_type: 2,
      media_url: mediaUrl,
    });
    if (result.errcode && result.errcode !== 0) {
      throw new AppError('MEDIA_CONTENT_CHECK_FAILED', '图片内容检查暂时不可用', 503);
    }
    if (!result.trace_id) throw new AppError('MEDIA_CONTENT_CHECK_FAILED', '图片内容检查未返回任务编号', 503);
    return result.trace_id;
  }

  async getUnlimitedCode(scene: string, page: string): Promise<Buffer> {
    if (this.config.nodeEnv !== 'production') return Buffer.from('local-mini-program-code');
    let response: globalThis.Response;
    try {
      response = await fetch(await this.openApiUrl('/wxa/getwxacodeunlimit'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scene, page, check_path: false, env_version: 'release', width: 430 }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new AppError('MINI_PROGRAM_CODE_FAILED', '邀请小程序码生成失败，请稍后重试', 503);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (response.ok && contentType.startsWith('image/')) return Buffer.from(await response.arrayBuffer());

    const body = await response.text();
    let details: WechatResponse = {};
    try { details = JSON.parse(body) as WechatResponse; } catch { /* The upstream may return a non-JSON error page. */ }
    throw new AppError('MINI_PROGRAM_CODE_FAILED', '邀请小程序码生成失败，请稍后重试', 503, {
      wechatCode: details.errcode,
    });
  }

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = await this.openApiUrl(path);
    const target = new URL(url);
    const diagnostics = {
      upstreamEndpoint: target.pathname,
      upstreamProtocol: target.protocol.replace(':', ''),
      tokenMode: target.searchParams.has('cloudbase_access_token') ? 'mounted_token' : 'transparent_proxy',
    };
    let response: globalThis.Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new AppError('WECHAT_API_UNAVAILABLE', '微信服务暂时不可用，请稍后重试', 503, {
        ...diagnostics,
        causeName: error instanceof Error ? error.name : typeof error,
        causeCode: errorCode(error),
      });
    }
    const responseText = await response.text();
    let result: WechatResponse;
    try {
      result = JSON.parse(responseText) as WechatResponse;
    } catch {
      throw new AppError('WECHAT_API_UNAVAILABLE', '微信服务暂时不可用，请稍后重试', 503, {
        ...diagnostics,
        upstreamStatus: response.status,
        upstreamContentType: response.headers.get('content-type'),
        openApiSeqId: response.headers.get('x-openapi-seqid'),
      });
    }
    if (!response.ok) {
      throw new AppError('WECHAT_API_UNAVAILABLE', '微信服务暂时不可用，请稍后重试', 503, {
        ...diagnostics,
        upstreamStatus: response.status,
        upstreamContentType: response.headers.get('content-type'),
        openApiSeqId: response.headers.get('x-openapi-seqid'),
        wechatCode: result.errcode,
        wechatMessage: result.errmsg,
        upstreamCode: diagnosticScalar(result.code),
        upstreamMessage: diagnosticScalar(result.message),
        proxyRequestId: diagnosticScalar(result.request_id),
        proxyErrorType: diagnosticScalar(result.error_type),
        proxyErrorCode: diagnosticScalar(result.error_code),
        proxyErrorMessage: diagnosticScalar(result.error_message),
        upstreamKeys: Object.keys(result).slice(0, 12),
      });
    }
    return result as T;
  }

  private async openApiUrl(path: string): Promise<string> {
    const accessToken = await this.readAccessTokenWithRetry();
    const token = accessToken.token;

    const url = buildWechatOpenApiUrl(this.config.wechatOpenApiBase, path, token);
    const isOfficialWechatApi = new URL(url).hostname === 'api.weixin.qq.com';
    if (
      this.config.nodeEnv === 'production'
      && isOfficialWechatApi
      && !token
      && !usesCloudRunOpenApiProxy(this.config.wechatOpenApiBase)
    ) {
      throw new AppError(
        'WECHAT_TOKEN_NOT_READY',
        '微信安全服务正在初始化，请稍后重试',
        503,
      );
    }
    return url;
  }

  private async readAccessTokenWithRetry(): Promise<CloudbaseAccessTokenResult> {
    let result: CloudbaseAccessTokenResult = { token: null, state: 'missing' };
    for (const delayMs of CLOUD_TOKEN_RETRY_DELAYS_MS) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      result = await this.accessToken();
      if (result.token) break;
    }
    return result;
  }
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = error.code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : null;
}

function diagnosticScalar(value: unknown): string | number | null {
  if (typeof value === 'string') return value.slice(0, 300);
  return typeof value === 'number' ? value : null;
}

function usesCloudRunOpenApiProxy(base: string): boolean {
  const url = new URL(base);
  return url.hostname === 'api.weixin.qq.com';
}
