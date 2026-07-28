import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  remoteRequest: vi.fn(async () => ({})),
}));

vi.mock('../src/services/transport-client', () => ({
  remoteRequest: transport.remoteRequest,
  uploadBackendFile: vi.fn(),
}));

import { deleteModuleToRecycle } from '../src/services/remote-api';

describe('remote module deletion', () => {
  beforeEach(() => transport.remoteRequest.mockClear());

  it('sends the module name for compatibility with deployed deletion endpoints', async () => {
    await deleteModuleToRecycle('module_weekend', '美食check！');

    expect(transport.remoteRequest).toHaveBeenCalledWith('/modules/module_weekend/delete', {
      method: 'POST',
      data: {
        confirmationName: '美食check！',
        clientRequestId: expect.stringMatching(/^module_delete_/),
      },
    });
  });
});
