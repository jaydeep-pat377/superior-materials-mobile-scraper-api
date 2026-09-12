/**
 * Auth Database Configuration
 *
 * Separate PostgreSQL pool for authentication operations.
 * Uses auth_tenant schema for tenants, users, auth_codes, etc.
 */

const pg = require('pg');
const { Pool } = pg;

const AUTH_DATABASE_URL = process.env.AUTH_DATABASE_URL;

let authPool = null;

if (AUTH_DATABASE_URL) {
  authPool = new Pool({
    connectionString: AUTH_DATABASE_URL,
    min: 2,
    max: 10,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 15000,
    statement_timeout: 30000,
    ssl: AUTH_DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
  });

  authPool.on('error', (err) => {
    console.error('Auth PostgreSQL pool error:', err.message || err);
  });
} else {
  console.warn('⚠️  AUTH_DATABASE_URL not configured - auth features will be unavailable');
}

function getAuthPool() {
  if (!authPool) {
    throw new Error('Auth database pool is not configured. Please set AUTH_DATABASE_URL in your .env file.');
  }
  return authPool;
}

module.exports = {
  getAuthPool
};
