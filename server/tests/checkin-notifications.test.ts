import { describe, expect, it, vi } from 'vitest';
import {
  checkinNotificationData,
  queueCheckinNotifications,
} from '../src/services/checkin-notifications';

describe('check-in subscription notifications', () => {
  it('formats template values within WeChat limits', () => {
    const data = checkinNotificationData(
      '这是一个非常非常长的成员名字',
      '超'.repeat(25),
      '19:08',
      { thing: 'thing1', time: 'time2', note: 'thing3' },
    );

    expect(data.time2.value).toBe('19:08');
    expect(data.thing1.value).toHaveLength(20);
    expect([...data.thing3.value]).toHaveLength(20);
    expect(data.thing3.value).toBe('这是一个非常刚刚发布了新内容，快来看看吧');
  });

  it('queues only subscriptions whose credit was atomically reserved', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[
        { reminder_id: '11', user_id: '21' },
        { reminder_id: '12', user_id: '22' },
      ], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]);

    const queued = await queueCheckinNotifications(
      { execute } as unknown as Parameters<typeof queueCheckinNotifications>[0],
      '31',
      '41',
      '51',
    );

    expect(queued).toBe(1);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(execute.mock.calls[0][1]).toEqual(['41', '51']);
    expect(execute.mock.calls[2][1]).toEqual(['31', '11', '21']);
  });
});
