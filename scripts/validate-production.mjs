import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = process.cwd();
const dist = join(root, 'dist');
const targetArgument = process.argv.find((item) => item.startsWith('--target-environment='));
const targetEnvironment = targetArgument?.slice('--target-environment='.length) ?? 'production';
if (!['staging', 'production'].includes(targetEnvironment)) {
  throw new Error('Use --target-environment=staging or --target-environment=production');
}
const targetLabel = targetEnvironment === 'production' ? 'Production' : 'Staging';

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    files.push(...(entry.isDirectory() ? await walk(path) : [path]));
  }
  return files;
}

const files = await walk(dist);
const failures = [];
const paths = new Set(files.map((file) => relative(dist, file).replaceAll('\\', '/')));
const forbiddenArtifacts = ['services/database.js', 'services/local-api.js'];
const forbiddenAssets = [
  'assets/fonts/huiwen-mincho-data.js',
  'assets/fonts/huiwen-mincho-data.d.ts',
  'assets/stickers/group-12.png',
  'assets/stickers/group-13.png',
  'assets/stickers/group-14.png',
  'assets/stickers/group-15.png',
];
const forbiddenText = ['体验版', '本地适配器', '演示用户', '演示记录', '重置演示', '退出登录'];
const searchableExtensions = new Set(['.js', '.json', '.wxml', '.wxss']);
const MAX_TOTAL_BYTES = 900 * 1024;
const MAX_MAIN_PACKAGE_BYTES = 650 * 1024;
const MAX_FEATURE_PACKAGE_BYTES = 300 * 1024;
const MAX_SINGLE_FILE_BYTES = 250 * 1024;

const fileMetadata = new Map(await Promise.all(files.map(async (file) => [file, await stat(file)])));
const totalBytes = [...fileMetadata.values()]
  .reduce((sum, item) => sum + item.size, 0);
if (totalBytes > MAX_TOTAL_BYTES) {
  failures.push(`${targetLabel} bundle is ${totalBytes} bytes; budget is ${MAX_TOTAL_BYTES} bytes`);
}
const mainPackageBytes = [...fileMetadata.entries()]
  .filter(([file]) => !relative(dist, file).replaceAll('\\', '/').startsWith('subpackages/'))
  .reduce((sum, [, item]) => sum + item.size, 0);
const featurePackageBytes = totalBytes - mainPackageBytes;
if (mainPackageBytes > MAX_MAIN_PACKAGE_BYTES) failures.push(`Main package is ${mainPackageBytes} bytes; budget is ${MAX_MAIN_PACKAGE_BYTES} bytes`);
if (featurePackageBytes > MAX_FEATURE_PACKAGE_BYTES) failures.push(`Feature package is ${featurePackageBytes} bytes; budget is ${MAX_FEATURE_PACKAGE_BYTES} bytes`);
for (const file of files) {
  const metadata = fileMetadata.get(file);
  if (!metadata) continue;
  if (metadata.size > MAX_SINGLE_FILE_BYTES) {
    failures.push(`${targetLabel} asset exceeds ${MAX_SINGLE_FILE_BYTES} bytes: ${relative(dist, file)} (${metadata.size})`);
  }
}

for (const artifact of forbiddenArtifacts) {
  if (paths.has(artifact)) failures.push(`${targetLabel} bundle contains local-only artifact: ${artifact}`);
}
for (const asset of forbiddenAssets) {
  if (paths.has(asset)) failures.push(`${targetLabel} bundle contains local-only or unused asset: ${asset}`);
}

const buildMetadata = JSON.parse(await readFile(join(dist, 'build-meta.json'), 'utf8'));
if (buildMetadata.apiMode !== 'remote' || buildMetadata.targetEnvironment !== targetEnvironment) {
  failures.push(`${targetLabel} bundle build-meta.json does not identify a remote ${targetEnvironment} build`);
}
if (!buildMetadata.releaseId || buildMetadata.releaseId === 'development') {
  failures.push(`${targetLabel} bundle is missing a release ID`);
}

for (const file of files) {
  const relativePath = relative(dist, file).replaceAll('\\', '/');
  if (extname(file) === '.map') failures.push(`Production bundle contains source map: ${relativePath}`);
  if (!searchableExtensions.has(extname(file))) continue;
  const contents = await readFile(file, 'utf8');
  for (const phrase of forbiddenText) {
    if (contents.includes(phrase)) failures.push(`Production bundle contains forbidden text "${phrase}" in ${relativePath}`);
  }
}

const app = JSON.parse(await readFile(join(dist, 'app.json'), 'utf8'));
const allPages = [
  ...app.pages,
  ...(app.subPackages ?? []).flatMap((subpackage) => subpackage.pages.map((page) => `${subpackage.root}/${page}`)),
];
for (const page of allPages) {
  const template = await readFile(join(dist, `${page}.wxml`), 'utf8');
  if (!template.includes('<privacy-dialog />')) failures.push(`Privacy authorization dialog is missing from ${page}`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`Validated ${targetEnvironment} isolation and budgets (main=${mainPackageBytes}, features=${featurePackageBytes}, total=${totalBytes}) across ${files.length} artifacts.`);
