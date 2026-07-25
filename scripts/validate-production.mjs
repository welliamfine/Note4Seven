import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = process.cwd();
const dist = join(root, 'dist');

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
const forbiddenText = ['体验版', '本地适配器', '演示用户', '演示记录', '重置演示', '退出登录'];
const searchableExtensions = new Set(['.js', '.json', '.wxml', '.wxss']);

for (const artifact of forbiddenArtifacts) {
  if (paths.has(artifact)) failures.push(`Production bundle contains local-only artifact: ${artifact}`);
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
for (const page of app.pages) {
  const template = await readFile(join(dist, `${page}.wxml`), 'utf8');
  if (!template.includes('<privacy-dialog />')) failures.push(`Privacy authorization dialog is missing from ${page}`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`Validated production isolation, privacy coverage, and release text across ${files.length} artifacts.`);
