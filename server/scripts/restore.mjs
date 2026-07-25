import 'dotenv/config';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).map((item) => {
  const [key, ...value] = item.replace(/^--/, '').split('=');
  return [key, value.join('=') || 'true'];
}));
if (!args.backup || !args.sha256 || args.environment !== 'restore') {
  throw new Error('Usage: npm run db:restore -- --environment=restore --backup=<file.sql> --sha256=<expected>');
}
const backup = resolve(args.backup);
if (!existsSync(backup)) throw new Error(`Backup does not exist: ${backup}`);
const actualHash = await hashFile(backup);
if (actualHash !== args.sha256) throw new Error(`Backup checksum mismatch: expected ${args.sha256}, received ${actualHash}`);

const database = process.env.RESTORE_MYSQL_DATABASE;
const address = parseAddress(process.env.RESTORE_MYSQL_ADDRESS);
const username = process.env.RESTORE_MYSQL_USERNAME;
const password = process.env.RESTORE_MYSQL_PASSWORD;
if (!database || !address.host || !username || password === undefined) {
  throw new Error('RESTORE_MYSQL_ADDRESS/USERNAME/PASSWORD/DATABASE are required and must point to an isolated database');
}
if (database === (process.env.MYSQL_DATABASE ?? process.env.DB_NAME)) {
  throw new Error('Restore database must differ from the application database');
}

const mysql = spawn('mysql', [
  '--default-character-set=utf8mb4', '-h', address.host, '-P', String(address.port), '-u', username, database,
], { env: { ...process.env, MYSQL_PWD: password }, stdio: ['pipe', 'inherit', 'pipe'] });
createReadStream(backup).pipe(mysql.stdin);
let stderr = '';
mysql.stderr.on('data', (chunk) => { stderr += String(chunk).slice(0, 2_000); });
const exitCode = await new Promise((resolveCode, reject) => {
  mysql.once('error', reject);
  mysql.once('close', resolveCode);
});
if (exitCode !== 0) throw new Error(`mysql restore failed (${exitCode}): ${stderr.trim()}`);
process.stdout.write(`${JSON.stringify({ restored: backup, sha256: actualHash, database })}\n`);

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
