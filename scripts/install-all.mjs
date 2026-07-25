import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const projects = [
  { name: 'miniprogram', path: root },
  { name: 'backend', path: fileURLToPath(new URL('../server', import.meta.url)) },
  { name: 'cos-media-trigger', path: fileURLToPath(new URL('../cloudfunctions/cos-media-trigger', import.meta.url)) },
];

for (const project of projects) {
  console.log(`[install] ${project.name}: npm ci`);
  const result = spawnSync(npm, ['ci'], { cwd: project.path, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`[install] ${project.name} failed with exit code ${result.status ?? 'unknown'}`);
    process.exit(result.status ?? 1);
  }
}
console.log('[install] all projects installed from lock files');
