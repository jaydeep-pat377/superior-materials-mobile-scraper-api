/**
 * PostgreSQL pool for the AI Assistant engine.
 *
 * Reuses the backend's existing DATABASE_URL. The AI engine talks to the
 * SAME PostgreSQL database, so stored functions (ai_aggregate,
 * ai_select_rows, ai_count, _ai_validate_columns) and tables (ai_chat_threads,
 * ai_audit_log) are all available here.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { pool } = require('../services/database/postgresClient');

if (!pool) {
  console.warn('[ai] DATABASE_URL is not set - AI data tools will fail.');
}

export { pool };
export default pool;
