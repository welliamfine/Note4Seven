import { beforeEach, describe, expect, it } from 'vitest';
import { getCurrentUser, getModule } from '../src/services/api';
import { readDatabase, resetDatabase } from '../src/services/database';
import { removeModuleWithConfirmation } from '../src/utils/module-removal';

const storage = new Map<string, unknown>();
let modalDecisions: boolean[] = [];
let actionDecisions: number[] = [];

Object.assign(globalThis, {
  wx: {
    getStorageSync(key: string) { return storage.get(key); },
    setStorageSync(key: string, value: unknown) { storage.set(key, value); },
    showModal(options: { success?: (result: { confirm: boolean; cancel: boolean }) => void }) {
      const confirm = modalDecisions.shift() ?? false;
      options.success?.({ confirm, cancel: !confirm });
    },
    showActionSheet(options: { success?: (result: { tapIndex: number }) => void; fail?: () => void }) {
      const tapIndex = actionDecisions.shift();
      if (tapIndex === undefined) options.fail?.();
      else options.success?.({ tapIndex });
    },
  },
});

describe('module removal flow', () => {
  beforeEach(() => {
    storage.clear();
    resetDatabase();
    modalDecisions = [];
    actionDecisions = [];
  });

  it('deletes a solo creator module after the yes/no confirmation', async () => {
    const [module, currentUser] = await Promise.all([getModule('module_coffee'), getCurrentUser()]);
    modalDecisions = [true];
    await expect(removeModuleWithConfirmation(module, currentUser.userId)).resolves.toBe('deleted');
    await expect(getModule(module.moduleId)).rejects.toThrow('MODULE_PENDING_DELETE');
  });

  it('lets a shared creator dissolve the module without entering its name', async () => {
    const [module, currentUser] = await Promise.all([getModule('module_weekend'), getCurrentUser()]);
    actionDecisions = [0];
    modalDecisions = [true];
    await expect(removeModuleWithConfirmation(module, currentUser.userId)).resolves.toBe('deleted');
    expect(readDatabase().modules.find((item) => item.moduleId === module.moduleId)?.status).toBe('pending_delete');
  });

  it('transfers a shared creator module and then exits', async () => {
    const [module, currentUser] = await Promise.all([getModule('module_weekend'), getCurrentUser()]);
    const target = module.members.find((member) => member.userId !== currentUser.userId);
    actionDecisions = [1, 0];
    modalDecisions = [true];
    await expect(removeModuleWithConfirmation(module, currentUser.userId)).resolves.toBe('left');
    expect(readDatabase().modules.find((item) => item.moduleId === module.moduleId)?.creatorUserId).toBe(target?.userId);
    await expect(getModule(module.moduleId)).rejects.toThrow('MODULE_ACCESS_DENIED');
  });
});
