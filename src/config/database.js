/**
 * Database Configuration
 *
 * Re-exports the PostgreSQL pool from postgresClient.
 * All services should use getPool() to obtain the connection pool.
 */

const { getPool } = require('../services/database/postgresClient');

module.exports = {
  getPool
};
