// src/db/index.js — PostgreSQL connection pool
const { Pool } = require('pg');
const logger = require('../services/logger');

let pool;

function getPool() {
  if (pool) return pool;

  // Support both DATABASE_URL (Railway/Render/Supabase) and individual vars
  const config = process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production'
          ? { rejectUnauthorized: false }  // required by most cloud Postgres providers
          : false,
        max: 20,                 // max connections in pool
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      }
    : {
        host:     process.env.DB_HOST     || 'localhost',
        port:     parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME     || 'propati_db',
        user:     process.env.DB_USER     || 'postgres',
        password: process.env.DB_PASSWORD || '',
        ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      };

  pool = new Pool(config);

  pool.on('connect', () => {
    logger.debug('New PostgreSQL client connected');
  });

  pool.on('error', (err) => {
    logger.error('Unexpected PostgreSQL pool error', { error: err.message });
  });

  return pool;
}

// ── Query helper — logs slow queries (>500ms) ──────────────
async function query(sql, params = []) {
  const start = Date.now();
  const client = getPool();
  try {
    const result = await client.query(sql, params);
    const duration = Date.now() - start;
    if (duration > 500) {
      logger.warn('Slow query detected', { duration, sql: sql.slice(0, 100) });
    }
    return result;
  } catch (err) {
    logger.error('Database query error', { error: err.message, sql: sql.slice(0, 100) });
    throw err;
  }
}

// ── Transaction helper ─────────────────────────────────────
async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Transaction rolled back', { error: err.message });
    throw err;
  } finally {
    client.release();
  }
}

// ── Health check ───────────────────────────────────────────
async function checkConnection() {
  try {
    const result = await query('SELECT NOW() as time');
    logger.info('✅ PostgreSQL connected', { time: result.rows[0].time });
    return true;
  } catch (err) {
    logger.error('❌ PostgreSQL connection failed', { error: err.message });
    return false;
  }
}

module.exports = { getPool, query, transaction, checkConnection };
