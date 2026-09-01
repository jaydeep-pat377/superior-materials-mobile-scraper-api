const pg = require('pg');
const { Pool } = pg;

const NOTIFICATION_DATABASE_URL = process.env.NOTIFICATION_DATABASE_URL;

let notificationPool = null;

if (NOTIFICATION_DATABASE_URL) {
  notificationPool = new Pool({
    connectionString: NOTIFICATION_DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 15000,
    ssl: NOTIFICATION_DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
  });
  notificationPool.on('error', (err) => {
    console.error('Notification PostgreSQL pool error:', err.message || err);
  });
} else {
  console.warn('NOTIFICATION_DATABASE_URL not configured - notification features will be unavailable');
}

function getNotificationPool() {
  if (!notificationPool) {
    throw new Error('Notification database not configured. Please set NOTIFICATION_DATABASE_URL in your .env file.');
  }
  return notificationPool;
}

module.exports = { getNotificationPool };
