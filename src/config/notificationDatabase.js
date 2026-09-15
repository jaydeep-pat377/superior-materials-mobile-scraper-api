/**
 * Notification Database Configuration
 *
 * Separate PostgreSQL pool for notification operations.
 */

const pg = require('pg');
const { Pool } = pg;

const NOTIFICATION_DATABASE_URL = process.env.NOTIFICATION_DATABASE_URL;

let notificationPool = null;

if (NOTIFICATION_DATABASE_URL) {
  // Strip sslmode param (pg driver handles SSL separately)
  let connectionString = NOTIFICATION_DATABASE_URL;
  let sslDisabled = false;
  try {
    const u = new URL(NOTIFICATION_DATABASE_URL);
    sslDisabled = u.searchParams.get('sslmode') === 'disable';
    u.searchParams.delete('sslmode');
    connectionString = u.toString();
  } catch { /* use as-is */ }

  const isLocal = NOTIFICATION_DATABASE_URL.includes('localhost') || NOTIFICATION_DATABASE_URL.includes('127.0.0.1');

  notificationPool = new Pool({
    connectionString,
    min: 2,
    max: 10,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 15000,
    statement_timeout: 30000,
    ssl: (isLocal || sslDisabled) ? false : { rejectUnauthorized: false }
  });

  notificationPool.on('error', (err) => {
    console.error('Notification PostgreSQL pool error:', err.message || err);
  });
} else {
  console.warn('⚠️  NOTIFICATION_DATABASE_URL not configured - notification features will be unavailable');
}

function getNotificationPool() {
  if (!notificationPool) {
    throw new Error('Notification database pool is not configured. Please set NOTIFICATION_DATABASE_URL in your .env file.');
  }
  return notificationPool;
}

module.exports = {
  getNotificationPool
};
