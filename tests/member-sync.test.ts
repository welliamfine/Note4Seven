import { describe, expect, it } from 'vitest';
import type { ModuleMember } from '../src/types/domain';
import { mergeMemberSnapshot } from '../src/utils/member-sync';

const member = (id: string, avatarUrl: string): ModuleMember => ({
  memberInstanceId: id,
  userId: `user_${id}`,
  nickname: id,
  avatarText: id.slice(0, 1),
  avatarColor: '#eee',
  avatarUrl,
  role: id === 'member_1' ? 'creator' : 'member',
  joinSequence: Number(id.slice(-1)),
  joinedAt: '2026-07-01T00:00:00+08:00',
  active: true,
});

describe('member snapshot merge', () => {
  it('removes an exited member without replacing an unchanged signed avatar', () => {
    const current = [
      member('member_1', 'https://media.test/one.png?signature=old'),
      member('member_2', 'https://media.test/two.png?signature=old'),
    ];
    const plan = mergeMemberSnapshot(current, [
      member('member_1', 'https://media.test/one.png?signature=new'),
    ]);

    expect(plan.changed).toBe(true);
    expect(plan.members).toHaveLength(1);
    expect(plan.members[0]).toBe(current[0]);
    expect(plan.avatarSources).toEqual([]);
  });
});
