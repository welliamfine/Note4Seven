import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';
import type { AppConfig } from '../config';

export function createDatabasePool(config: AppConfig): Pool {
  return mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    connectionLimit: config.mysql.connectionLimit,
    charset: 'utf8mb4',
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: false,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  });
}

export async function inTransaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
