import 'dotenv/config';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, statfsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { beijingIso } from '../../scripts/lib/time.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((item) => {
  const [key, ...value] = item.replace(/^--/, '').split('=');
  return [key, value.join('=') || 'true'];
}));
const environment = args.environment;
if (!['development', 'staging', 'production'].includes(environment)) {
  throw new Error('Usage: npm run db:backup -- --environment=<development|staging|production> [--release=<id>]');
}
const database = process.env.MIGRATION_MYSQL_DATABASE ?? process.env.MYSQL_DATABASE ?? process.env.DB_NAME ?? 'record_life';
const address = parseAddress(process.env.MIGRATION_MYSQL_ADDRESS ?? process.env.MYSQL_ADDRESS ?? process.env.DB_HOST);
const username = process.env.MIGRATION_MYSQL_USERNAME ?? process.env.MYSQL_USERNAME ?? process.env.DB_USER;
const password = process.env.MIGRATION_MYSQL_PASSWORD ?? process.env.MYSQL_PASSWORD ?? process.env.DB_PASSWORD;
if (!address.host || !username || password === undefined) throw new Error('Migration/backup database credentials are incomplete');

const outputDirectory = resolve(args['output-dir'] ?? '../backups');
mkdirSync(outputDirectory, { recursive: true });
const freeBytes = Number(statfsSync(outputDirectory).bavail) * Number(statfsSync(outputDirectory).bsize);
if (freeBytes < 512 * 1024 * 1024) throw new Error('Backup aborted: less than 512 MiB free space');
const timestamp = beijingIso().replace(/[:.]/g, '-');
const release = String(args.release ?? process.env.RELEASE_ID ?? 'manual').replace(/[^a-zA-Z0-9._+-]/g, '_');
const output = resolve(outputDirectory, `${environment}-${database}-${release}-${timestamp}.sql`);

const dump = spawn('mysqldump', [
  '--single-transaction', '--quick', '--routines', '--triggers', '--events',
  '--default-character-set=utf8mb4', '--hex-blob',
  '-h', address.host, '-P', String(address.port), '-u', username, database,
], { env: { ...process.env, MYSQL_PWD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
const outputStream = createWriteStream(output, { flags: 'wx' });
dump.stdout.pipe(outputStream);
let stderr = '';
dump.stderr.on('data', (chunk) => { stderr += String(chunk).slice(0, 2_000); });
const exitCode = await new Promise((resolveCode, reject) => {
  dump.once('error', reject);
  dump.once('close', resolveCode);
});
await new Promise((resolveWrite, reject) => {
  outputStream.once('close', resolveWrite);
  outputStream.once('error', reject);
});
if (exitCode !== 0) throw new Error(`mysqldump failed (${exitCode}): ${stderr.trim()}`);
const sha256 = await hashFile(output);
process.stdout.write(`${JSON.stringify({ backup: output, file: basename(output), sha256, environment, database, release })}\n`);

function parseAddress(value) {
  if (!value) return { host: '', port: 3306 };
  const index = value.lastIndexOf(':');
  const port = Number(value.slice(index + 1));
  return index > 0 && Number.isInteger(port) ? { host: value.slice(0, index), port } : { host: value, port: 3306 };
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
