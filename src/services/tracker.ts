const TRACKING_KEY = 'notemylife.alpha.events.v1';

export function track(eventName: string, properties: Record<string, unknown> = {}): void {
  const event = {
    eventId: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
    eventName,
    documentBaseline: 'prd_6.4',
    timestamp: Date.now(),
    ...properties,
  };

  try {
    const events = (wx.getStorageSync(TRACKING_KEY) as unknown[]) || [];
    wx.setStorageSync(TRACKING_KEY, [...events.slice(-199), event]);
  } catch {
    // Tracking must never interrupt the recording flow.
  }
}
