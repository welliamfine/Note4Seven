import type { PoolConnection } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { syncProfileReferences, trustedOpenId } from '../src/routes/auth';

const config = loadConfig({
  MYSQL_ADDRESS: 'db.internal:3306',
  MYSQL_USERNAME: 'app',
  MYSQL_PASSWORD: 'secret',
});

describe('trustedOpenId', () => {
  it('accepts the complete identity injected for a real-device call', () => {
    expect(trustedOpenId({
      'x-wx-openid': 'openid-1',
      'x-wx-appid': config.appId,
      'x-wx-env': config.cloudEnvId,
      'x-wx-source': 'other',
      'x-authmethod': 'WX_SERVER_AUTH',
    }, config)).toBe('openid-1');
  });

  it('accepts calls from WeChat Developer Tools', () => {
    expect(trustedOpenId({
      'x-wx-openid': 'openid-2',
      'x-wx-appid': config.appId,
      'x-wx-env': config.cloudEnvId,
      'x-wx-source': 'wx_devtools',
      'x-authmethod': 'WX_SERVER_AUTH',
    }, config)).toBe('openid-2');
  });

  it('rejects incomplete or cross-environment identity headers', () => {
    expect(() => trustedOpenId({
      'x-wx-openid': 'forged-openid',
      'x-wx-appid': config.appId,
      'x-wx-env': config.cloudEnvId,
      'x-wx-source': 'wx_client',
    }, config)).toThrow('请从微信小程序进入');
    expect(() => trustedOpenId({
      'x-wx-openid': 'forged-openid',
      'x-wx-appid': config.appId,
      'x-wx-env': 'other-environment',
      'x-wx-source': 'wx_client',
      'x-authmethod': 'WX_SERVER_AUTH',
    }, config)).toThrow('请从微信小程序进入');
  });
});

describe('profile identity propagation', () => {
  it('updates every visible name and avatar source while preserving anonymized memberships', async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
    const connection = { execute } as unknown as Pick<PoolConnection, 'execute'>;

    await syncProfileReferences(connection, '42', '小七', 'avatars/42/latest.webp');

    expect(execute).toHaveBeenCalledTimes(4);
    const statements = execute.mock.calls.map(([statement]) => String(statement).replace(/\s+/g, ' ').trim());
    expect(statements[0]).toContain('UPDATE module_member');
    expect(statements[0]).toContain('nickname_snapshot = ?');
    expect(statements[1]).toContain('UPDATE life_record r');
    expect(statements[1]).toContain('display_name_snapshot = ?');
    expect(statements[2]).toContain('UPDATE reaction re');
    expect(statements[2]).toContain('reactor_name_snapshot = ?');
    expect(statements[3]).toContain('UPDATE join_application');
    expect(statements[3]).toContain('applicant_name_snapshot = ?');
    expect(statements.slice(0, 3).every((statement) => statement.includes("status = 'active'"))).toBe(true);
    expect(execute.mock.calls.every(([, parameters]) => (
      JSON.stringify(parameters) === JSON.stringify(['小七', 'avatars/42/latest.webp', '42'])
    ))).toBe(true);
  });
});
