import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import type { AppConfig } from '../config';
import { BEIJING_UTC_OFFSET } from '../lib/time';

const UTC_OFFSET = '+00:00';
const BEIJING_TIME_MIGRATION = '015_convert_database_times_to_beijing.sql';

interface AppliedMigration extends RowDataPacket {
  migration_name: string;
  checksum: string;
}

export async function runMigrations(config: AppConfig): Promise<void> {
  const bootstrap = await mysql.createConnection({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    charset: 'utf8mb4',
    timezone: BEIJING_UTC_OFFSET,
    multipleStatements: true,
  });

  try {
    await bootstrap.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.mysql.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await bootstrap.changeUser({ database: config.mysql.database });
    await bootstrap.query(`SET time_zone = '${UTC_OFFSET}'`);
    await migrateWithLock(bootstrap);
  } finally {
    await bootstrap.end();
  }
}

async function migrateWithLock(connection: Connection): Promise<void> {
  const [[lock]] = await connection.query<RowDataPacket[]>("SELECT GET_LOCK('record_life_schema_migrations', 30) AS acquired");
  if (Number(lock.acquired) !== 1) throw new Error('Could not acquire database migration lock');

  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        migration_name VARCHAR(255) NOT NULL PRIMARY KEY,
        checksum CHAR(64) NOT NULL,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [rows] = await connection.query<AppliedMigration[]>('SELECT migration_name, checksum FROM schema_migration');
    const applied = new Map(rows.map((row) => [row.migration_name, row.checksum]));
    if (applied.has(BEIJING_TIME_MIGRATION)) {
      await connection.query(`SET time_zone = '${BEIJING_UTC_OFFSET}'`);
    }
    const migrationsPath = resolve(process.cwd(), 'migrations');
    const files = (await readdir(migrationsPath)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();

    for (const file of files) {
      const sql = await readFile(resolve(migrationsPath, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.get(file);
      if (previous && previous !== checksum) throw new Error(`Applied migration changed: ${file}`);
      if (previous) continue;

      await connection.beginTransaction();
      try {
        await connection.query(sql);
        await connection.execute('INSERT INTO schema_migration (migration_name, checksum) VALUES (?, ?)', [file, checksum]);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    }
  } finally {
    await connection.query("SELECT RELEASE_LOCK('record_life_schema_migrations')");
  }
}
