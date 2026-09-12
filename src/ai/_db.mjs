/**
 * PostgreSQL pool for the AI Assistant engine.
 * Re-exports the shared pool from postgresClient.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { pool } = require('../services/database/postgresClient');

export { pool };
export default pool;
