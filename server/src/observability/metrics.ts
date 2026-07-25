import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors';

type Labels = Record<string, string | number | boolean>;

interface HistogramValue {
  count: number;
  sum: number;
  buckets: number[];
}

const HISTOGRAM_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, HistogramValue>();

  constructor(private readonly defaultLabels: Labels) {}

  increment(name: string, labels: Labels = {}, value = 1): void {
    const key = metricKey(name, { ...this.defaultLabels, ...labels });
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  setGauge(name: string, value: number, labels: Labels = {}): void {
    this.gauges.set(metricKey(name, { ...this.defaultLabels, ...labels }), value);
  }

  observe(name: string, valueSeconds: number, labels: Labels = {}): void {
    const key = metricKey(name, { ...this.defaultLabels, ...labels });
    const histogram = this.histograms.get(key) ?? {
      count: 0,
      sum: 0,
      buckets: HISTOGRAM_BUCKETS.map(() => 0),
    };
    histogram.count += 1;
    histogram.sum += valueSeconds;
    HISTOGRAM_BUCKETS.forEach((upperBound, index) => {
      if (valueSeconds <= upperBound) histogram.buckets[index] += 1;
    });
    this.histograms.set(key, histogram);
  }

  render(): string {
    const lines = [];
    for (const [key, value] of [...this.counters].sort()) lines.push(`${key} ${value}`);
    for (const [key, value] of [...this.gauges].sort()) lines.push(`${key} ${value}`);
    for (const [key, value] of [...this.histograms].sort()) {
      const parsed = parseMetricKey(key);
      value.buckets.forEach((count, index) => {
        lines.push(`${parsed.name}_bucket${formatLabels({ ...parsed.labels, le: HISTOGRAM_BUCKETS[index] })} ${count}`);
      });
      lines.push(`${parsed.name}_bucket${formatLabels({ ...parsed.labels, le: '+Inf' })} ${value.count}`);
      lines.push(`${parsed.name}_sum${formatLabels(parsed.labels)} ${value.sum}`);
      lines.push(`${parsed.name}_count${formatLabels(parsed.labels)} ${value.count}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

export function requestMetrics(metrics: MetricsRegistry) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    response.once('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
      const labels = {
        method: request.method,
        route: normalizeRoute(request.path),
        status: response.statusCode,
      };
      metrics.increment('api_request_total', labels);
      metrics.observe('api_duration_seconds', durationSeconds, { method: request.method, route: labels.route });
    });
    next();
  };
}

export function metricsEndpoint(metrics: MetricsRegistry, token: string | null) {
  return (request: Request, response: Response, next: NextFunction): void => {
    try {
      if (token && !safeEqual(request.header('x-metrics-token') ?? '', token)) {
        throw new AppError('METRICS_UNAUTHORIZED', '指标访问未授权', 401);
      }
      response.type('text/plain; version=0.0.4').send(metrics.render());
    } catch (error) {
      next(error);
    }
  };
}

function normalizeRoute(path: string): string {
  return path
    .replace(/\/(?:mod|rec|med|inv|app|mem|not|item)_\d+/g, '/:publicId')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .replace(/\/public\/invite-scenes\/[^/]+/g, '/public/invite-scenes/:secret');
}

function metricKey(name: string, labels: Labels): string {
  if (!/^[a-z_:][a-z0-9_:]*$/i.test(name)) throw new Error(`Invalid metric name: ${name}`);
  return `${name}${formatLabels(labels)}`;
}

function parseMetricKey(key: string): { name: string; labels: Labels } {
  const index = key.indexOf('{');
  if (index < 0) return { name: key, labels: {} };
  const entries = JSON.parse(key.slice(index).replace(/^\{/, '{"').replace(/=/g, '":').replace(/,([a-z])/g, ',"$1')) as Labels;
  return { name: key.slice(0, index), labels: entries };
}

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return '';
  return `{${entries.map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join(',')}}`;
}

function safeEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(actual).digest(),
    createHash('sha256').update(expected).digest(),
  );
}
