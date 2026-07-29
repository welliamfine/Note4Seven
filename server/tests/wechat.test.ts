import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { AppError } from '../src/lib/errors';
import { buildWechatOpenApiUrl } from '../src/services/cloudbase-token';
import { WechatService } from '../src/services/wechat';
import { productionEnvironment } from './fixtures/production-config';

const productionConfig = loadConfig({
  ...productionEnvironment,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WeChat OpenAPI authentication', () => {
  it('reports OpenAPI proxy readiness without a mounted token', async () => {
    const service = new WechatService(productionConfig, async () => ({ token: null, state: 'missing' }));

    await expect(service.integrationStatus()).resolves.toBe('ready');
    await expect(service.integrationReadiness()).resolves.toEqual({
      status: 'ready',
      mode: 'transparent_proxy',
      tokenFile: 'missing',
    });
  });

  it('reports mounted token readiness without exposing the token', async () => {
    const ready = new WechatService(productionConfig, async () => ({ token: 'mounted token', state: 'ready' }));

    await expect(ready.integrationStatus()).resolves.toBe('ready');
    await expect(ready.integrationReadiness()).resolves.toEqual({
      status: 'ready',
      mode: 'direct_token',
      tokenFile: 'ready',
    });
  });

  it('routes an HTTPS base through the CloudRun HTTP proxy without a token', async () => {
    let requestedUrl = '';
    const tokenProvider = vi.fn(async () => ({ token: null, state: 'missing' } as const));
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ errcode: 0, result: { suggest: 'pass' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const service = new WechatService({
      ...productionConfig,
      wechatOpenApiBase: 'https://api.weixin.qq.com',
    }, tokenProvider);
    await service.assertTextAllowed('openid', 'safe text');

    const url = new URL(requestedUrl);
    expect(url.protocol).toBe('http:');
    expect(url.pathname).toBe('/wxa/msg_sec_check');
    expect(url.searchParams.has('cloudbase_access_token')).toBe(false);
    expect(tokenProvider).toHaveBeenCalledTimes(3);
  });

  it('uses HTTPS when a mounted CloudBase token is available', async () => {
    let requestedUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ errcode: 0, result: { suggest: 'pass' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const service = new WechatService({
      ...productionConfig,
      wechatOpenApiBase: 'http://api.weixin.qq.com',
    }, async () => ({
      token: 'mounted token',
      state: 'ready',
    }));
    await service.assertTextAllowed('openid', 'safe text');

    const url = new URL(requestedUrl);
    expect(url.protocol).toBe('https:');
    expect(url.pathname).toBe('/wxa/msg_sec_check');
    expect(url.searchParams.get('cloudbase_access_token')).toBe('mounted token');
  });

  it('preserves safe CloudRun proxy diagnostics for an upstream failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      request_id: 'proxy-request-id',
      error_type: 'OPENAPI_PROXY_ERROR',
      error_code: 10001,
      error_message: 'sidecar unavailable',
      internalDetail: { secret: 'must not be logged' },
    }), {
      status: 502,
      headers: {
        'content-type': 'application/json',
        'x-openapi-seqid': 'proxy-sequence-id',
      },
    })));

    const service = new WechatService(productionConfig, async () => ({ token: null, state: 'missing' }));
    let caught: unknown;
    try {
      await service.assertTextAllowed('openid', 'safe text');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).data).toEqual({
      upstreamEndpoint: '/wxa/msg_sec_check',
      upstreamProtocol: 'http',
      tokenMode: 'transparent_proxy',
      upstreamStatus: 502,
      upstreamContentType: 'application/json',
      openApiSeqId: 'proxy-sequence-id',
      wechatCode: undefined,
      wechatMessage: undefined,
      upstreamCode: null,
      upstreamMessage: null,
      proxyRequestId: 'proxy-request-id',
      proxyErrorType: 'OPENAPI_PROXY_ERROR',
      proxyErrorCode: 10001,
      proxyErrorMessage: 'sidecar unavailable',
      upstreamKeys: ['request_id', 'error_type', 'error_code', 'error_message', 'internalDetail'],
    });
    expect(JSON.stringify((caught as AppError).data)).not.toContain('must not be logged');
  });

  it('reports missing authentication for a non-proxy official API configuration', async () => {
    const service = new WechatService(
      { ...productionConfig, wechatOpenApiBase: 'https://api.weixin.qq.com.cn' },
      async () => ({ token: null, state: 'missing' }),
    );
    await expect(service.integrationReadiness()).resolves.toEqual({
      status: 'pending',
      mode: 'unavailable',
      tokenFile: 'missing',
    });
  });

  it('retries a briefly unavailable mounted token', async () => {
    let tokenReads = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      errcode: 0,
      result: { suggest: 'pass' },
    }), { status: 200 })));

    const service = new WechatService({
      ...productionConfig,
      wechatOpenApiBase: 'https://api.weixin.qq.com',
    }, async () => {
      tokenReads += 1;
      return tokenReads < 2
        ? { token: null, state: 'missing' }
        : { token: 'mounted token', state: 'ready' };
    });
    await service.assertTextAllowed('openid', 'safe text');

    expect(tokenReads).toBe(2);
  });

  it('does not force HTTPS for a custom OpenAPI test endpoint', () => {
    expect(buildWechatOpenApiUrl('http://127.0.0.1:9000', '/wxa/msg_sec_check', 'token'))
      .toBe('http://127.0.0.1:9000/wxa/msg_sec_check?cloudbase_access_token=token');
  });

  it('generates an experience-version code for the requested subpackage page', async () => {
    let requestBody: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(Uint8Array.from([137, 80, 78, 71]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }));

    const service = new WechatService(productionConfig, async () => ({ token: null, state: 'missing' }));
    await expect(service.getUnlimitedCode('invite-scene', 'subpackages/invite-intro/index'))
      .resolves.toEqual(Buffer.from([137, 80, 78, 71]));
    expect(requestBody).toEqual({
      scene: 'invite-scene',
      page: 'subpackages/invite-intro/index',
      check_path: false,
      env_version: 'trial',
      width: 430,
    });
  });
});
