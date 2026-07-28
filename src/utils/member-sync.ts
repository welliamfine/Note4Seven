import type { ModuleMember } from '../types/domain';
import { imageSourceIdentity } from './image-preload';

export interface MemberSyncPlan {
  members: ModuleMember[];
  avatarSources: string[];
  changed: boolean;
}

const sameMember = (left: ModuleMember, right: ModuleMember): boolean => (
  left.memberInstanceId === right.memberInstanceId
  && left.userId === right.userId
  && left.nickname === right.nickname
  && left.avatarText === right.avatarText
  && left.avatarColor === right.avatarColor
  && imageSourceIdentity(left.avatarUrl ?? '') === imageSourceIdentity(right.avatarUrl ?? '')
  && left.role === right.role
  && left.joinSequence === right.joinSequence
  && left.joinedAt === right.joinedAt
  && left.active === right.active
);

export function mergeMemberSnapshot(current: ModuleMember[], incoming: ModuleMember[]): MemberSyncPlan {
  const avatarSources: string[] = [];
  const members = incoming.map((member) => {
    const existing = current.find((candidate) => candidate.memberInstanceId === member.memberInstanceId);
    if (existing && sameMember(existing, member)) return existing;
    if (member.avatarUrl) avatarSources.push(member.avatarUrl);
    return member;
  });
  return {
    members,
    avatarSources,
    changed: members.length !== current.length || members.some((member, index) => member !== current[index]),
  };
}
