import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../src/observability/metrics';

describe('metrics registry', () => {
  it('renders counters, gauges, and histograms with release labels', () => {
    const metrics = new MetricsRegistry({ environment: 'test', release_id: 'test-release' });
    metrics.increment('api_request_total', { status: 200 });
    metrics.setGauge('outbox_pending_total', 3, { event_type: 'media' });
    metrics.observe('api_duration_seconds', 0.2, { route: '/health' });
    const body = metrics.render();
    expect(body).toContain('api_request_total{environment="test",release_id="test-release",status="200"} 1');
    expect(body).toContain('outbox_pending_total{environment="test",event_type="media",release_id="test-release"} 3');
    expect(body).toContain('api_duration_seconds_count');
  });
});
