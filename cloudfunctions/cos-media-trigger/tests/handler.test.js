'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createHandler, DEFAULT_MAX_ORIGINAL_BYTES } = require('../handler');

const environment = {
  CLOUD_SERVICE: 'staging-service',
  STORAGE_EVENT_TOKEN: 'test-storage-event-token-at-least-24',
};

function record({
  eventName = 'cos:ObjectCreated:Put',
  key = '/1234567890/test-bucket/media/12/34/original.jpg',
  size = 1024,
} = {}) {
  return {
    eventName,
    cos: {
      cosBucket: { name: 'test-bucket', appid: '1234567890' },
      cosObject: { key, size },
    },
  };
}

describe('COS media trigger', () => {
  it('forwards one valid ObjectCreated event with normalized values', async () => {
    const calls = [];
    const handler = createHandler({ environment, callContainer: async (options) => {
      calls.push(options);
      return { statusCode: 200 };
    } });

    const result = await handler({ Records: [record()] });

    assert.equal(result.processed, 1);
    assert.deepEqual(result.results, [{ objectKey: 'media/12/34/original.jpg', status: 'forwarded' }]);
    assert.equal(calls[0].name, 'staging-service');
    assert.equal(calls[0].data.bucket, 'test-bucket-1234567890');
  });

  it('handles multiple records and ignores non-create events', async () => {
    let calls = 0;
    const handler = createHandler({ environment, callContainer: async () => {
      calls += 1;
      return { statusCode: 204 };
    } });
    const result = await handler({ Records: [
      record(),
      record({ eventName: 'cos:ObjectRemove:Delete' }),
      record({ key: '/1234567890/test-bucket/media/56/78/original.jpg' }),
    ] });
    assert.equal(calls, 2);
    assert.equal(result.processed, 2);
  });

  it('accepts the official nested event name and URL-encoded key', async () => {
    const handler = createHandler({ environment, callContainer: async () => ({ statusCode: 200 }) });
    const item = record({ key: '%2F1234567890%2Ftest-bucket%2Fmedia%2F12%2F34%2Foriginal.jpg' });
    delete item.eventName;
    item.event = { eventName: 'cos:ObjectCreated:CompleteMultipartUpload' };
    const result = await handler({ Records: [item] });
    assert.equal(result.results[0].status, 'forwarded');
  });

  it('ignores malformed paths, empty objects, and oversized files', async () => {
    const handler = createHandler({ environment, callContainer: async () => {
      throw new Error('must not be called');
    } });
    const result = await handler({ Records: [
      record({ key: '%E0%A4%A' }),
      record({ size: 0 }),
      record({ size: DEFAULT_MAX_ORIGINAL_BYTES + 1 }),
      record({ key: '/1234567890/test-bucket/media/12/34/preview.jpg' }),
    ] });
    assert.equal(result.processed, 4);
    assert.ok(result.results.every((item) => item.status === 'ignored'));
  });

  it('fails before forwarding when required configuration is missing', async () => {
    const handler = createHandler({ environment: { CLOUD_SERVICE: 'staging-service' }, callContainer: async () => ({ statusCode: 200 }) });
    await assert.rejects(() => handler({ Records: [record()] }), /STORAGE_EVENT_TOKEN is required/);
  });

  it('propagates non-2xx responses and network failures for platform retry', async () => {
    const rejected = createHandler({ environment, callContainer: async () => ({ statusCode: 503 }) });
    await assert.rejects(() => rejected({ Records: [record()] }), /HTTP 503/);

    const failed = createHandler({ environment, callContainer: async () => { throw new Error('network unavailable'); } });
    await assert.rejects(() => failed({ Records: [record()] }), /network unavailable/);
  });
});
