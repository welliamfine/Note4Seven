import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beijingIso } from './lib/time.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, 'docs', 'governance', 'external-assets.json');
const roots = ['release', 'material', 'typestyle', 'mock_image'];
const explicitFiles = ['docs/打卡小程序原型图 (1).fig'];

async function walk(path) {
  const metadata = await stat(path);
  if (metadata.isFile()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => walk(join(path, entry.name))));
  return nested.flat();
}

const files = [
  ...(await Promise.all(roots.map((path) => walk(join(root, path))))).flat(),
  ...explicitFiles.map((path) => join(root, path)),
].sort();
const assets = [];
for (const path of files) {
  const body = await readFile(path);
  assets.push({
    path: relative(root, path).replace(/\\/g, '/'),
    bytes: body.byteLength,
    sha256: createHash('sha256').update(body).digest('hex'),
  });
}

await mkdir(join(output, '..'), { recursive: true });
await writeFile(output, `${JSON.stringify({
  schemaVersion: 1,
  policy: 'external-controlled-archive',
  generatedAt: beijingIso(),
  storageLocation: 'TO_BE_CONFIGURED_BY_REPOSITORY_ADMIN',
  assets,
}, null, 2)}\n`);
console.log(`[inventory] wrote ${assets.length} entries to ${basename(output)}`);
