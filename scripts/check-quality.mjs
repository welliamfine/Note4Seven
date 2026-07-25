import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const roots = ['src', 'tests', 'scripts', 'server/src', 'server/tests', 'server/scripts', 'cloudfunctions/cos-media-trigger'];
const extensions = new Set(['.ts', '.js', '.mjs', '.json', '.sql', '.wxml', '.wxss']);
const failures = [];

for (const directory of roots) {
  for (const file of await walk(join(root, directory))) {
    if (!extensions.has(extname(file)) || file.includes('node_modules') || file.includes('package-lock.json')) continue;
    const source = await readFile(file, 'utf8');
    const name = relative(root, file).replace(/\\/g, '/');
    source.split(/\r?\n/).forEach((line, index) => {
      if (/[ \t]+$/.test(line)) failures.push(`${name}:${index + 1} has trailing whitespace`);
    });
    if (/\b(?:describe|it|test)\.only\s*\(/.test(source)) failures.push(`${name} contains a focused test`);
    if (name.startsWith('server/src/') && /\bconsole\.(?:log|debug)\s*\(/.test(source)) {
      failures.push(`${name} uses console logging instead of the structured logger`);
    }
    if (extname(file) === '.json') {
      try { JSON.parse(source); } catch (error) { failures.push(`${name} is invalid JSON: ${error.message}`); }
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('[quality] source checks passed');
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}
