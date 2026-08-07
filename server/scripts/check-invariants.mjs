import 'dotenv/config';
import mysql from 'mysql2/promise';

const connection = await mysql.createConnection(databaseConfig(process.env));
await connection.query("SET time_zone = '+08:00'");
const checks = [
  {
    name: 'module_active_member_count',
    sql: `SELECT COUNT(*) AS violations FROM life_module m
      WHERE m.active_member_count <> (
        SELECT COUNT(*) FROM module_member mm WHERE mm.module_id = m.module_id AND mm.status = 'active'
      )`,
  },
  {
    name: 'module_single_active_creator',
    sql: `SELECT COUNT(*) AS violations FROM life_module m
      WHERE m.status <> 'deleted' AND 1 <> (
        SELECT COUNT(*) FROM module_member mm
         WHERE mm.module_id = m.module_id AND mm.status = 'active' AND mm.role = 'creator'
      )`,
  },
  {
    name: 'module_record_policy_domain',
    sql: `SELECT COUNT(*) AS violations FROM life_module
      WHERE record_policy NOT IN ('strict','relaxed')`,
  },
  {
    name: 'media_status_domain',
    sql: `SELECT COUNT(*) AS violations FROM media_asset
      WHERE status NOT IN ('created','uploading','uploaded','processing','ready','failed','abandoned')
         OR cutout_status NOT IN ('not_started','queued','processing','succeeded','failed')
         OR content_check_status NOT IN ('not_started','queued','processing','passed','rejected','failed')`,
  },
  {
    name: 'record_status_domain',
    sql: `SELECT COUNT(*) AS violations FROM life_record
      WHERE status NOT IN ('pending','effective','rejected','expired','deleted')`,
  },
  {
    name: 'ready_media_has_outputs',
    sql: `SELECT COUNT(*) AS violations FROM media_asset
      WHERE status = 'ready' AND (sticker_file_key IS NULL OR sticker_thumbnail_file_key IS NULL OR ready_at IS NULL)`,
  },
];

let failures = 0;
try {
  for (const check of checks) {
    const [rows] = await connection.query(check.sql);
    const violations = Number(rows[0]?.violations ?? 0);
    console.log(`[invariant] ${check.name}: ${violations}`);
    if (violations > 0) failures += 1;
  }
} finally {
  await connection.end();
}
if (failures > 0) process.exitCode = 1;

function databaseConfig(environment) {
  const address = environment.MYSQL_ADDRESS ?? environment.DB_HOST;
  const [host, addressPort] = String(address ?? '').split(':');
  const user = environment.MYSQL_USERNAME ?? environment.DB_USER;
  const password = environment.MYSQL_PASSWORD ?? environment.DB_PASSWORD;
  const database = environment.MYSQL_DATABASE ?? environment.DB_NAME;
  if (!host || !user || password === undefined || !database) throw new Error('Database environment is incomplete');
  return {
    host,
    port: Number(environment.MYSQL_PORT ?? environment.DB_PORT ?? addressPort ?? 3306),
    user,
    password,
    database,
    charset: 'utf8mb4',
    timezone: '+08:00',
  };
}
