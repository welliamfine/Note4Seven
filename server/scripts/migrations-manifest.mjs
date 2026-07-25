import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const migrations = join(root, 'migrations');
const output = join(migrations, 'manifest.json');
const files = (await readdir(migrations)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
const entries = [];
for (const file of files) {
  const body = await readFile(join(migrations, file));
  entries.push({ file, sha256: createHash('sha256').update(body).digest('hex') });
}
const serialized = `${JSON.stringify({ schemaVersion: 1, mysqlCompatibility: '5.7', migrations: entries }, null, 2)}\n`;

if (process.argv.includes('--write')) {
  await writeFile(output, serialized);
  console.log(`[migrations] wrote ${entries.length} checksums`);
} else if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== serialized) {
    console.error('Migration manifest does not match SQL files. Applied migrations are immutable; add a new migration or explicitly update the manifest for an unapplied change.');
    process.exitCode = 1;
  } else {
    console.log(`[migrations] ${entries.length} immutable checksums match`);
  }
} else {
  process.stdout.write(serialized);
}
