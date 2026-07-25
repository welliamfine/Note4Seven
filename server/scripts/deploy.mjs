import { spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = fileURLToPath(new URL('..', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));
const environmentName = argument('environment');
const releaseId = argument('release-id');
if (!['staging', 'production'].includes(environmentName)) throw new Error('Pass --environment=staging or --environment=production.');
if (!releaseId) throw new Error('Pass the approved --release-id.');
const environments = JSON.parse(await readFile(join(root, 'config', 'environments.json'), 'utf8'));
const target = environments[environmentName];
for (const field of ['cloudEnvironmentId', 'cloudService']) {
  if (!target?.[field] || String(target[field]).startsWith('TO_BE_')) throw new Error(`${environmentName}.${field} is not configured.`);
}
await access(join(root, 'artifacts', releaseId, 'release-manifest.json'));
if (environmentName === 'production' && argument('confirm-production') !== releaseId) {
  throw new Error(`Production requires --confirm-production=${releaseId} after backup and rollback approval.`);
}

const args = [
  '--yes', '--package=@cloudbase/cli@3.6.4', 'tcb',
  '-e', target.cloudEnvironmentId,
  'cloudrun', 'deploy',
  '--serviceName', target.cloudService,
  '--port', '8080',
  '--source', '.',
  '--force',
];
console.log(`[deploy] environment=${environmentName} service=${target.cloudService} release=${releaseId}`);
if (!process.argv.includes('--execute')) {
  console.log('[deploy] dry run only; add --execute after the approval checklist is complete');
  process.exit(0);
}
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(npx, args, {
  cwd: serverRoot,
  stdio: 'inherit',
  env: { ...process.env, RELEASE_ID: releaseId, APP_ENV: environmentName, AUTO_MIGRATE: 'false' },
});
process.exit(result.status ?? 1);

function argument(name) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}
