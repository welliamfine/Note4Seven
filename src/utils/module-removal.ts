import type { LifeModule } from '../types/domain';
import {
  deleteModuleToRecycle,
  removeModuleForCurrentUser,
  transferModuleCreator,
} from '../services/api';

export type ModuleRemovalResult = 'cancelled' | 'deleted' | 'left';

interface ModuleRemovalOptions {
  simpleRemovalConfirmed?: boolean;
}

export const isSharedModuleCreator = (module: LifeModule, currentUserId: string): boolean => {
  const currentMember = module.members.find((member) => member.userId === currentUserId);
  return currentMember?.role === 'creator' && module.members.length > 1;
};

export async function removeModuleWithConfirmation(
  module: LifeModule,
  currentUserId: string,
  options: ModuleRemovalOptions = {},
): Promise<ModuleRemovalResult> {
  const currentMember = module.members.find((member) => member.userId === currentUserId);
  if (!currentMember) throw new Error('MODULE_ACCESS_DENIED');

  if (isSharedModuleCreator(module, currentUserId)) {
    return removeSharedCreatorModule(module, currentUserId, options.simpleRemovalConfirmed === true);
  }

  if (!options.simpleRemovalConfirmed && !(await confirmDelete())) return 'cancelled';
  if (currentMember.role === 'creator') {
    await deleteModuleToRecycle(module.moduleId, module.name);
    return 'deleted';
  }
  await removeModuleForCurrentUser(module.moduleId);
  return 'left';
}

export function confirmDelete(): Promise<boolean> {
  return new Promise((resolve) => {
    wx.showModal({
      title: '确认删除？',
      content: '',
      confirmText: '是',
      cancelText: '否',
      confirmColor: '#F65451',
      success: ({ confirm }) => resolve(confirm),
      fail: () => resolve(false),
    });
  });
}

async function removeSharedCreatorModule(
  module: LifeModule,
  currentUserId: string,
  removalConfirmed: boolean,
): Promise<ModuleRemovalResult> {
  const choice = await chooseAction(['解散模块', '转让创建者后退出']);
  if (choice === undefined) return 'cancelled';

  if (choice === 0) {
    if (!removalConfirmed && !(await confirmDelete())) return 'cancelled';
    await deleteModuleToRecycle(module.moduleId, module.name);
    return 'deleted';
  }

  const candidates = module.members.filter((member) => member.userId !== currentUserId);
  if (!candidates.length) throw new Error('TRANSFER_TARGET_REQUIRED');
  const targetIndex = await chooseAction(candidates.map((member) => member.nickname));
  if (targetIndex === undefined) return 'cancelled';
  const target = candidates[targetIndex];
  if (!target) return 'cancelled';
  if (!(await confirmTransfer(target.nickname))) return 'cancelled';
  await transferModuleCreator(module.moduleId, target.memberInstanceId);
  await removeModuleForCurrentUser(module.moduleId);
  return 'left';
}

function chooseAction(itemList: string[]): Promise<number | undefined> {
  return new Promise((resolve) => {
    wx.showActionSheet({
      itemList,
      success: ({ tapIndex }) => resolve(tapIndex),
      fail: () => resolve(undefined),
    });
  });
}

function confirmTransfer(nickname: string): Promise<boolean> {
  return new Promise((resolve) => {
    wx.showModal({
      title: '确认转让并退出？',
      content: `将创建者转让给${nickname}后，你会退出该模块。`,
      confirmText: '是',
      cancelText: '否',
      success: ({ confirm }) => resolve(confirm),
      fail: () => resolve(false),
    });
  });
}
