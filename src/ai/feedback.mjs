/** Thumbs-up/down feedback on an AI answer (ported from /api/ai/feedback). */
import pool from './_db.mjs';

export async function recordFeedback({ auditLogId, rating, comment } = {}) {
  const id = typeof auditLogId === 'number' ? auditLogId : null;
  const r = rating === 'up' || rating === 'down' ? rating : null;
  const c = typeof comment === 'string' ? comment.slice(0, 2000) : null;
  if (id === null || r === null) {
    throw Object.assign(new Error("auditLogId (number) and rating ('up'|'down') are required"), { status: 400 });
  }
  try {
    await pool.query('SELECT ai_record_feedback($1, $2, $3)', [id, r, c]);
  } catch (err) {
    const code = err.code || '';
    throw Object.assign(new Error(err.message), { status: code === 'P0002' ? 404 : 500 });
  }
  return { success: true };
}
