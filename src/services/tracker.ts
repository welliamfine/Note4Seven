import { RELEASE_ID, TARGET_ENVIRONMENT } from '../config/runtime';

const CONSENT_KEY = 'notemylife.analytics.consent.v1';
const QUEUE_KEY = 'notemylife.analytics.queue.v1';
const MAX_EVENTS = 200;
const MAX_QUEUE_BYTES = 256 * 1024;
const BATCH_SIZE = 25;
const MAX_PROPERTY_COUNT = 24;
const BASE_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;
const FORBIDDEN_KEY = /(openid|unionid|token|secret|password|cookie|authorization|url|uri|path|file|photo|image|avatar|nickname|name|note|content|text|location|latitude|longitude|address|(?:^|_)id$)/i;
const URL_VALUE = /(?:https?:\/\/|wxfile:\/\/|cloud:\/\/|data:image\/)/i;

type AnalyticsPrimitive = string | number | boolean;

export interface AnalyticsEvent {
  eventId: string;
  eventName: string;
  schemaVersion: '1.1';
  documentBaseline: 'prd_6.4';
  occurredAt: string;
  releaseId: string;
  environment: string;
  deviceType: string;
  networkType: string;
  properties: Record<string, AnalyticsPrimitive>;
}

interface QueuedEvent extends AnalyticsEvent {
  attempts: number;
  nextAttemptAt: number;
}

type AnalyticsUploader = (events: AnalyticsEvent[]) => Promise<void>;

let consented = false;
let uploader: AnalyticsUploader | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let initialized = false;
let networkType = 'unknown';

export function initializeTracking(nextUploader?: AnalyticsUploader): void {
  if (nextUploader) uploader = nextUploader;
  try { consented = wx.getStorageSync(CONSENT_KEY) === true; } catch { consented = false; }
  if (!initialized) {
    initialized = true;
    try {
      wx.getNetworkType({ success: (result) => { networkType = result.networkType; scheduleFlush(0); } });
      wx.onNetworkStatusChange((result) => {
        networkType = result.networkType;
        if (result.isConnected) scheduleFlush(0);
      });
    } catch {
      // Analytics availability must never affect application startup.
    }
  }
  if (consented) scheduleFlush(0);
}

export function setTrackingConsent(agreed: boolean): void {
  consented = agreed;
  try {
    wx.setStorageSync(CONSENT_KEY, agreed);
    if (!agreed) wx.removeStorageSync(QUEUE_KEY);
  } catch {
    // Consent state still applies for the current process when storage is unavailable.
  }
  if (agreed) scheduleFlush(0);
}

export function track(eventName: string, properties: Record<string, unknown> = {}): void {
  if (!consented || !/^[a-z][a-z0-9_]{1,63}$/.test(eventName)) return;
  const event: QueuedEvent = {
    eventId: `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`,
    eventName,
    schemaVersion: '1.1',
    documentBaseline: 'prd_6.4',
    occurredAt: new Date().toISOString(),
    releaseId: RELEASE_ID,
    environment: TARGET_ENVIRONMENT,
    deviceType: deviceType(),
    networkType,
    properties: sanitizeProperties(properties),
    attempts: 0,
    nextAttemptAt: 0,
  };

  try {
    const queue = readQueue();
    queue.push(event);
    writeBoundedQueue(queue);
    scheduleFlush(1_000);
  } catch {
    // Analytics must never interrupt a product workflow.
  }
}

export async function flushTracking(): Promise<void> {
  if (!consented || !uploader || flushing) return;
  const queue = readQueue();
  const now = Date.now();
  const ready = queue.filter((event) => event.nextAttemptAt <= now).slice(0, BATCH_SIZE);
  if (ready.length === 0) {
    const nextAttempt = queue.reduce((minimum, event) => Math.min(minimum, event.nextAttemptAt), Number.POSITIVE_INFINITY);
    if (Number.isFinite(nextAttempt)) scheduleFlush(Math.max(1_000, nextAttempt - now));
    return;
  }

  flushing = true;
  try {
    await uploader(ready.map(({ attempts: _attempts, nextAttemptAt: _nextAttemptAt, ...event }) => event));
    const uploadedIds = new Set(ready.map((event) => event.eventId));
    writeBoundedQueue(readQueue().filter((event) => !uploadedIds.has(event.eventId)));
    scheduleFlush(0);
  } catch {
    const failedIds = new Set(ready.map((event) => event.eventId));
    const updated = readQueue().map((event) => {
      if (!failedIds.has(event.eventId)) return event;
      const attempts = Math.min(event.attempts + 1, 16);
      return {
        ...event,
        attempts,
        nextAttemptAt: Date.now() + Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** (attempts - 1)),
      };
    });
    writeBoundedQueue(updated);
    scheduleFlush(Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(ready[0].attempts, 6)));
  } finally {
    flushing = false;
  }
}

function sanitizeProperties(properties: Record<string, unknown>): Record<string, AnalyticsPrimitive> {
  const result: Record<string, AnalyticsPrimitive> = {};
  for (const [key, value] of Object.entries(properties).slice(0, MAX_PROPERTY_COUNT)) {
    if (!/^[a-z][a-zA-Z0-9_]{0,39}$/.test(key) || FORBIDDEN_KEY.test(key) || /Id$/.test(key)) continue;
    if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
    if (typeof value === 'string') {
      if (value.length > 80 || URL_VALUE.test(value)) continue;
      result[key] = value;
    } else if (typeof value === 'number') {
      if (Number.isFinite(value)) result[key] = value;
    } else {
      result[key] = value as boolean;
    }
  }
  return result;
}

function readQueue(): QueuedEvent[] {
  try {
    const value = wx.getStorageSync(QUEUE_KEY);
    return Array.isArray(value) ? value.filter(isQueuedEvent) : [];
  } catch {
    return [];
  }
}

function writeBoundedQueue(events: QueuedEvent[]): void {
  const queue = events.slice(-MAX_EVENTS);
  while (queue.length > 0 && utf8ByteLength(JSON.stringify(queue)) > MAX_QUEUE_BYTES) queue.shift();
  wx.setStorageSync(QUEUE_KEY, queue);
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function scheduleFlush(delayMs: number): void {
  if (!consented || !uploader) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushTracking();
  }, delayMs);
}

function deviceType(): string {
  try {
    const info = wx.getSystemInfoSync();
    return String(info.platform || 'unknown').slice(0, 24);
  } catch {
    return 'unknown';
  }
}

function isQueuedEvent(value: unknown): value is QueuedEvent {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<QueuedEvent>;
  return typeof candidate.eventId === 'string'
    && typeof candidate.eventName === 'string'
    && typeof candidate.occurredAt === 'string'
    && typeof candidate.attempts === 'number'
    && typeof candidate.nextAttemptAt === 'number'
    && candidate.properties !== null
    && typeof candidate.properties === 'object';
}
