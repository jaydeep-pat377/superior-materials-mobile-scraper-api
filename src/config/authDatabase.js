/**
 * Auth PostgreSQL Configuration
 *
 * Direct PostgreSQL connection for the central auth database (auth_tenant schema:
 * tenants, users, tenant_users, auth_codes, login_attempts).
 *
 * AUTH_DATABASE_URL is REQUIRED. There is no fallback any more.
 */

const pg = require('pg');
const { Pool } = pg;

const RAW_AUTH_DATABASE_URL = process.env.AUTH_DATABASE_URL;
const QUERY_TIMEOUT_MS = parseInt(process.env.DB_QUERY_TIMEOUT_MS) || 30000;

// Strip any `sslmode=...` from the URL so pg-connection-string doesn't force
// verify-full; TLS is controlled by the `ssl` option below.
let AUTH_DATABASE_URL = RAW_AUTH_DATABASE_URL;
let AUTH_SSL_DISABLED = false;
if (RAW_AUTH_DATABASE_URL) {
  try {
    const u = new URL(RAW_AUTH_DATABASE_URL);
    AUTH_SSL_DISABLED = u.searchParams.get('sslmode') === 'disable';
    u.searchParams.delete('sslmode');
    AUTH_DATABASE_URL = u.toString();
  } catch (e) {
    AUTH_DATABASE_URL = RAW_AUTH_DATABASE_URL;
  }
}

let authPool = null;

if (AUTH_DATABASE_URL) {
  authPool = new Pool({
    connectionString: AUTH_DATABASE_URL,
    min: 1,
    max: 10,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 15000,
    statement_timeout: QUERY_TIMEOUT_MS,
    ssl: AUTH_SSL_DISABLED ? false : { rejectUnauthorized: false }
  });

  authPool.on('error', (err) => {
    console.error('Auth PostgreSQL pool error:', err.message || err);
  });
} else {
  console.warn('AUTH_DATABASE_URL not configured - auth tenant features will be unavailable');
}

function getAuthPool() {
  if (!authPool) {
    throw new Error('Auth database not configured. Please set AUTH_DATABASE_URL in your .env file.');
  }
  return authPool;
}

/**
 * Execute a SQL query against the auth database with retry on transient failure
 *
 * @param {string} sqlQuery - SQL with $1, $2... placeholders
 * @param {array} params - Parameter values
 * @param {object} options - { maxRetries }
 * @returns {Promise<object>} { success: true, data: rows, rowCount, command }
 */
async function executeAuthSQL(sqlQuery, params = [], options = {}) {
  const { maxRetries = 3 } = options;

  if (!authPool) {
    throw new Error('Auth PostgreSQL pool not configured. Please set AUTH_DATABASE_URL.');
  }

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await authPool.query(sqlQuery, params);
      return {
        success: true,
        data: result.rows,
        rowCount: result.rowCount,
        command: result.command
      };
    } catch (error) {
      lastError = error;

      const isTimeout = error.message.includes('timeout') ||
                        error.message.includes('canceling statement') ||
                        error.code === '57014';
      if (isTimeout) {
        console.error(`Auth SQL query timed out (attempt ${attempt}/${maxRetries})`);
        throw error;
      }

      const isNonRetryable = error.code && (
        error.code.startsWith('42') ||
        error.code.startsWith('23')
      );
      if (isNonRetryable) {
        throw error;
      }

      console.error(`Auth SQL attempt ${attempt}/${maxRetries} failed:`, error.message);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  throw lastError || new Error('Failed to execute auth SQL query after all retries');
}

/**
 * Close the auth pool gracefully
 */
async function closeAuthPool() {
  if (!authPool) return;
  try {
    await authPool.end();
    console.log('Auth PostgreSQL pool closed');
  } catch (error) {
    console.error('Error closing auth pool:', error);
  }
}

module.exports = {
  getAuthPool,
  executeAuthSQL,
  closeAuthPool
};
