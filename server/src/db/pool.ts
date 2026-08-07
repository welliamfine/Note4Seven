import type { PoolConnection as CallbackPoolConnection } from 'mysql2';
import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';
import type { AppConfig } from '../config';
import { BEIJING_UTC_OFFSET } from '../lib/time';

export function createDatabasePool(config: AppConfig): Pool {
  const pool = mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    connectionLimit: config.mysql.connectionLimit,
    charset: 'utf8mb4',
    timezone: BEIJING_UTC_OFFSET,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: ['DATE'],
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  });
  pool.on('connection', (connection) => {
    const callbackConnection = connection as unknown as CallbackPoolConnection;
    callbackConnection.query(`SET time_zone = '${BEIJING_UTC_OFFSET}'`, (error) => {
      if (error) callbackConnection.destroy();
    });
  });
  return pool;
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
