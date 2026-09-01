const { pool } = require('../services/database/postgresClient');

function getPool() {
  if (!pool) {
    throw new Error('Database not configured. Please set DATABASE_URL in your .env file.');
  }
  return pool;
}

module.exports = { getPool };
