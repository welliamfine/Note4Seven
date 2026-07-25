import { copyFile, stat } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const serverDir = join(root, 'server');
const composeFile = join(serverDir, 'docker-compose.dev.yml');
const envFile = join(serverDir, '.env.local');
const envTemplate = join(serverDir, 'env.local.example');

if (!(await exists(envFile))) {
  await copyFile(envTemplate, envFile);
  console.log('Created server/.env.local from the local development template.');
}

console.log('Starting local MySQL...');
const compose = spawnSync('docker', ['compose', '-f', composeFile, 'up', '-d', '--wait'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});
if (compose.status !== 0) process.exit(compose.status ?? 1);

const children = [
  spawn(process.execPath, [join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'watch', 'src/index.ts'], {
    cwd: serverDir,
    env: { ...process.env, DOTENV_CONFIG_PATH: '.env.local' },
    stdio: 'inherit',
    windowsHide: true,
  }),
  spawn(process.execPath, ['scripts/build.mjs', '--api-mode=dev-server', '--watch'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  }),
];

console.log('\nLocal integration mode is running:');
console.log('  API: http://127.0.0.1:8080');
console.log('  Mini program build: dist/ (dev-server mode)');
console.log('  Stop watchers: Ctrl+C');
console.log('  Stop database later: npm run local:down\n');

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = exitCode;
}

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (!stopping && code !== 0) {
      console.error(`Local development process stopped (${signal ?? code}).`);
      stop(code ?? 1);
    }
  });
}
process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
