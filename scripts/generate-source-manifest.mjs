import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const baselineName = process.argv[2] ?? 'baseline-2026-07-25';
if (!/^[a-z0-9][a-z0-9._-]+$/i.test(baselineName)) {
  throw new Error('Baseline name may contain only letters, numbers, dots, underscores, and hyphens.');
}
const outputDirectory = join(root, 'docs', 'baselines');
const output = join(outputDirectory, `${baselineName}.sha256`);
const tracked = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter((file) => file && !file.startsWith('docs/baselines/'))
  .sort();

const lines = [];
for (const file of tracked) {
  const body = await readFile(join(root, file));
  lines.push(`${createHash('sha256').update(body).digest('hex')}  ${file}`);
}
await mkdir(outputDirectory, { recursive: true });
await writeFile(output, `${lines.join('\n')}\n`);
console.log(`[baseline] wrote ${lines.length} source checksums to ${output}`);
