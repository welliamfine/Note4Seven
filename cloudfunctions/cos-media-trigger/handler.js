'use strict';

const DEFAULT_MAX_ORIGINAL_BYTES = 10 * 1024 * 1024;
const ORIGINAL_KEY = /^media\/\d+\/\d+\/original\.jpg$/;

function createHandler({ callContainer, environment = process.env }) {
  if (typeof callContainer !== 'function') throw new TypeError('callContainer must be a function');
  return async function handleCosEvent(event) {
    const records = Array.isArray(event && event.Records) ? event.Records : [];
    const results = [];
    for (const record of records) {
      const eventName = String(record.eventName || record.event?.eventName || '');
      if (!eventName.startsWith('cos:ObjectCreated:')) continue;
      const bucket = bucketId(record);
      const objectKey = cosObjectKey(record);
      const size = Number(record.cos?.cosObject?.size);
      const maxBytes = positiveInteger(environment.MAX_ORIGINAL_BYTES, DEFAULT_MAX_ORIGINAL_BYTES);
      if (!bucket || !ORIGINAL_KEY.test(objectKey) || !Number.isInteger(size) || size <= 0 || size > maxBytes) {
        results.push({ objectKey, status: 'ignored' });
        continue;
      }
      const response = await callContainer({
        name: requiredValue(environment.CLOUD_SERVICE, 'CLOUD_SERVICE'),
        path: '/internal/storage/object-created',
        method: 'POST',
        header: {
          'content-type': 'application/json',
          'x-storage-event-token': requiredValue(environment.STORAGE_EVENT_TOKEN, 'STORAGE_EVENT_TOKEN'),
        },
        data: { bucket, objectKey, size, eventName },
      });
      if (Number(response?.statusCode ?? 500) >= 300) {
        throw new Error(`CloudRun rejected COS event with HTTP ${response?.statusCode ?? 'unknown'}`);
      }
      results.push({ objectKey, status: 'forwarded' });
    }
    return { processed: results.length, results };
  };
}

function bucketId(record) {
  const bucket = record.cos?.cosBucket ?? {};
  const name = String(bucket.name || '');
  const appId = String(bucket.appid || '');
  return appId && !name.endsWith(`-${appId}`) ? `${name}-${appId}` : name;
}

function cosObjectKey(record) {
  const bucket = record.cos?.cosBucket ?? {};
  const object = record.cos?.cosObject ?? {};
  let decoded;
  try {
    decoded = decodeURIComponent(String(object.key || '').replace(/\+/g, '%20'));
  } catch {
    return '';
  }
  const prefix = `/${String(bucket.appid || '')}/${String(bucket.name || '')}/`;
  return (decoded.startsWith(prefix) ? decoded.slice(prefix.length) : decoded).replace(/^\/+/, '');
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function requiredValue(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value;
}

module.exports = { createHandler, bucketId, cosObjectKey, DEFAULT_MAX_ORIGINAL_BYTES };
