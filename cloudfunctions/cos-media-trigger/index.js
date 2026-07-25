'use strict';

const cloudbase = require('@cloudbase/node-sdk');

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });

exports.main = async (event) => {
  const records = Array.isArray(event && event.Records) ? event.Records : [];
  const results = [];
  for (const record of records) {
    const eventName = String(record.eventName || '');
    if (!eventName.startsWith('cos:ObjectCreated:')) continue;
    const bucket = bucketId(record);
    const objectKey = cosObjectKey(record);
    const size = Number(record.cos && record.cos.cosObject && record.cos.cosObject.size);
    if (!/^media\/\d+\/\d+\/original\.jpg$/.test(objectKey) || !Number.isInteger(size) || size <= 0) {
      results.push({ objectKey, status: 'ignored' });
      continue;
    }
    const response = await app.callContainer({
      name: process.env.CLOUD_SERVICE || 'express-bonj',
      path: '/internal/storage/object-created',
      method: 'POST',
      header: {
        'content-type': 'application/json',
        'x-storage-event-token': requiredEventToken(),
      },
      data: { bucket, objectKey, size, eventName },
    });
    if (Number(response.statusCode || 500) >= 300) {
      throw new Error(`CloudRun rejected COS event with HTTP ${response.statusCode}`);
    }
    results.push({ objectKey, status: 'forwarded' });
  }
  return { processed: results.length, results };
};

function bucketId(record) {
  const bucket = record.cos && record.cos.cosBucket ? record.cos.cosBucket : {};
  const name = String(bucket.name || '');
  const appId = String(bucket.appid || '');
  return appId && !name.endsWith(`-${appId}`) ? `${name}-${appId}` : name;
}

function cosObjectKey(record) {
  const bucket = record.cos && record.cos.cosBucket ? record.cos.cosBucket : {};
  const object = record.cos && record.cos.cosObject ? record.cos.cosObject : {};
  const decoded = decodeURIComponent(String(object.key || '').replace(/\+/g, '%20'));
  const prefix = `/${String(bucket.appid || '')}/${String(bucket.name || '')}/`;
  return (decoded.startsWith(prefix) ? decoded.slice(prefix.length) : decoded).replace(/^\/+/, '');
}

function requiredEventToken() {
  const token = process.env.STORAGE_EVENT_TOKEN;
  if (!token) throw new Error('STORAGE_EVENT_TOKEN is required');
  return token;
}
