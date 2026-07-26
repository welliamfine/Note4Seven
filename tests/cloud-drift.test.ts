import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runDriftCheck(environment: 'staging' | 'production', actual: object) {
  const directory = mkdtempSync(join(tmpdir(), 'note4seven-cloud-drift-'));
  temporaryDirectories.push(directory);
  const actualPath = join(directory, 'actual.json');
  writeFileSync(actualPath, `${JSON.stringify(actual)}\n`);
  return spawnSync(process.execPath, [
    'scripts/check-cloud-drift.mjs',
    `--environment=${environment}`,
    `--actual=${actualPath}`,
  ], { cwd: process.cwd(), encoding: 'utf8' });
}

const productionCapture = {
  schemaVersion: 2,
  capturedAt: '2026-07-26T00:00:00Z',
  capturedBy: 'automated-test',
  staging: { status: 'TO_BE_CONFIGURED' },
  production: {
    status: 'configured',
    appId: 'wxa64faf2abab7e388',
    cloudEnvironmentId: 'prod-d5g4tznceeecbaf39',
    service: 'express-bonj',
    serviceStatus: 'normal',
    bucket: '7072-prod-d5g4tznceeecbaf39-1346314817',
    region: 'ap-shanghai',
    storageAcl: 'private',
    database: 'record_life',
    databaseStatus: 'available',
    databaseEngine: 'mysql',
    databaseCompatibility: '5.7',
    minimumInstances: 1,
    healthPath: '/health',
    storageTriggerStatus: 'disabled',
  },
};

describe('cloud configuration drift gate', () => {
  it('accepts a captured production environment that matches the baseline', () => {
    const result = runDriftCheck('production', productionCapture);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('production configuration matches');
  });

  it('blocks staging while its independent baseline is not configured', () => {
    const result = runDriftCheck('staging', productionCapture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('staging: expected baseline is not configured');
  });

  it('blocks a production capture that differs from the expected service', () => {
    const actual = structuredClone(productionCapture);
    actual.production.service = 'unexpected-service';
    const result = runDriftCheck('production', actual);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('production.service');
  });
});
