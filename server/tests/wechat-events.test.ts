import express, { type ErrorRequestHandler } from 'express';
import type { Pool } from 'mysql2/promise';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { AppError } from '../src/lib/errors';
import {
  isCloudHostingMessagePush,
  isContainerPathCheck,
  mediaCheckDecision,
  parseEventBody,
  wechatEventRoutes,
} from '../src/routes/wechat-events';

const config = loadConfig({
  MYSQL_ADDRESS: 'db.internal:3306',
  MYSQL_USERNAME: 'app',
  MYSQL_PASSWORD: 'secret',
  WECHAT_CALLBACK_TOKEN: 'callback-token-for-tests',
});

const callbackContext = gzipSync(Buffer.from(JSON.stringify({
  envId: config.cloudEnvId,
  serviceName: config.cloudService,
  source: 'wx_wx_callback',
}))).toString('base64');

describe('WeChat Cloud Hosting message push', () => {
  it('recognizes supported Cloud Hosting message-push source headers', () => {
    const identity = { 'x-wx-appid': config.appId, 'x-wx-env': config.cloudEnvId };
    expect(isCloudHostingMessagePush({
      ...identity,
      'x-cloudbase-context': callbackContext,
      'x-wx-source': 'other',
      'x-authmethod': 'WX_SERVER_AUTH',
    }, config)).toBe(true);
    expect(isCloudHostingMessagePush({ ...identity, 'x-wx-sources': 'wx-cloudrun' }, config)).toBe(true);
    expect(isCloudHostingMessagePush({
      ...identity,
      'x-cloudbase-context': callbackContext,
      'x-wx-env': 'other-environment',
    }, config)).toBe(false);
    expect(isCloudHostingMessagePush({
      ...identity,
      'x-wx-source': 'other',
      'x-authmethod': 'WX_SERVER_AUTH',
    }, config)).toBe(false);
    expect(isCloudHostingMessagePush({}, config)).toBe(false);
  });

  it('recognizes the path check sent while saving the configuration', () => {
    expect(isContainerPathCheck({ action: 'CheckContainerPath' })).toBe(true);
    expect(isContainerPathCheck({ Action: 'checkcontainerpath' })).toBe(true);
    expect(isContainerPathCheck({ Event: 'wxa_media_check' })).toBe(false);
  });

  it('parses both XML and JSON push bodies', () => {
    expect(parseEventBody('<xml><action>CheckContainerPath</action></xml>'))
      .toEqual({ action: 'CheckContainerPath' });
    expect(parseEventBody({ action: 'CheckContainerPath' }))
      .toEqual({ action: 'CheckContainerPath' });
  });

  it('accepts the Cloud Hosting path probe and protects the public endpoint', async () => {
    const execute = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT media_id, processing_attempts')) {
        return Promise.resolve([[{ media_id: '28', processing_attempts: 1 }], []]);
      }
      return Promise.resolve([{ affectedRows: 1 }, []]);
    });
    const pool = { execute } as unknown as Pool;
    const app = express();
    app.use(express.text({ type: ['text/xml', 'application/xml'] }));
    app.use(express.json());
    app.use(wechatEventRoutes(pool, config));
    const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
      response.status(error instanceof AppError ? error.httpStatus : 500).send('error');
    };
    app.use(errorHandler);

    const server = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port');
      const url = `http://127.0.0.1:${address.port}/wechat/events`;
      const body = '<xml><action>CheckContainerPath</action></xml>';

      const cloudResponse = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/xml' },
        body,
      });
      expect(cloudResponse.status).toBe(200);
      expect(await cloudResponse.text()).toBe('success');

      const callbackResponse = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-authmethod': 'WX_SERVER_AUTH',
          'x-cloudbase-context': callbackContext,
          'x-wx-appid': config.appId,
          'x-wx-env': config.cloudEnvId,
          'x-wx-source': 'other',
        },
        body: JSON.stringify({
          Event: 'wxa_media_check',
          trace_id: 'trace-cloud-callback',
          result: { suggest: 'pass' },
          errcode: 0,
        }),
      });
      expect(callbackResponse.status).toBe(200);
      expect(await callbackResponse.text()).toBe('success');
      expect(execute).toHaveBeenCalledWith(
        expect.stringContaining("content_check_status = 'passed'"),
        ['28', 'trace-cloud-callback'],
      );

      const callsBeforePublicRequest = execute.mock.calls.length;
      const publicResponse = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/xml' },
        body: '<xml><Event>wxa_media_check</Event><trace_id>trace-public</trace_id></xml>',
      });
      expect(publicResponse.status).toBe(401);
      expect(execute).toHaveBeenCalledTimes(callsBeforePublicRequest);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});

describe('WeChat media audit callback', () => {
  it('accepts the current version 2 result structure', () => {
    expect(mediaCheckDecision({
      Event: 'wxa_media_check',
      trace_id: 'trace-pass',
      version: 2,
      result: { suggest: 'pass', label: 100 },
      errcode: 0,
    })).toEqual({
      traceId: 'trace-pass',
      outcome: 'passed',
      suggest: 'pass',
      label: 100,
      statusCode: 0,
      reason: 'result',
    });
  });

  it('retries review results and only rejects explicit risky results', () => {
    expect(mediaCheckDecision({ Event: 'wxa_media_check', trace_id: 'trace-review', result: { suggest: 'review' } }))
      .toMatchObject({ traceId: 'trace-review', outcome: 'retry', suggest: 'review' });
    expect(mediaCheckDecision({ Event: 'wxa_media_check', trace_id: 'trace-risky', result: { suggest: 'risky' } }))
      .toMatchObject({ traceId: 'trace-risky', outcome: 'rejected', suggest: 'risky' });
  });

  it('reads the version 2 detail array used by asynchronous image callbacks', () => {
    expect(mediaCheckDecision({
      Event: 'wxa_media_check',
      trace_id: 'trace-detail',
      detail: [
        { strategy: 'content_model', errcode: 0, suggest: 'pass', label: 100 },
        { strategy: 'ocr', errcode: 0, suggest: 'pass', label: 200 },
      ],
    })).toMatchObject({ traceId: 'trace-detail', outcome: 'passed', suggest: 'pass', reason: 'detail' });
  });

  it('retries service errors and callbacks without an explicit verdict', () => {
    expect(mediaCheckDecision({
      Event: 'wxa_media_check',
      trace_id: 'trace-error',
      detail: [{ errcode: -1, suggest: 'pass' }],
    })).toMatchObject({ traceId: 'trace-error', outcome: 'retry', reason: 'service_error' });
    expect(mediaCheckDecision({ Event: 'wxa_media_check', trace_id: 'trace-missing' }))
      .toMatchObject({ traceId: 'trace-missing', outcome: 'retry', reason: 'missing_verdict' });
  });

  it('supports the legacy isrisky field and ignores unrelated events', () => {
    expect(mediaCheckDecision({ Event: 'wxa_media_check', trace_id: 'trace-old', isrisky: 0, status_code: 0 }))
      .toMatchObject({ traceId: 'trace-old', outcome: 'passed', suggest: 'pass', reason: 'legacy' });
    expect(mediaCheckDecision({ Event: 'subscribe', trace_id: 'trace-other' })).toBeNull();
  });
});
